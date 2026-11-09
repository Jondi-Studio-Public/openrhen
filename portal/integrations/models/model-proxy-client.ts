import { MODEL_PROVIDERS, type ModelProviderDescriptor } from "@openrhen/contracts";
import { callCapability, ConnectionHostNotConfiguredError } from "@/integrations/connection-host-client";
import type { ModelOutcome, ModelRequest, ModelTransport, Tier } from "@/server/derived/call-policy";
import type { Sql } from "@/server/persistence/postgres/sql-pool";
import { readSecret } from "@/server/secrets/read-secret";

/**
 * The one place the saved hosted-provider key is read and used: the proxy-call helper for `model_provider.complete`. The
 * key goes in the body of one call to the outbound proxy (which puts it in an Authorization header) and is never
 * returned, logged or kept; this is the only file besides the YouTube client allowed to import `readSecret`
 * (`scripts/repository/secret-reader-rule.mjs`). The local tier needs no key: the saved address goes in the body and
 * the proxy checks it before connecting. Which connection answers each tier, which secret the hosted one needs and
 * which body fields it takes come from the provider descriptors (`providers`), so this file names no provider.
 */

const OUTCOMES = ["unreachable", "timeout", "bad_output", "rate_limited", "bad_key"] as const;
const LOCAL_WAIT_MS = 200_000;
const HOSTED_WAIT_MS = 70_000;
const SETTINGS_HINT = "Settings > Mail understanding";

export interface ModelTransportDeps {
  sql: Sql;
  userId: string;
  /** The saved address of the local model (the settings field `ollamaUrl`). */
  localAddress: string | null;
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  /** The connection descriptor for each tier; the portal's own defaults when omitted. */
  providers?: { local: ModelProviderDescriptor; hosted: ModelProviderDescriptor };
}

const failure = (outcome: (typeof OUTCOMES)[number], message: string): ModelOutcome => ({ outcome, message });

function interpret(status: number, body: unknown): ModelOutcome {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (record.outcome === "ok" && typeof record.text === "string")
    return {
      outcome: "ok",
      text: record.text,
      model: typeof record.model === "string" ? record.model : "",
      tokensIn: typeof record.tokensIn === "number" ? record.tokensIn : null,
      tokensOut: typeof record.tokensOut === "number" ? record.tokensOut : null,
      ...("digest" in record ? { digest: typeof record.digest === "string" ? record.digest : null } : {})
    };
  const named = OUTCOMES.find((outcome) => outcome === record.outcome);
  if (named && typeof record.message === "string") return failure(named, record.message);
  if (status === 400 && typeof record.error === "string") return failure("bad_output", record.error);
  if (status === 429) return failure("rate_limited", "The model service is busy. Try again later.");
  return failure(
    "unreachable",
    "The outbound proxy gave an answer this app does not understand, or is not ready. Check that the outbound-proxy container is running (docker compose ps)."
  );
}

export function createModelTransport(deps: ModelTransportDeps): ModelTransport {
  const { sql, userId, env, fetcher } = deps;
  const providers = deps.providers ?? MODEL_PROVIDERS;
  const call = async (connectionId: string, body: Record<string, unknown>, timeoutMs: number) => {
    try {
      const result = await callCapability({
        connectionId,
        capability: "model_provider",
        op: "complete",
        body,
        timeoutMs,
        ...(env ? { env } : {}),
        ...(fetcher ? { fetcher } : {})
      });
      return interpret(result.status, result.body);
    } catch (error) {
      if (error instanceof ConnectionHostNotConfiguredError)
        return failure(
          "unreachable",
          "The outbound proxy is not set up (OUTBOUND_PROXY_URL and OUTBOUND_PROXY_TOKEN)."
        );
      // The thrown error is dropped on purpose; only the fact that the proxy could not be reached is kept.
      return failure("unreachable", "The outbound proxy could not be reached. Check that its container is running.");
    }
  };
  return {
    async complete(tier: Tier, request: ModelRequest): Promise<ModelOutcome> {
      if (tier === "t2") {
        const local = providers.local;
        if (!deps.localAddress)
          return failure("unreachable", `No address is saved for the local model. Enter it in ${SETTINGS_HINT}.`);
        const address = local.body.addressField ? { [local.body.addressField]: deps.localAddress } : {};
        return call(
          local.connectionId,
          { ...request, ...address, ...local.body.fixed, withDigest: request.withDigest === true },
          LOCAL_WAIT_MS
        );
      }
      const hosted = providers.hosted;
      if (!hosted.secretName) return call(hosted.connectionId, { ...request, ...hosted.body.fixed }, HOSTED_WAIT_MS);
      const key = await readSecret(sql, userId, hosted.secretName, env);
      if (key.kind !== "ok")
        return failure(
          "bad_key",
          key.kind === "unset"
            ? `No ${hosted.label} key is saved. Enter it under Settings > Passwords and keys.`
            : `The saved ${hosted.label} key can no longer be opened. Enter it again under Settings > Passwords and keys.`
        );
      const secret = hosted.body.keyField ? { [hosted.body.keyField]: key.value } : {};
      return call(hosted.connectionId, { ...request, ...secret, ...hosted.body.fixed }, HOSTED_WAIT_MS);
    }
  };
}
