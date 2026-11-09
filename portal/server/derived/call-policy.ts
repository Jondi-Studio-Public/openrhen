import type { ModelProviderDescriptor } from "@openrhen/contracts";

/**
 * The one place a model is called for mail understanding (communication understanding, slice 2b-3b). Every extractor
 * that needs a language model goes through `callModel`, so the rules below cannot be skipped by one caller:
 *
 * - Local tier (`t2`, the owner's own machine): one call at a time; the model is warmed with a tiny call first (a model
 *   still loading can take minutes, and the real call should not pay for that); a timeout is retried twice after a
 *   growing wait; bad output (or output the caller's `validate` refuses) gets one repair retry.
 * - Hosted tier (`t3`, the hosted provider): the hosted-eligibility rule is asked at this call, immediately before sending,
 *   through an injected checker (the rule itself lives with the communication readers); the daily message and token
 *   caps are checked before every attempt; every attempt that leaves the machine writes one audit row
 *   (the event key, model and token counts, never content). Models the hosted provider's descriptor lists
 *   as refused (makers whose own retention or training policy applies there) are never sent mail. The provider's name,
 *   its refused makers and its wording come from the injected descriptor (`PolicyDeps.hosted`), not from this file.
 *
 * Nothing here logs message text. A transport failure carries the proxy's own sentence, which never quotes the prompt.
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type Tier = "t2" | "t3";

/** What the outbound proxy's `model_provider.complete` answers, as the portal sees it. */
export type ModelOutcome =
  | {
      outcome: "ok";
      text: string;
      model: string;
      tokensIn: number | null;
      tokensOut: number | null;
      /** The digest of the local model, only when the request asked for it (`withDigest`). */
      digest?: string | null;
    }
  | {
      outcome: "unreachable" | "timeout" | "bad_output" | "rate_limited" | "bad_key";
      message: string;
    };

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  format?: "json" | Record<string, unknown>;
  /** Local tier only: ask the proxy to read the model digest and return it with the reply. */
  withDigest?: boolean;
}

export interface ModelTransport {
  complete(tier: Tier, request: ModelRequest): Promise<ModelOutcome>;
}

export interface PolicyRequest {
  tier: Tier;
  /** The activity event the call is about (audit only). */
  sourceEventKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  format?: "json" | Record<string, unknown>;
  /** Local tier only: also read the model digest (used by the model tick's pin check). */
  withDigest?: boolean;
  /** Returns a sentence naming what is wrong with the reply, or null when it is acceptable. */
  validate?: (text: string) => string | null;
}

/**
 * The narrow interface the hosted-eligibility rule is reached through. The rule (every message put in the prompt is
 * `msg_class: person`, no auth failure, no one-time code, no banking word or sender, no sender labelled sensitive) is
 * implemented with the communication readers; this slice only calls it, at the call site, with the event key.
 */
export type HostedEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason: string;
      /**
       * True when the refusal is a verdict about THIS message (the rule says no, the text is gone), which will not change
       * on a retry; absent for a setting (a cap of 0, no key saved) that the owner can change.
       */
      settled?: boolean;
    };
export type HostedEligibilityChecker = (subject: {
  sourceEventKey: string;
  model: string;
}) => Promise<HostedEligibility>;

export interface ModelCallRow {
  sourceEventKey: string;
  tier: Tier;
  model: string;
  tokensIn: number;
  tokensOut: number;
  reason: string;
}

export interface PolicyState {
  warmed: Set<string>;
  localQueue: Promise<unknown>;
}
export const createPolicyState = (): PolicyState => ({ warmed: new Set(), localQueue: Promise.resolve() });
/** The process-wide state the real call site uses. */
export const processPolicyState = createPolicyState();

export interface PolicyDeps {
  transport: ModelTransport;
  /** The hosted provider's descriptor: the retention rule and wording are its, not this file's. */
  hosted: ModelProviderDescriptor;
  settings: { t3DailyMessageCap: number; t3DailyTokenCap: number };
  /** Hosted sends and tokens in the last 24 hours. */
  usage: () => Promise<{ messages: number; tokens: number }>;
  recordCall: (row: ModelCallRow) => Promise<void>;
  isHostedEligible: HostedEligibilityChecker;
  sleep: (ms: number) => Promise<void>;
  state: PolicyState;
}

