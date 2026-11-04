/**
 * The batch or a record it would write has moved on since the caller last saw it: a stale version,
 * an already committed batch, a record deleted underneath a delete. Routes answer it as a 409.
 */
export class ImportConflictError extends Error {}
