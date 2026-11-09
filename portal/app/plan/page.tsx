"use client";

import { usePortal } from "@/state/portal-provider";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceTabs } from "@/components/place-tabs";
import { planningAttention } from "@/features/plan/planning-attention";
import { planAnswer } from "@/features/plan/plan-answer";
import { DecisionsBanner } from "@/features/plan/components/decisions-banner";
import { TimeAhead } from "@/features/plan/components/time-ahead";
import { ConsequenceRankCard } from "@/features/plan/components/consequence-rank-card";
import { AreaOverview } from "@/features/plan/components/area-overview";
import { PlanEditorSheets } from "@/features/plan/components/plan-editor-sheets";
import { usePlanEditors } from "@/features/plan/use-plan-editors";
import styles from "./plan.module.css";

/**
 * `/plan`, the Areas tab: does the math work, in one sentence. Under it the decisions that stop
 * something being planned, every area as a row that opens `/plan/[areaId]` (where its outcomes,
 * projects and actions live and are edited), and beside them the time ahead. Below the areas, the optional "Rank these four" card. New area opens its
 * editor in a sheet over this page.
 */
export default function PlanPage() {
  const { state, forecasts, capacityEnvelopes } = usePortal();
  const editors = usePlanEditors();
  const attention = planningAttention(state);

  return (
    <main className={`content-page ${styles.page}`}>
      <PageHeader
        title="Plan"
        answer={planAnswer(state.projects, forecasts, attention.length)}
        actions={<Button onClick={() => editors.openCreate("area")}>New area</Button>}
      />
      <PlaceTabs />
      {editors.openEditor === null && editors.error && (
        <p className="form-error" role="alert">
          {editors.error}
        </p>
      )}
      <div className={styles.grid}>
        <div className={styles.main}>
          <DecisionsBanner items={attention} />
          <AreaOverview
            areas={state.areas}
            outcomes={state.outcomes}
            projects={state.projects}
            actions={state.actions}
            forecasts={forecasts}
            timezone={state.settings.timezone}
          />
          <ConsequenceRankCard />
        </div>
        <TimeAhead bands={capacityEnvelopes} timezone={state.settings.timezone} />
      </div>

      <PlanEditorSheets
        editors={editors}
        areas={state.areas}
        outcomes={state.outcomes}
        projects={state.projects}
        actions={state.actions}
        deliverables={state.deliverables}
        conditionDefinitions={state.conditionDefinitions}
        estimateBucketsMinutes={state.settings.estimateBucketsMinutes}
        timezone={state.settings.timezone}
      />
    </main>
  );
}
