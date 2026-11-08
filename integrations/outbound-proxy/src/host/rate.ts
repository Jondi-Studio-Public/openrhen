import { envInt } from "./http.js";

/** Per-process cap on the two paid OpenAI routes, so a runaway caller cannot burn the key. */
const aiRateLimitPerMinute = () => envInt("OUTBOUND_AI_RATE_LIMIT_PER_MINUTE", 30);
const aiCallTimes: number[] = [];

/** True when this call fits the sliding one-minute window (and records it). */
export function takeAiRateSlot(now = Date.now()): boolean {
  while (aiCallTimes.length && aiCallTimes[0]! <= now - 60_000) aiCallTimes.shift();
  if (aiCallTimes.length >= aiRateLimitPerMinute()) return false;
  aiCallTimes.push(now);
  return true;
}

export function resetAiRateLimitForTests() {
  aiCallTimes.length = 0;
  embeddingCallTimes.length = 0;
  localCallTimes.length = 0;
  hostedCallTimes.length = 0;
}

/**
 * A separate, wider cap for embeddings: every plan search embeds its query, so an agent working
 * through a list can search often, and one embedding call costs a tiny fraction of a chat call.
 */
const embeddingRateLimitPerMinute = () => envInt("OUTBOUND_EMBEDDING_RATE_LIMIT_PER_MINUTE", 240);
const embeddingCallTimes: number[] = [];

export function takeEmbeddingRateSlot(now = Date.now()): boolean {
  while (embeddingCallTimes.length && embeddingCallTimes[0]! <= now - 60_000) embeddingCallTimes.shift();
  if (embeddingCallTimes.length >= embeddingRateLimitPerMinute()) return false;
  embeddingCallTimes.push(now);
  return true;
}

/** Models on the person's own machine: no spend, but a loop must not hammer a laptop. The calling policy (concurrency 1) is the portal's. */
const localRateLimitPerMinute = () => envInt("OUTBOUND_LOCAL_RATE_LIMIT_PER_MINUTE", 120);
const localCallTimes: number[] = [];

export function takeLocalRateSlot(now = Date.now()): boolean {
  while (localCallTimes.length && localCallTimes[0]! <= now - 60_000) localCallTimes.shift();
  if (localCallTimes.length >= localRateLimitPerMinute()) return false;
  localCallTimes.push(now);
  return true;
}

/** Hosted completions (DeepInfra with the person's key): separate from `ai`, so mail understanding cannot starve chat. The daily caps are the portal's. */
const hostedRateLimitPerMinute = () => envInt("OUTBOUND_HOSTED_RATE_LIMIT_PER_MINUTE", 60);
const hostedCallTimes: number[] = [];

export function takeHostedRateSlot(now = Date.now()): boolean {
  while (hostedCallTimes.length && hostedCallTimes[0]! <= now - 60_000) hostedCallTimes.shift();
  if (hostedCallTimes.length >= hostedRateLimitPerMinute()) return false;
  hostedCallTimes.push(now);
  return true;
}
