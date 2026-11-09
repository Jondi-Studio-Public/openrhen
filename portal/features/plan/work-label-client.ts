/** The browser's side of `GET /api/work-labels` and `PUT /api/work-labels/[areaId]` (owner only). */

export type WorkLabelValue = "work" | "not_work" | "unknown";
export type WorkLabelAnswer = "work" | "not_work" | "unset";

export interface WorkLabelView {
  areaId: string;
  value: WorkLabelValue;
  /** `corrected` is the owner's own answer, `inferred` the local model's. */
  origin: "corrected" | "inferred" | null;
  at: string | null;
}

export interface WorkLabelsAnswer {
  modelConfigured: boolean;
  labels: WorkLabelView[];
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

export async function fetchWorkLabels(): Promise<WorkLabelsAnswer> {
  const response = await request("/api/work-labels", { cache: "no-store" });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as WorkLabelsAnswer;
}

/** `requestId` is new for each tap; a retry of the same tap reuses it so it is stored once. */
export async function putWorkLabel(areaId: string, label: WorkLabelAnswer, requestId: string): Promise<WorkLabelView> {
  const response = await request(`/api/work-labels/${encodeURIComponent(areaId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, requestId })
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as WorkLabelView;
}
