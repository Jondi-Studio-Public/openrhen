import {
  closedPageSchema,
  closedSummarySchema,
  type ClosedPage,
  type ClosedSummary,
  type ClosedTab
} from "@openrhen/contracts";
import type { CloseType } from "@openrhen/contracts";

/** The Closed page's reads. Both throw on a failed answer or a body that is not the contract's shape. */
export async function fetchClosed(params: {
  tab: ClosedTab;
  type?: CloseType | undefined;
  before?: string | undefined;
}): Promise<ClosedPage> {
  const query = new URLSearchParams({ tab: params.tab });
  if (params.type) query.set("type", params.type);
  if (params.before) query.set("before", params.before);
  const response = await fetch(`/api/closed?${query.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("The closed list could not be read.");
  const parsed = closedPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("The closed list could not be read.");
  return parsed.data;
}

export async function fetchClosedSummary(): Promise<ClosedSummary> {
  const response = await fetch("/api/closed/summary", { cache: "no-store" });
  if (!response.ok) throw new Error("The closed summary could not be read.");
  const parsed = closedSummarySchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("The closed summary could not be read.");
  return parsed.data;
}
