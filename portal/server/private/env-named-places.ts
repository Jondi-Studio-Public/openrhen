// The OpenRhen stand-in for the private place-name seam: no connection labels shifts with environment settings here, so
// there are no environment-named places. The signatures match the private file kept code imports.
export const normalisePlaceName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** Every place name the environment maps shifts to. Always empty in the open-source tree. */
export function envPlaceNames(_env: Record<string, string | undefined>): string[] {
  return [];
}
