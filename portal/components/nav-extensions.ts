import type { Destination, PrimaryTab } from "./app-nav-tabs";

/**
 * Registry of the navigation a feature the OpenRhen export leaves out adds: palette destinations and the
 * path prefixes a place owns. `private/index.ts` lists every extension and registers each on import; the export
 * excludes that folder and ships an empty `private/index.ts`, so the core navigation names none of them. This file
 * imports types only, which keeps it safe to read before the tables in `app-nav-tabs.ts` are built.
 */
export interface NavExtension {
  /** Stable name; registering the same id twice is a no-op. */
  id: string;
  /** Destinations to add, each batch placed after the destination with the `after` href (or last). */
  destinations?: readonly { after: string; items: readonly Destination[] }[];
  /** Search words to add to a core destination, by its href. */
  keywords?: Readonly<Record<string, string>>;
  /** Path prefixes a place owns, so the page highlights that place. */
  ownership?: readonly (readonly [PrimaryTab, string])[];
}

const extensions = new Map<string, NavExtension>();

export function registerNavExtension(extension: NavExtension): void {
  if (!extensions.has(extension.id)) extensions.set(extension.id, extension);
}

export function withExtensionDestinations(core: readonly Destination[]): Destination[] {
  const list = [...core];
  for (const extension of extensions.values())
    for (const [href, words] of Object.entries(extension.keywords ?? {})) {
      const at = list.findIndex((destination) => destination.href === href);
      if (at >= 0) list[at] = { ...list[at]!, keywords: [list[at]!.keywords, words].filter(Boolean).join(" ") };
    }
  for (const extension of extensions.values())
    for (const { after, items } of extension.destinations ?? []) {
      const anchor = list.findIndex((destination) => destination.href === after);
      list.splice(anchor < 0 ? list.length : anchor + 1, 0, ...items);
    }
  return list;
}

export function withExtensionOwnership(
  core: readonly (readonly [PrimaryTab, string])[]
): (readonly [PrimaryTab, string])[] {
  return [...core, ...[...extensions.values()].flatMap((extension) => extension.ownership ?? [])];
}
