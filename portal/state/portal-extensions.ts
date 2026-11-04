import { useMemo, type ComponentType, type ReactNode } from "react";
import type { ImportRecord } from "@openrhen/contracts";
import type { RoomId } from "@/features/inbox/rooms";
import type { CaptureItem, PortalState } from "@/state/portal-state";
import type { QueueEntry } from "@/features/inbox/queue";
import type { Exit } from "@/features/inbox/use-inbox-decisions";

/**
 * Registry of what a feature the OpenRhen export leaves out adds to the portal's client (P4-13c, the seam rule in
 * the design notes): a slice of provider state polled on the same triggers as the check-in, rows in the
 * Inbox queue, a banner on Now, and the words and fields the import review shows for its own records.
 * `state/private/index.ts` registers each extension on import; the export excludes that folder and ships an empty
 * `index.ts`, so every lookup below answers "nothing" and the portal renders as it did without the feature.
 */

export interface PortalExtensionHost {
  ready: boolean;
  loadError: string;
  reloadState: () => Promise<unknown>;
  /** The status tick, in milliseconds: the per-minute fold of a check is measured in it. */
  tickMs: number;
  /** A snapshot replay is showing: nothing is read over it. */
  replaying: () => boolean;
}

export interface PortalExtensionSlice {
  /** Offered to consumers as `usePortal().extensions[id]`. */
  value: unknown;
  /** Asked on every tick, live event, reconnect and visibility change; `force` skips the per-minute fold. */
  check: (options?: { force?: boolean }) => void;
}

/** A row the extension adds to the Inbox queue (the queue gives it the `extension` kind). */
export interface ExtensionQueueRow {
  key: string;
  room: RoomId;
  title: string;
  meta: string;
  tag: { label: string; tone: "neutral" | "info" | "warn" };
  waiting: boolean;
  data: unknown;
}

export interface ImportRecordNoticeProps {
  record: ImportRecord;
  weekday: string | null | undefined;
  readingZone: string;
  acceptOverlap: (id: string) => void;
  toggleRemoved: (id: string) => void;
}

/** The Emails room's counts: threads queued for reading, and threads with changes to review. */
export interface EmailReviewCount {
  waiting: number;
  toReview: number;
}

export interface MailCardProps {
  /** For the Inbox's detail pane, which already shows the subject as its heading. */
  headless?: boolean;
  items: CaptureItem[];
  /** What `contextFrom` returned for the current portal state. */
  context: unknown;
  /** Confirms one change with its answers; rejects with the reason it was refused. */
  onConfirm: (item: CaptureItem, answers: Record<string, string>) => Promise<void>;
  /** Ignores these changes together: one decision, so one toast and one Undo. */
  onIgnore: (ids: string[]) => void | Promise<void>;
  /** Changes on their way out of the Inbox, and which way they leave. */
  leaving?: ReadonlyMap<string, Exit>;
}

/**
 * An `inbox_source`: a mail provider whose reasoned threads the Emails room lists, one card per
 * thread, each change confirmed or ignored on its own. Core knows only this shape; the provider's own reading of a
 * change (its fields, questions and words) stays behind `claims`, `entry` and `Card`.
 */
export interface MailSource {
  /** A pending `email_change` proposal this source wrote, which the Emails room owns. */
  claims: (item: CaptureItem) => boolean;
  /** Whether a superseded proposal came from this source (listed under Replaced). */
  ownsProposal: (item: CaptureItem) => boolean;
  /** What the cards read from portal state (the plan's names for the things a change points at). */
  contextFrom: (state: PortalState) => unknown;
  /** The queue row for one thread's changes. */
  entry: (items: CaptureItem[], context: unknown, now: Date) => Extract<QueueEntry, { kind: "email" }>;
  Card: ComponentType<MailCardProps>;
  /** The GET route of the Emails room's counts (`{ waiting, toReview }`). */
  reviewCountUrl: string;
}

