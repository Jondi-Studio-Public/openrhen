import type {
  PlanLink,
  PlanLinkInput,
  PlanLinkKind,
  PlanMap,
  SwitchableAddon,
  PlanMapFindingAction,
  PlanMapLinkAction,
  PlanMapMode
} from "@openrhen/contracts";

/**
 * Typed calls to `/api/plan-map/*`. Each turns the route's `{ error }` envelope into a thrown message
 * so the caller decides only what to show, never how a response is shaped.
 */

const send = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An empty or non-JSON body falls through to the fallback message.
  }
  if (!response.ok) {
    const message = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    throw new Error(typeof message === "string" && message ? message : fallback);
  }
  return body as T;
}

export async function fetchPlanMap(): Promise<PlanMap> {
  const response = await fetch("/api/plan-map", { cache: "no-store" });
  return readJson<PlanMap>(response, "The plan map could not be loaded.");
}

export async function createPlanLink(input: PlanLinkInput): Promise<PlanLink> {
  const response = await fetch("/api/plan-map/links", send("POST", input));
  return (await readJson<{ link: PlanLink }>(response, "The link was not saved.")).link;
}

export async function decidePlanLink(id: string, action: PlanMapLinkAction["action"]): Promise<void> {
  const response = await fetch(`/api/plan-map/links/${encodeURIComponent(id)}`, send("POST", { action }));
  await readJson<unknown>(response, "The link was not updated.");
}

/** Confirms every suggestion from `proposer` of `kind`; resolves to the ids confirmed, so Undo can reopen them. */
export async function bulkConfirmPlanLinks(proposer: string, kind: PlanLinkKind): Promise<string[]> {
  const response = await fetch("/api/plan-map/links/bulk", send("POST", { proposer, kind }));
  return (await readJson<{ ids: string[] }>(response, "The links were not confirmed.")).ids;
}

export async function decidePlanFinding(
  id: string,
  action: PlanMapFindingAction["action"],
  answers?: Record<string, string>
): Promise<void> {
  const response = await fetch(
    `/api/plan-map/findings/${encodeURIComponent(id)}`,
    send("POST", answers && Object.keys(answers).length ? { action, answers } : { action })
  );
  await readJson<unknown>(response, "The finding was not updated.");
}

export async function setPlanMapSwitch(addon: SwitchableAddon, mode: PlanMapMode): Promise<void> {
  const response = await fetch("/api/plan-map/switches", send("PUT", { addon, mode }));
  await readJson<unknown>(response, "The switch was not saved.");
}
