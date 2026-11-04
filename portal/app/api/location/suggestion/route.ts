import { withLocationObservationStore } from "@/server/location/location-observation-store";
import { withRoute } from "@/server/logging";

/**
 * Dismisses whatever pending location suggestion is standing, without moving the assertion.
 *
 * The suggestion this clears is the one a phone ping or an open tab left behind for the Now page to
 * ask about — see `portal/server/location/observation-policy.ts`. Declining it here is the same kind
 * of answer as confirming it is: a later reading can always raise the question again, but nothing
 * should keep re-asking a question the person already said no to for the rest of the session.
 *
 * Same-origin and unauthenticated, like `/api/location/observe`: this route cannot touch the
 * assertion either, so there is nothing here for an outsider to take.
 */
export const DELETE = withRoute("/api/location/suggestion", async (_request, _context, log) => {
  log.setCommandType("location_suggestion_dismiss");
  await withLocationObservationStore((store) => store.clearSuggestion());
  return Response.json({ cleared: true });
});
