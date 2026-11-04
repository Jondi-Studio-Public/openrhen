import { connectionManifest, connectionRegistry, sourceLabel, type ImportRecord } from "@openrhen/contracts";

// Which sources are primary, from the manifests rather than by name: a primary source is definitive on
// when and where something happens, so a secondary source's change to those fields is never asked about. The
// OpenRhen export registers no primary source, so nothing there is one.

/** The fields a primary link gives. Here, not in `source-match-records`, so a profile can read it without a cycle through the seam. */
export const PRIMARY_OWNED_FIELDS: readonly string[] = ["title", "startsAt", "endsAt", "location"];

/** Whether the provider's manifest declares it the primary record of the commitments it feeds. */
export function isPrimarySource(provider: string): boolean {
  return connectionManifest(provider)?.calendarSource?.role === "primary";
}

/** How the person sees a primary source called in evidence, from its manifest label. */
export function primarySourceLabel(provider: string): string {
  return sourceLabel(provider);
}

/**
 * Whether this record is a primary source creating a commitment: the only writer whose sharing default is a standing
 * user setting rather than "unshared unless the batch says otherwise". Told by the import-key prefix (`<id>:`), since
 * the batch item carries no separate provider column.
 */
export function isPrimarySourceCreate(record: ImportRecord): boolean {
  return (
    record.operation === "create" &&
    connectionRegistry().some(
      (manifest) => manifest.calendarSource?.role === "primary" && record.importKey.startsWith(`${manifest.id}:`)
    )
  );
}
