// A leaf (it imports nothing), so a file under `./private/` can register a removed field name while the barrel is
// still loading. The names a build refuses are these; `removed-field-names.ts` documents and serves them.

/** Old input field name to the field that replaced it. */
export const REMOVED_FIELD_NAMES: Record<string, string> = {
  shareWithFamily: "shareToCalendar",
  shareWithFamilyEnabled: "calendarShareEnabled"
};

/** Adds an old field name a feature the OpenRhen export leaves out renamed; registering a name twice is a no-op. */
export function registerRemovedFieldName(old: string, current: string): void {
  if (!Object.hasOwn(REMOVED_FIELD_NAMES, old)) REMOVED_FIELD_NAMES[old] = current;
}
