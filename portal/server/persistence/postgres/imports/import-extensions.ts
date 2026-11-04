import type { ImportRecord } from "@openrhen/contracts";
import type { Sql } from "../sql-pool";

/**
 * Registry of what a feature the OpenRhen export leaves out adds to the import commit (P4-13b, the seam rule in
 * the design notes). A batch of an extension's source type carries its own link source in
 * `import_batches.source_text`; the extension writes its records' links as the commit goes and settles its own rows
 * when the batch commits. `private/index.ts` lists every extension and registers each on import; the export excludes
 * that folder and ships an empty `private/index.ts`.
 */

/** Augmented by an extension (`interface ExtensionLinkSources { name: TheSource }`) so a link source is typed, not `unknown`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ExtensionLinkSources {}
export type ExtensionLinkSource = ExtensionLinkSources[keyof ExtensionLinkSources];

export interface ImportRecordContext {
  sql: Sql;
  userId: string;
  /** The entity id the record wrote (or joined). */
  id: string;
  type: string;
  record: ImportRecord;
  value: (name: string) => unknown;
  /** A joining source's own value for a field that differed from the plan, else the record's value. */
  remoteOr: (record: ImportRecord, value: (name: string) => unknown, name: string) => unknown;
  linkSource: unknown;
}

export interface ImportCommitContext {
  userId: string;
  linkSource: unknown;
  records: ImportRecord[];
  ready: ImportRecord[];
  deferred: ImportRecord[];
  committedBatchId: string;
  deferredBatchId: string | null;
}

export interface ImportExtension {
  /** Stable name; registering the same id twice is a no-op. Keys `extensionOutcomes` of a commit. */
  id: string;
  /** Source types whose batch `source_text` is this extension's link source (JSON). */
  sourceTypes: readonly string[];
  /** Before a record is written (after its parents): for work that must see the rows as they were. */
  beforeRecord?(context: ImportRecordContext): Promise<void>;
  /** After a record's entity is written: links it back to the source. */
  afterRecord?(context: ImportRecordContext): Promise<void>;
  /** Inside the commit transaction, once the batch is marked committed. Returns what the caller reads from `extensionOutcomes`. */
  afterCommit?(tx: Sql, context: ImportCommitContext): Promise<unknown>;
  /** Labels a source in a sentence ("the sender"). */
  sentenceLabels?: Record<string, string>;
  /**
   * For a series `link` record: the events of the batch's own source that make up the series, the frame they were read
   * from and how the link names them, or null when the record is not one of this source's series.
   */
  seriesSource?(
    record: ImportRecord,
    linkSource: unknown
  ): {
    events: { title: string; startsAt: string; endsAt: string; location: string | null; seriesId: string | null }[];
    frameId: string;
    profileLabel: string;
    sourceCalendarId: string | null;
  } | null;
  /** The `import_entity_keys` key a link of this provider's event was written under, or null. */
  linkImportKey?(provider: string, frameId: string, externalEventId: string): string | null;
}

const extensions = new Map<string, ImportExtension>();

export function registerImportExtension(extension: ImportExtension): void {
  if (!extensions.has(extension.id)) extensions.set(extension.id, extension);
}

export function importExtensions(): readonly ImportExtension[] {
  return [...extensions.values()];
}

export function isExtensionSourceType(sourceType: string): boolean {
  return importExtensions().some((extension) => extension.sourceTypes.includes(sourceType));
}

/** The extension that owns a link source, found by the provider it names. */
export function extensionOfLinkSource(linkSource: unknown): ImportExtension | undefined {
  const provider = (linkSource as { provider?: string } | undefined)?.provider;
  return provider === undefined ? undefined : importExtensions().find((e) => e.sourceTypes.includes(provider));
}

/** The sentence form of a provider's label, when an extension gives one. */
export function extensionSentenceLabel(provider: string): string | undefined {
  for (const extension of extensions.values())
    if (extension.sentenceLabels && Object.hasOwn(extension.sentenceLabels, provider))
      return extension.sentenceLabels[provider];
  return undefined;
}

/** The import key an extension gives a link of its provider's event. */
export function extensionLinkImportKey(provider: string, frameId: string, externalEventId: string): string | null {
  for (const extension of extensions.values()) {
    if (!extension.sourceTypes.includes(provider)) continue;
    const key = extension.linkImportKey?.(provider, frameId, externalEventId);
    if (key !== undefined) return key;
  }
  return null;
}

/** The `sources.source_type` an extension's provider writes: the provider's own id. */
export function extensionSourceTypeOf(provider: string): string | undefined {
  return isExtensionSourceType(provider) ? provider : undefined;
}
