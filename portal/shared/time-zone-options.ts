/** Every zone the browser knows, the stored one first; `supportedValuesOf` omits UTC, so it is added. */
export function timeZoneOptions(stored: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    // An older browser without supportedValuesOf: the stored zone and UTC still work.
  }
  return [...new Set([stored, ...zones, "UTC"].filter(Boolean))];
}
