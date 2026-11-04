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
