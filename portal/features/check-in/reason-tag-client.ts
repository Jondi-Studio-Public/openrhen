/**
 * The browser's side of `GET /api/drift-reasons`, `PUT /api/drift-reasons/[checkInId]/tags` and
 * `DELETE /api/drift-reasons/[checkInId]` (all owner only): the owner's own words about leaving the plan, and the tags
 * on them. The words and tags travel in bodies and answers only: never in an address, a log or an error.
 */

export interface ReasonTagView {
  checkInId: string;
  /** The owner's words. */
  text: string;
  savedAt: string;
  tags: string[];
  /** `corrected` is the owner's own answer, `inferred` the local model's, null when there are no tags yet. */
  origin: "corrected" | "inferred" | null;
  /** The model's tags come from an older prompt or model and will be replaced when it next runs. */
  stale: boolean;
}

export interface ReasonTagsAnswer {
  modelConfigured: boolean;
  reasons: ReasonTagView[];
}

async function failure(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(
    typeof body?.error === "string"
      ? body.error
      : `The portal answered ${response.status}. Reload the page and try again.`
  );
}

/** A network failure (offline, portal down) reads as one plain sentence, not the browser's own wording. */
async function request(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error("Could not reach the portal. Try again.");
  }
}

export async function fetchReasonTags(): Promise<ReasonTagsAnswer> {
  const response = await request("/api/drift-reasons", { cache: "no-store" });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as ReasonTagsAnswer;
}

/** `requestId` is new for each change; a retry of the same change reuses it so it is stored once. `reset` takes the owner's answer back. */
export async function putReasonTags(
  checkInId: string,
  change: { tags: string[] } | { reset: true },
  requestId: string
): Promise<ReasonTagView> {
  const response = await request(`/api/drift-reasons/${encodeURIComponent(checkInId)}/tags`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...change, requestId })
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as ReasonTagView;
}

/** Deletes the reason and every tag on it. */
export async function deleteReasonAndTags(checkInId: string): Promise<void> {
  const response = await request(`/api/drift-reasons/${encodeURIComponent(checkInId)}`, { method: "DELETE" });
  if (!response.ok) throw await failure(response);
}
