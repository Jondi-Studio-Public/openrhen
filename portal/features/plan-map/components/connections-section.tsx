"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { PlanItemType } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import { usePlanMap } from "@/features/plan-map/use-plan-map";
import { buildTitleResolver, connectionCandidates, itemRefFor } from "@/features/plan-map/plan-map-model";
import { ConnectionsPanel } from "@/features/plan-map/components/connections-panel";

/**
 * The Connections section of a project, deliverable, action or commitment. A commitment in a series passes its `recurrenceRuleId`,
 * and the link is made to the rule.
 */
export function ConnectionsSection({
  itemType,
  itemId,
  recurrenceRuleId
}: {
  itemType: PlanItemType;
  itemId: string;
  recurrenceRuleId?: string | undefined;
}) {
  return <LoadedConnections itemType={itemType} itemId={itemId} recurrenceRuleId={recurrenceRuleId} />;
}

function LoadedConnections({
  itemType,
  itemId,
  recurrenceRuleId
}: {
  itemType: PlanItemType;
  itemId: string;
  recurrenceRuleId?: string | undefined;
}) {
  const { state } = usePortal();
  const planMap = usePlanMap();
  const item = itemRefFor(itemType, itemId, recurrenceRuleId);
  const resolver = useMemo(() => buildTitleResolver(state, planMap.map), [state, planMap.map]);
  const candidates = useMemo(() => connectionCandidates(state, planMap.map), [state, planMap.map]);
  return (
    <ConnectionsPanel
      item={item}
      recurring={itemType === "commitment" && Boolean(recurrenceRuleId)}
      map={planMap.map}
      status={planMap.status}
      error={planMap.error}
      actionError={planMap.actionError}
      busy={planMap.busy}
      resolver={resolver}
      candidates={candidates}
      onRetry={() => void planMap.reload()}
      onAdd={planMap.addLink}
      onDecide={(link, action) => void planMap.decideLink(link.id, action)}
    />
  );
}

/**
 * A collapsed row of a plan card that loads its connections only once opened, so a page of forty
 * actions does not make forty requests.
 */
export function ConnectionsFold({
  itemType,
  itemId,
  recurrenceRuleId
}: {
  itemType: PlanItemType;
  itemId: string;
  recurrenceRuleId?: string | undefined;
}): ReactNode {
  const [opened, setOpened] = useState(false);
  return (
    <details className="plan-map-fold" onToggle={(event) => event.currentTarget.open && setOpened(true)}>
      <summary>Connections</summary>
      {opened && <LoadedConnections itemType={itemType} itemId={itemId} recurrenceRuleId={recurrenceRuleId} />}
    </details>
  );
}