export type PolicyResult =
  | {
      kind: "ok";
      text: string;
      model: string;
      tier: Tier;
      tokensIn: number | null;
      tokensOut: number | null;
      /** The model digest when the request asked for it and the host reported one. */
      digest?: string | null;
      attempts: number;
      /** Tokens (in plus out) of EVERY attempt, repairs and a warm-up included; a failed attempt counts its prompt's estimate. */
      tokens: number;
    }
  | {
      kind: "refused";
      reason: "not_eligible" | "message_cap" | "token_cap" | "model_retention";
      message: string;
      /** For `not_eligible`: the checker said the refusal is about this message, not a setting (see `HostedEligibility`). */
      settled?: boolean;
    }
  | {
      kind: "failed";
      outcome: Exclude<ModelOutcome["outcome"], "ok">;
      message: string;
      attempts: number;
      /** As on `ok`: the tokens every attempt used. */
      tokens: number;
    };

/** Waits before the first and second retry of a timeout. */
export const TIMEOUT_BACKOFF_MS = [5_000, 20_000] as const;
export const DEFAULT_MAX_TOKENS = 1_024;
export const DEFAULT_TEMPERATURE = 0;

/** About four characters a token; used only when the provider did not say, and to check a cap before sending. */
export const estimateTokens = (messages: readonly ChatMessage[]): number =>
  Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4);

/** A sentence when the hosted provider's descriptor says its model may not carry mail, else null. */
export function hostedModelRefusal(provider: ModelProviderDescriptor, model: string): string | null {
  const org = model.split("/")[0]?.toLowerCase() ?? "";
  const shown = provider.refusedOrgs?.[org];
  if (shown === undefined) return null;
  return (
    provider.refusalMessage?.(model, shown) ??
    `"${model}" is a ${shown} model, and ${provider.label} says that company's own storage and training policy applies to it, so mail is not sent to it. Pick another model in Settings > Mail understanding.`
  );
}

const WARM_UP: ChatMessage[] = [{ role: "user", content: "Reply with the single word OK." }];

/** Runs `work` after every earlier local call has finished, whatever their outcome. */
function inLine<T>(state: PolicyState, work: () => Promise<T>): Promise<T> {
  const run = state.localQueue.then(work, work);
  state.localQueue = run.catch(() => undefined);
  return run;
}

function repairMessages(messages: ChatMessage[], format: PolicyRequest["format"], problem: string): ChatMessage[] {
  const wantsJson = format !== undefined;
  return [
    ...messages,
    {
      role: "user",
      content: wantsJson
        ? `Your previous reply could not be used (${problem}). Reply again with only the JSON object, with no other text.`
        : `Your previous reply could not be used (${problem}). Reply again, following the instructions exactly.`
    }
  ];
}

export async function callModel(deps: PolicyDeps, request: PolicyRequest): Promise<PolicyResult> {
  const base: ModelRequest = {
    model: request.model,
    messages: request.messages,
    maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: request.temperature ?? DEFAULT_TEMPERATURE,
    ...(request.format === undefined ? {} : { format: request.format }),
    ...(request.withDigest ? { withDigest: true } : {})
  };
  if (request.tier === "t2") return inLine(deps.state, () => runLocal(deps, request, base));
  return runHosted(deps, request, base);
}

