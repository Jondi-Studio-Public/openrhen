/**
 * The size and cost of reading the whole mail history with a model, for the go/no-go on the next slice. Pure
 * arithmetic over numbers the caller measured (messages held, tokens and seconds per message from a timed sample).
 * Messages that headers alone resolve (tier t0) need no model call, so `t0Share` takes them out.
 */

export interface BackfillInput {
  /** Messages in the history to read. */
  messages: number;
  /** Tokens one model call uses, input plus output. */
  tokensPerMessage: number;
  /** Seconds one message takes, end to end. */
  secondsPerMessage: number;
  /** Fraction of messages resolved by headers alone (0 to 1); default 0. */
  t0Share?: number | undefined;
  /** Calls in flight at once; divides the wall-clock time, not the tokens. Default 1. */
  parallelism?: number | undefined;
  /** Price per million tokens, when the cost is wanted. Left out gives `usd: null`. */
  usdPerMillionTokens?: number | undefined;
}

export interface BackfillEstimate {
  messages: number;
  /** Messages that need a model call: ceil(messages x (1 - t0Share)). */
  modelMessages: number;
  totalTokens: number;
  totalSeconds: number;
  totalHours: number;
  usd: number | null;
}

/** The largest value each input takes, so a typo (an extra zero, milliseconds for seconds) is refused, not multiplied. */
export const BACKFILL_LIMITS = {
  messages: 1_000_000_000,
  tokensPerMessage: 1_000_000,
  secondsPerMessage: 3600,
  usdPerMillionTokens: 1000,
  parallelism: 1000
} as const;

function nonNegative(name: keyof typeof BACKFILL_LIMITS, value: number | undefined, whole: boolean): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || (whole && !Number.isInteger(value)))
    throw new Error(
      `${name} ${value} is not ${whole ? "a whole number" : "a number"} of 0 or more. Pass the measured ${name}, not a rate or text.`
    );
  if (value > BACKFILL_LIMITS[name])
    throw new Error(
      `${name} ${value} is more than the limit: ${name} is at most ${BACKFILL_LIMITS[name]}. Check the unit (tokens, seconds, whole dollars per million tokens) and pass the measured value.`
    );
}

export function estimateBackfill(input: BackfillInput): BackfillEstimate {
  nonNegative("messages", input.messages, true);
  nonNegative("tokensPerMessage", input.tokensPerMessage, false);
  nonNegative("secondsPerMessage", input.secondsPerMessage, false);
  nonNegative("usdPerMillionTokens", input.usdPerMillionTokens, false);
  const share = input.t0Share ?? 0;
  if (!Number.isFinite(share) || share < 0 || share > 1)
    throw new Error(
      `t0Share ${share} is outside 0 to 1. Pass the fraction of messages headers alone resolve, such as 0.6.`
    );
  const parallelism = input.parallelism ?? 1;
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > BACKFILL_LIMITS.parallelism)
    throw new Error(
      `parallelism ${parallelism} is not a whole number from 1 to ${BACKFILL_LIMITS.parallelism}: parallelism is at most ${BACKFILL_LIMITS.parallelism}. Pass how many calls run at once, or leave it out for 1.`
    );
  // The small allowance keeps 1000 x 0.4 from rounding up to 401 on floating-point noise.
  const modelMessages = Math.max(0, Math.ceil(input.messages * (1 - share) - 1e-9));
  const totalTokens = modelMessages * input.tokensPerMessage;
  const totalSeconds = (modelMessages * input.secondsPerMessage) / parallelism;
  return {
    messages: input.messages,
    modelMessages,
    totalTokens,
    totalSeconds,
    totalHours: totalSeconds / 3600,
    usd: input.usdPerMillionTokens === undefined ? null : (totalTokens / 1_000_000) * input.usdPerMillionTokens
  };
}
