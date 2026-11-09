import type { ScanInput } from "@/server/persistence/postgres/derived-scan-store";
import type { DerivedSettings } from "./derived-settings";
import type { ModelOutcome, PolicyRequest, PolicyResult } from "./call-policy";

/**
 * The contract between the model tick (`model-runner.ts`) and a model-backed extractor (communication understanding,
 * slice 2b-4). The actual extractor, `fact-llm`, is slice 2b-6; this slice ships the runner and a registry that holds
 * none, so the runner is a reported no-op until one is registered.
 *
 * An extractor never opens a connection, reads a setting or picks a model: it asks `context.call(...)`, which goes
 * through the one call policy with the model this version was pinned to. It never writes: it returns rows (or a
 * failure) and the runner writes them, only if the source message is still there and unchanged and the run still
 * holds the lease. It reads no database: the message, its context and the pinned models arrive as arguments.
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

/** A call as an extractor makes it: the tier picks the pinned model, and the event key is the message being read. */
export type ModelCallArgs = Omit<PolicyRequest, "sourceEventKey" | "model">;

export interface ModelExtractContext {
  now: Date;
  /** Where rows land: `derived` for the active version, `derived-shadow` for one not yet promoted. The runner sets `source` on every row. */
  target: "derived" | "derived-shadow";
  pinned: PinnedModels;
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
  { kind: "rows"; rows: unknown[] } | { kind: "failed"; outcome: ModelFailureOutcome; message: string };

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
  extract(
    message: ModelSourceMessage,
    context: readonly ModelContextMessage[],
    run: ModelExtractContext
  ): Promise<ModelExtractResult>;
}
