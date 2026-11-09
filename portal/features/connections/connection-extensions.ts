import type { ComponentType, ReactNode } from "react";
import type { ConnectionSummary } from "./connection-summaries";

/**
 * Registry of the connections a feature the OpenRhen export leaves out adds to the Connections page and the You
 * overview: its live read, its summary row, the recorded run the overview reads and its details sheet.
 * `state/private/index.ts` registers each on import; the export ships an empty one, so the page lists only the core
 * connections.
 */
export interface ConnectionDetailProps {
  read: unknown;
  formatDateTime: (value: string | undefined) => string;
  /** The provider health block (with its divider) the page renders for a connection that names a `provider`; null otherwise or while it is not set up. */
  telemetry: ReactNode;
}

export interface ConnectionExtension {
  id: string;
  title: string;
  /** The telemetry name (`/api/connections/status`) of the provider whose health block the details sheet shows. */
  provider?: string;
  /** The core connection whose row this one follows. */
  after: string;
  /** A core row this extension supplies instead (its id, e.g. `google-calendar`): the core row and details are left out. Give the extension that same `id` so a link to `/connections#<id>` still opens it. */
  replaces?: string;
  /** The page's live read (called as a hook, once per render, in registration order). */
  useRead: () => unknown;
  summary: (read: unknown, when: (iso: string) => string, now: Date) => ConnectionSummary;
  /** The GET route of its last recorded run, and what the overview calls a good run; absent, the overview omits the row. */
  recorded?: { url: string; synced: string };
  Detail: ComponentType<ConnectionDetailProps>;
}

const extensions: ConnectionExtension[] = [];

export function registerConnectionExtension(extension: ConnectionExtension): void {
  if (!extensions.some((existing) => existing.id === extension.id)) extensions.push(extension);
}

export function connectionExtensions(): readonly ConnectionExtension[] {
  return extensions;
}

/** The core row ids an extension supplies itself, so the core row is not also drawn. */
export function replacedRowIds(): ReadonlySet<string> {
  return new Set(extensions.flatMap((extension) => (extension.replaces ? [extension.replaces] : [])));
}

/** Runs every registered read; the list is fixed once the module graph has loaded. */
export function useConnectionExtensionReads(): Record<string, unknown> {
  return Object.fromEntries(extensions.map((extension) => [extension.id, extension.useRead()]));
}

/** `rows` with each extension's row placed after the core row it names (at the end when that row is absent). */
export function withExtensionRows<T extends { id: string }>(
  rows: readonly T[],
  extra: (e: ConnectionExtension) => T,
  include: (e: ConnectionExtension) => boolean = () => true
): T[] {
  const result = [...rows];
  for (const extension of extensions.filter(include)) {
    const at = result.findIndex((row) => row.id === extension.after);
    result.splice(at < 0 ? result.length : at + 1, 0, extra(extension));
  }
  return result;
}
