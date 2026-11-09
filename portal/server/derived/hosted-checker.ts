import { hostedEligibility } from "@openrhen/communication-readers";
import { MODEL_PROVIDERS } from "@openrhen/contracts";
import {
  readModelRowsByKeys,
  readSensitiveSenders,
  readThreadContext
} from "@/server/persistence/postgres/derived-model-scan-store";
import type { ScanInput } from "@/server/persistence/postgres/derived-scan-store";
import type { Sql } from "@/server/persistence/postgres/sql-pool";
import type { HostedEligibilityChecker } from "./call-policy";
import { recipientDenials } from "./hosted-recipients";
import type { DerivedSettings } from "./derived-settings";

/**
 * The hosted-eligibility rule wired in as the call policy's checker (communication understanding, slice 2b-6). The call
 * policy asks it immediately before every hosted send, with the key of the message being read; the runner asks it for each
 * context message too, so a context message that fails is dropped from every prompt.
 *
 * It denies (nothing is sent) when: the daily caps are 0 (hosted sends are off), no hosted-provider key is saved (the call would
 * only fail), the message is no longer held or holds no text, or the rule in `communication-readers` says no for the message,
 * its thread's recent messages (a bank thread ending "Thanks, done" must not go) or a sender he labelled sensitive. A
 * hosted model that is not set is never asked at all, because the extractor does not call the hosted tier without one.
 * The reason is a sentence made of reason codes, never of mail text. The rule is the one from PR 140; it is a deny-list
 * and so reactive: the first mail from a sender nobody listed can pass.
 */
export interface HostedCheckerDeps {
  sql: Sql;
  userId: string;
  settings: Pick<DerivedSettings, "t3DailyMessageCap" | "t3DailyTokenCap">;
  /** Whether a hosted key is saved; asked at most once per check, never returns the key. */
  keySaved: () => Promise<boolean>;
  input: ScanInput;
}

/**
 * Only the rule: the message is held with text, and neither it, its recent thread (a sent message's recipients included)
 * nor a sender he labelled sensitive is refused. The runner uses this to choose the thread context a local prompt carries,
 * so a hosted tier that is switched off (a cap of 0, no key) never makes local reading worse. Every refusal is `settled`:
 * it is about this message and a retry will not change it.
 */
export function createHostedRuleCheck(
  deps: Pick<HostedCheckerDeps, "sql" | "userId" | "input">
): HostedEligibilityChecker {
  return async ({ sourceEventKey }) => {
    const [row] = await readModelRowsByKeys(deps.sql, deps.userId, deps.input, [sourceEventKey], 1);
    if (!row || row.content === null || typeof row.attrs !== "object" || row.attrs === null)
      return { eligible: false, reason: "the message is no longer held with its text", settled: true };
    const attrs = row.attrs as Record<string, unknown>;
    const thread = await readThreadContext(deps.sql, deps.userId, deps.input, row);
    const sensitive = await readSensitiveSenders(deps.sql, deps.userId);
    const context = thread.map((c) => {
      const a = typeof c.attrs === "object" && c.attrs !== null ? (c.attrs as Record<string, unknown>) : {};
      return { attrs: a, subject: typeof a.subject === "string" ? a.subject : null, content: c.content };
    });
    const verdict = hostedEligibility({
      message: { attrs, subject: typeof attrs.subject === "string" ? attrs.subject : null, content: row.content },
      context,
      sensitiveSenders: sensitive
    });
    const recipients = [attrs, ...context.map((c) => c.attrs)].flatMap((a) => recipientDenials(a, sensitive));
    if (verdict.send && recipients.length === 0) return { eligible: true };
    const codes = [...verdict.message.reasons, ...recipients];
    return {
      eligible: false,
      reason: `the hosted-eligibility rule says no (${codes.join(", ") || "thread"})`,
      settled: true
    };
  };
}

export function createHostedChecker(deps: HostedCheckerDeps): HostedEligibilityChecker {
  let key: Promise<boolean> | null = null;
  const rule = createHostedRuleCheck(deps);
  return async (subject) => {
    if (!(deps.settings.t3DailyMessageCap > 0) || !(deps.settings.t3DailyTokenCap > 0))
      return {
        eligible: false,
        reason:
          "the hosted tier is off because a daily cap is 0 (raise t3DailyMessageCap and t3DailyTokenCap with PUT /api/derived-settings, Settings > Mail understanding)"
      };
    key ??= deps.keySaved();
    if (!(await key))
      return {
        eligible: false,
        reason: `no hosted API key is saved (enter the ${MODEL_PROVIDERS.hosted.label} key under Settings > Passwords and keys)`
      };
    return rule(subject);
  };
}
