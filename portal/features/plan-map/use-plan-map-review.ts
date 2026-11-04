"use client";

import { useEffect, useMemo } from "react";
import type { PlanFinding, PlanLink, PlanLinkKind, PlanMap } from "@openrhen/contracts";
import { useNow } from "@/shared/clock";
import { usePortal } from "@/state/portal-provider";
import { usePlanMap } from "@/features/plan-map/use-plan-map";
import { publishPlanMapOpenCount } from "@/features/plan-map/plan-map-open-count";
import { buildTitleResolver, recentlyDecided } from "@/features/plan-map/plan-map-model";
import type { InboxDecisions } from "@/features/inbox/use-inbox-decisions";

/** The map without the cards a decision has hidden while its write runs, so the list and its count close up at once. */
function withoutHidden(map: PlanMap | null, hidden: ReadonlySet<string>): PlanMap | null {
  if (!map || hidden.size === 0) return map;
  return {
    ...map,
    links: map.links.filter((link: PlanLink) => !hidden.has(link.id)),
    findings: map.findings.filter((finding: PlanFinding) => !hidden.has(finding.id))
  };
}

/**
 * The Inbox's Links: the plan map's suggested links and open findings, wired to the store and to
 * portal state for titles. Confirm, Reject, Accept and Dismiss go through the Inbox's decisions like
 * every other row: the row leaves at once and a toast names what happened, with an Undo that reopens
 * the suggestion or finding.
 */
export function usePlanMapReview(decisions: Pick<InboxDecisions, "decide" | "hidden">) {
  const { state } = usePortal();
  const planMap = usePlanMap();
  const resolver = useMemo(() => buildTitleResolver(state, planMap.map), [state, planMap.map]);
  // A decision here moves the Inbox tab's badge at once rather than at its next refresh.
  useEffect(() => publishPlanMapOpenCount(planMap.map), [planMap.map]);
  const now = useNow("minute");
  const handled = useMemo(
    () => recentlyDecided(planMap.map, resolver.titleOf, now.getTime()),
    [planMap.map, resolver, now]
  );
  const shown = useMemo(() => withoutHidden(planMap.map, decisions.hidden), [planMap.map, decisions.hidden]);

  const decideLink = (id: string, action: "confirm" | "reject") =>
    decisions.decide(
      [id],
      action === "confirm" ? "confirm" : "ignore",
      () => planMap.decideLink(id, action),
      { kind: "undo", run: () => planMap.reopenLinks([id]) },
      action === "confirm" ? "Confirmed" : "Rejected",
      "link"
    );
  const bulkConfirm = (proposer: string, kind: PlanLinkKind) => {
    const waiting = (planMap.map?.links ?? []).filter(
      (link) => link.status === "suggested" && link.proposer === proposer && link.kind === kind
    );
    // The server names what it confirmed, which can differ from what this screen last loaded.
    let confirmed: string[] = [];
    return decisions.decide(
      waiting.map((link) => link.id),
      "confirm",
      async () => {
        const ids = await planMap.bulkConfirm(proposer, kind);
        if (!ids) return false;
        confirmed = ids;
      },
      { kind: "undo", run: () => planMap.reopenLinks(confirmed) },
      "Confirmed",
      "link"
    );
  };
  const decideFinding = (id: string, action: "accept" | "dismiss", answers?: Record<string, string>) =>
    decisions.decide(
      [id],
      action === "accept" ? "confirm" : "ignore",
      () => planMap.decideFinding(id, action, answers),
      { kind: "undo", run: () => planMap.reopenFinding(id) },
      action === "accept" ? "Accepted" : "Dismissed",
      "finding"
    );

  return {
    map: shown,
    status: planMap.status,
    error: planMap.error,
    actionError: planMap.actionError,
    busy: planMap.busy,
    reload: planMap.reload,
    resolver,
    handled,
    decideLink,
    bulkConfirm,
    decideFinding
  };
}

export type PlanMapReview = ReturnType<typeof usePlanMapReview>;
