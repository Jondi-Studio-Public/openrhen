import type { LinkPoolFact } from "@openrhen/communication-readers";
import type { ScanInput } from "@/server/persistence/postgres/derived-scan-store";
import type { DerivedSettings } from "./derived-settings";
import type { ModelOutcome, PolicyRequest, PolicyResult } from "./call-policy";

/**
 * The contract between the model tick (`model-runner.ts`) and a model-backed extractor (communication understanding,
 * slice 2b-4). The first extractor is `fact-llm` (`fact-llm.ts`, slice 2b-6); with none registered the runner is a
 * reported no-op.
 *
 * An extractor never opens a connection, reads a setting or picks a model: it asks `context.call(...)`, which goes
 * through the one call policy with the model this version was pinned to. It never writes: it returns rows (or a
 * failure) and the runner writes them, only if the source message is still there and unchanged and the run still
 * holds the lease. It opens no database: the message, its context and the pinned models arrive as arguments, and the few reads it may
 * need (the owner's zone, labelled-sensitive senders, a conversation's stored facts) are `lookups` the runner answers.
 */

/** One message to read. `content` is the stored text (never null here: a message with no text is not offered). */
export interface ModelSourceMessage {
  id: string;
  key: string;
  tsStart: Date;
  attrs: unknown;
  content: string;
}

/** One of the up to 3 earlier messages of the thread, oldest first. `content` is null when the row holds no text. */
export interface ModelContextMessage {
  id: string;
  key: string;
  tsStart: Date;
  attrs: unknown;
  content: string | null;
}

/** The models a version was pinned to when its state was created. Settings changes do not alter them. */
export interface PinnedModels {
  t2: { id: string; digest: string | null } | null;
  t3: { id: string } | null;
}

/** A stored fact a link could point at, with the message it was read from, so the hosted-eligibility rule can be run on THAT message. */
export interface LinkPoolEntry extends LinkPoolFact {
  source: { attrs: Record<string, unknown>; subject: string | null; content: string | null } | null;
}

/**
 * What the runner lets an extractor ask of the database without handing it one. Each answer is read on demand and kept
 * for the run, so an extractor that never asks costs nothing. They are reads only; an extractor still writes nothing.
 */
export interface ModelLookups {
  /** The owner's IANA zone, the one a message's dates are resolved in. */
  timeZone(): Promise<string>;
  /** Lower-case addresses of senders the owner labelled sensitive (his own `sensitive` labels), for the hosted-eligibility rule. */
  sensitiveSenders(): Promise<ReadonlySet<string>>;
  /** Facts already stored for a conversation, newest first and bounded, that a cancel, move or repeat could point at. */
  linkPool(conversationKey: string): Promise<LinkPoolEntry[]>;
}

/** Which reading of the batch a message came from. `reoffer` is a message whose earlier fact was left `low_signal` and is offered to the hosted tier again. */
export type ModelLane = "retry" | "forward" | "backfill" | "eval" | "reoffer";

/** A call as an extractor makes it: the tier picks the pinned model, and the event key is the message being read. */
export type ModelCallArgs = Omit<PolicyRequest, "sourceEventKey" | "model">;

export interface ModelExtractContext {
  now: Date;
  /** Where rows land: `derived` for the active version, `derived-shadow` for one not yet promoted. The runner sets `source` on every row. */
  target: "derived" | "derived-shadow";
  pinned: PinnedModels;
  lane: ModelLane;
  lookups: ModelLookups;
  call(args: ModelCallArgs): Promise<PolicyResult>;
  /** Milliseconds left in this run's model-call budget; an extractor may stop early when it is short. */
  timeLeftMs(): number;
}

export type ModelFailureOutcome = Exclude<ModelOutcome["outcome"], "ok">;

/**
 * What reading one message came to. `rows` may be empty (nothing to say). `failed` carries the call policy's outcome
 * and sentence: the runner decides what it costs (an outage costs nothing and opens the circuit; a timeout or bad
 * output uses the message's retry budget).
 */
export type ModelExtractResult =
  | {
      kind: "rows";
      rows: unknown[];
      /**
       * Named counts for the tick result (grounded, rejected quotes by reason, hosted sends and refusals, ...). Whole
       * numbers only; the runner sums them over the messages it kept and reports them beside its own counts.
       */
      stats?: Record<string, number>;
    }
  | { kind: "failed"; outcome: ModelFailureOutcome; message: string };

export interface ModelExtractor {
  name: string;
  version: string;
  /** The fixed name recorded as `ingested_via` on every row this extractor writes. */
  via: string;
  input: ScanInput;
  /**
   * Null when this extractor can start (a version is created only then), else one plain sentence naming what is
   * missing and the exact call that fixes it. Asked only while the version has no state row.
   */
  notConfigured(settings: DerivedSettings): string | null;
  /**
   * The same extractor as another version. The runner runs every version of a name the person holds (a version made by
   * saving a different model id is a state row, not a code change), each with the models it was pinned to.
   */
  forVersion?(version: string): ModelExtractor;
  /**
   * When set, the runner also offers each run a few source messages whose latest row from this extractor carries this
   * stored review reason and has no row from the hosted tier yet, newest first, with `lane: "reoffer"`.
   */
  reoffer?: { reviewReason: string };
  extract(
    message: ModelSourceMessage,
    context: readonly ModelContextMessage[],
    run: ModelExtractContext
  ): Promise<ModelExtractResult>;
}
