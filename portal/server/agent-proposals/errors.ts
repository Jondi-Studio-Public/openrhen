/** A refusal the proposal routes answer themselves, with the status and any extra body fields it carries. */
export class AgentProposalError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 429,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

/** The response for an `AgentProposalError`; anything else is rethrown for `withRoute` to handle. */
export function proposalErrorResponse(error: unknown): Response {
  if (error instanceof AgentProposalError)
    return Response.json({ error: error.message, ...error.extra }, { status: error.status });
  throw error;
}

/**
 * The 503 body when the portal has no database: what it means, that nothing was filed or read, and that a person
 * (not the agent) fixes it. The same text on every proposal route.
 */
export const PROPOSALS_UNAVAILABLE =
  "The portal's database is not available, so proposals cannot be filed or read right now. Nothing was changed. " +
  "Repeat the same call in a minute; if it keeps failing, tell the person the portal needs attention.";