/** Sends with the timeout and repair rules; `beforeSend` may refuse an attempt, `afterSend` sees every attempt's outcome. */
async function attempts(
  deps: PolicyDeps,
  request: PolicyRequest,
  base: ModelRequest,
  hooks: {
    beforeSend?: (messages: ChatMessage[]) => Promise<PolicyResult | null>;
    afterSend?: (outcome: ModelOutcome, messages: ChatMessage[], reason: string) => Promise<void>;
  }
): Promise<PolicyResult> {
  let messages = base.messages;
  let timeouts = 0;
  let repaired = false;
  let sent = 0;
  let spent = 0;
  for (;;) {
    const refusal = await hooks.beforeSend?.(messages);
    if (refusal) return refusal;
    const outcome = await deps.transport.complete(request.tier, { ...base, messages });
    sent += 1;
    spent +=
      outcome.outcome === "ok"
        ? (outcome.tokensIn ?? estimateTokens(messages)) + (outcome.tokensOut ?? 0)
        : estimateTokens(messages);
    let verdict: string | null = null;
    let reason: string = outcome.outcome;
    if (outcome.outcome === "ok") {
      verdict = request.validate?.(outcome.text) ?? null;
      if (verdict !== null) reason = "bad_output";
    }
    await hooks.afterSend?.(outcome, messages, reason);
    if (outcome.outcome === "ok" && verdict === null)
      return {
        kind: "ok",
        text: outcome.text,
        model: outcome.model,
        tier: request.tier,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        ...(outcome.digest === undefined ? {} : { digest: outcome.digest }),
        attempts: sent,
        tokens: spent
      };
    if (outcome.outcome === "timeout" && timeouts < TIMEOUT_BACKOFF_MS.length) {
      await deps.sleep(TIMEOUT_BACKOFF_MS[timeouts]!);
      timeouts += 1;
      continue;
    }
    if (reason === "bad_output" && !repaired) {
      repaired = true;
      const problem = verdict ?? "it was not valid JSON";
      messages = repairMessages(base.messages, request.format, problem);
      continue;
    }
    if (outcome.outcome === "ok")
      return {
        kind: "failed",
        outcome: "bad_output",
        message: `The model's reply was refused twice (${verdict}). Nothing was kept.`,
        attempts: sent,
        tokens: spent
      };
    return { kind: "failed", outcome: outcome.outcome, message: outcome.message, attempts: sent, tokens: spent };
  }
}

async function runLocal(deps: PolicyDeps, request: PolicyRequest, base: ModelRequest): Promise<PolicyResult> {
  const key = request.model;
  let warmTokens = 0;
  if (!deps.state.warmed.has(key)) {
    const { validate: _unused, ...unchecked } = request;
    const warm = await attempts(
      deps,
      unchecked,
      { model: request.model, messages: WARM_UP, maxTokens: 8, temperature: 0 },
      {}
    );
    // A warm-up reply is whatever the model says; only a transport failure matters (validate is not applied to it).
    if (warm.kind === "failed" && warm.outcome !== "bad_output") return warm;
    if (warm.kind !== "refused") warmTokens = warm.tokens;
    deps.state.warmed.add(key);
  }
  const real = await attempts(deps, request, base, {});
  return real.kind === "refused" ? real : { ...real, tokens: real.tokens + warmTokens };
}

async function runHosted(deps: PolicyDeps, request: PolicyRequest, base: ModelRequest): Promise<PolicyResult> {
  const retention = hostedModelRefusal(deps.hosted, request.model);
  if (retention) return { kind: "refused", reason: "model_retention", message: retention };
  const eligibility = await deps.isHostedEligible({ sourceEventKey: request.sourceEventKey, model: request.model });
  if (!eligibility.eligible)
    return {
      kind: "refused",
      reason: "not_eligible",
      message: `This message is not sent to the hosted model: ${eligibility.reason}.`,
      ...(eligibility.settled === true ? { settled: true } : {})
    };
  return attempts(deps, request, base, {
    async beforeSend(messages) {
      const { t3DailyMessageCap, t3DailyTokenCap } = deps.settings;
      const used = await deps.usage();
      if (!(used.messages + 1 <= t3DailyMessageCap))
        return {
          kind: "refused",
          reason: "message_cap",
          message: `The hosted model's daily limit of ${t3DailyMessageCap} messages is reached (${used.messages} sent in the last 24 hours). Raise it in Settings > Mail understanding, or wait.`
        };
      const needed = estimateTokens(messages) + base.maxTokens;
      if (!(used.tokens + needed <= t3DailyTokenCap))
        return {
          kind: "refused",
          reason: "token_cap",
          message: `The hosted model's daily limit of ${t3DailyTokenCap} tokens would be passed (${used.tokens} used in the last 24 hours, about ${needed} needed). Raise it in Settings > Mail understanding, or wait.`
        };
      return null;
    },
    async afterSend(outcome, messages, reason) {
      await deps.recordCall({
        sourceEventKey: request.sourceEventKey,
        tier: "t3",
        model: request.model,
        tokensIn: outcome.outcome === "ok" ? (outcome.tokensIn ?? estimateTokens(messages)) : estimateTokens(messages),
        tokensOut: outcome.outcome === "ok" ? (outcome.tokensOut ?? 0) : 0,
        reason
      });
    }
  });
}
