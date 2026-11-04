import type { DoctorArea, DoctorItem, DoctorReport, DoctorTier } from "@openrhen/contracts";
import { outcomePlanHref, projectPlanHref } from "@/features/plan/area-grouping";
import type { StoredArea, StoredOutcome, StoredProject } from "@/state/portal-state";

/** Tier order and the words each one is shown under. */
export const TIERS: readonly { tier: DoctorTier; label: string }[] = [
  { tier: "blocking", label: "Blocking" },
  { tier: "degrading", label: "Degrading" },
  { tier: "tidy", label: "Tidy" }
];

const AREA_LABELS: Record<DoctorArea, string> = {
  facts: "Facts",
  integrations: "Connections",
  calendar: "Calendar",
  plan: "Plan",
  routines: "Routines",
  staleness: "Staleness",
  ledgers: "Open lists"
};

export function areaLabel(area: DoctorArea): string {
  return AREA_LABELS[area] ?? area;
}

/** Reads a `/api/doctor` body; anything that is not a report is null, so a bad body shows as an error. */
export function parseDoctorReport(body: unknown): DoctorReport | null {
  if (!body || typeof body !== "object") return null;
  const report = body as Partial<DoctorReport>;
  if (!report.counts || !Array.isArray(report.items) || typeof report.healthy !== "boolean") return null;
  return { ...(report as DoctorReport), notChecked: Array.isArray(report.notChecked) ? report.notChecked : [] };
}

/** What needs fixing for the plan to be trusted: blocking plus degrading. Tidy never counts. */
export function attentionCount(report: Pick<DoctorReport, "counts">): number {
  return report.counts.blocking + report.counts.degrading;
}

/** "2 blocking, 3 degrading, 1 tidy", leaving out the empty tiers; "Healthy" when there is nothing. */
export function summaryLine(report: DoctorReport): string {
  if (report.healthy) return "Healthy";
  const parts = TIERS.filter(({ tier }) => report.counts[tier] > 0).map(
    ({ tier, label }) => `${report.counts[tier]} ${label.toLowerCase()}`
  );
  return parts.length ? parts.join(", ") : "Healthy";
}

/** The areas that have items, in the report's own order of first appearance. */
export function areasPresent(items: readonly DoctorItem[]): DoctorArea[] {
  return [...new Set(items.map((item) => item.area))];
}

/** Items in one area (all when `area` is null), grouped by tier with empty tiers left out. */
export function groupByTier(
  items: readonly DoctorItem[],
  area: DoctorArea | null
): { tier: DoctorTier; label: string; items: DoctorItem[] }[] {
  const shown = area ? items.filter((item) => item.area === area) : [...items];
  return TIERS.map(({ tier, label }) => ({ tier, label, items: shown.filter((item) => item.tier === tier) })).filter(
    (group) => group.items.length > 0
  );
}

/** "3 days ago" style age of `since`; null when it has none or is not a date. */
export function sinceText(since: string | undefined, now: Date): string | null {
  if (!since) return null;
  const then = Date.parse(since);
  if (Number.isNaN(then)) return null;
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  if (minutes < 60) return "since just now";
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `for ${hours} hours`;
  return `for ${Math.round(hours / 24)} days`;
}

export interface PlanLookup {
  projects: StoredProject[];
  outcomes: StoredOutcome[];
  areas: StoredArea[];
}

/**
 * The page a handle (`<type>:<id>`) opens, or null when the portal has no page for it. Projects and
 * outcomes open their place in Plan, commitments their own page; actions, batches and proposals have
 * no page of their own, so they get no link.
 */
export function handleLink(handle: string, plan: PlanLookup): { href: string; label: string } | null {
  const at = handle.indexOf(":");
  if (at < 0) return null;
  const type = handle.slice(0, at);
  const id = handle.slice(at + 1);
  if (type === "commitment") return { href: `/commitments/${encodeURIComponent(id)}`, label: "Open commitment" };
  if (type === "project") {
    const project = plan.projects.find((item) => item.id === id);
    return project ? { href: projectPlanHref(project, plan.outcomes, plan.areas), label: "Open project" } : null;
  }
  if (type === "outcome") {
    const outcome = plan.outcomes.find((item) => item.id === id);
    return outcome ? { href: outcomePlanHref(outcome, plan.areas), label: "Open outcome" } : null;
  }
  return null;
}
