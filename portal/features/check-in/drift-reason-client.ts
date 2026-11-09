/** The browser's side of `POST /api/drift-reasons` (owner only): the words a person gives for leaving the plan. */

async function failure(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(
    typeof body?.error === "string"
      ? body.error
      : `The portal answered ${response.status}. Reload the page and try again.`
  );
}

/**
 * Saves the reason for a check-in already answered as something else. `requestId` is new for each different text; a
 * retry of the same text reuses it so it is stored once. A network failure reads as one plain sentence. The words are
 * sent in the body only: never in an address, a log or an error.
 */
export async function saveDriftReason(checkInId: string, text: string, requestId: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/drift-reasons", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkInId, text, requestId })
    });
  } catch {
    throw new Error("Could not reach the portal. Try again.");
  }
  if (!response.ok) throw await failure(response);
}
