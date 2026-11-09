/**
 * An error carrying only the kind of the original. Routes that handle the owner's words rethrow this, because a
 * database message can quote the row it refused and the route logger records the error's message.
 */
export function nameOnlyError(error: unknown): Error {
  return new Error(`The request failed (${error instanceof Error ? error.name : "unknown"}).`);
}