export interface PortalExtension {
  id: string;
  /** The mail provider the Emails room reads. */
  mail?: MailSource;
  /** Read once per provider render, in registration order, so it may call hooks. */
  useSlice?: (host: PortalExtensionHost) => PortalExtensionSlice;
  /** Live-event kinds (beyond `state`) after which the client reloads state. */
  reloadKinds?: readonly string[];
  queueRows?: (value: unknown) => ExtensionQueueRow[];
  /** Rows in the Inbox's "people" room that still wait on the person. */
  unreadRows?: (value: unknown) => number;
  renderQueueRow?: (row: ExtensionQueueRow) => ReactNode;
  /** The page-level banner Now shows. */
  Banner?: ComponentType;
  /** Who a capture came from, read off its proposed fields. */
  captureSender?: (fields: Record<string, unknown> | undefined) => string | undefined;
  /** Source types whose captures cannot be put back once ignored. */
  notRestorableSourceTypes?: readonly string[];
  /** The lead of a commitment's provenance line for a source type ("Added by Mum from ..."), else undefined. */
  provenanceLabel?: (sourceType: string, title: string | undefined) => string | undefined;
  /** A row on the You page's phone list, after Records. */
  YouPhoneRow?: ComponentType;
  /** A section on the You page's desk column, after Data check. */
  YouSection?: ComponentType;
  /** A notice an import record of this extension shows under its errors (a held overlap, say). */
  RecordNotice?: ComponentType<ImportRecordNoticeProps>;
}

const extensions: PortalExtension[] = [];

export function registerPortalExtension(extension: PortalExtension): void {
  if (!extensions.some((existing) => existing.id === extension.id)) extensions.push(extension);
}

export function portalExtensions(): readonly PortalExtension[] {
  return extensions;
}

/** The registered mail provider, or undefined when none is installed (the Emails room then lists nothing). */
export function mailSource(): MailSource | undefined {
  return extensions.find((extension) => extension.mail)?.mail;
}

/**
 * Runs every registered slice hook. The list is fixed once the module graph has loaded, so the hooks run in the
 * same order on every render.
 */
export function usePortalExtensionSlices(host: PortalExtensionHost): {
  values: Record<string, unknown>;
  check: (options?: { force?: boolean }) => void;
} {
  const slices = extensions.map((extension) => ({ id: extension.id, slice: extension.useSlice?.(host) }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const values = useMemo(
    () => Object.fromEntries(slices.flatMap(({ id, slice }) => (slice ? [[id, slice.value]] : []))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    slices.map(({ slice }) => slice?.value)
  );
  return {
    values,
    check: (options) => {
      for (const { slice } of slices) slice?.check(options);
    }
  };
}

export function extensionReloadsState(kinds: ReadonlySet<string>): boolean {
  return extensions.some((extension) => extension.reloadKinds?.some((kind) => kinds.has(kind)));
}

export function extensionQueueRows(
  values: Record<string, unknown>
): Array<ExtensionQueueRow & { extensionId: string }> {
  return extensions.flatMap((extension) =>
    (extension.queueRows?.(values[extension.id]) ?? []).map((row) => ({ ...row, extensionId: extension.id }))
  );
}

export function extensionUnreadRows(values: Record<string, unknown>): number {
  return extensions.reduce((sum, extension) => sum + (extension.unreadRows?.(values[extension.id]) ?? 0), 0);
}

export function renderExtensionQueueRow(extensionId: string, row: ExtensionQueueRow): ReactNode {
  return extensions.find((extension) => extension.id === extensionId)?.renderQueueRow?.(row) ?? null;
}

export function extensionBanners(): ComponentType[] {
  return extensions.flatMap((extension) => (extension.Banner ? [extension.Banner] : []));
}

export function extensionCaptureSender(fields: Record<string, unknown> | undefined): string | undefined {
  for (const extension of extensions) {
    const sender = extension.captureSender?.(fields);
    if (sender) return sender;
  }
  return undefined;
}

export function isNotRestorableSourceType(sourceType: string): boolean {
  return extensions.some((extension) => extension.notRestorableSourceTypes?.includes(sourceType));
}

export function extensionProvenanceLabel(sourceType: string, title: string | undefined): string | undefined {
  for (const extension of extensions) {
    const label = extension.provenanceLabel?.(sourceType, title);
    if (label) return label;
  }
  return undefined;
}

export function extensionRecordNotices(): ComponentType<ImportRecordNoticeProps>[] {
  return extensions.flatMap((extension) => (extension.RecordNotice ? [extension.RecordNotice] : []));
}

export function extensionYouPhoneRows(): ComponentType[] {
  return extensions.flatMap((extension) => (extension.YouPhoneRow ? [extension.YouPhoneRow] : []));
}

export function extensionYouSections(): ComponentType[] {
  return extensions.flatMap((extension) => (extension.YouSection ? [extension.YouSection] : []));
}
