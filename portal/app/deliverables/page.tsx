"use client";

import { useEffect, useMemo, useState } from "react";
import type { CoordinationState, RequirementPathway } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import { useNow } from "@/shared/clock";
import { useMediaQuery } from "@/shared/use-media-query";
import { CheckInBanner } from "@/features/check-in/components/check-in-banner";
import { assessDeliverable } from "@openrhen/contracts/readiness";
import type { StoredDeliverable, StoredDeliverableContractProposal } from "@/state/portal-state";
import { navigateTo } from "@/shared/navigate";
import {
  CLOSED_DELIVERABLE_STATUSES,
  phaseOf,
  sessionFor,
  type WorkspaceMode
} from "@/features/deliverables/deliverable-model";
import { CompletionPanel } from "@/features/deliverables/components/completion-panel";
import { DeliverableList, deliverablesAnswer } from "@/features/deliverables/components/deliverable-list";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceTabs } from "@/components/place-tabs";
import { WorkspaceHeader } from "@/features/deliverables/components/workspace-header";
import { StepRail } from "@/features/deliverables/components/step-rail";
import { CriteriaRail } from "@/features/deliverables/components/criteria-rail";
import { ReadinessPanel, type EngineOpinion } from "@/features/deliverables/components/readiness-panel";
import { ChatPanel } from "@/features/deliverables/components/chat-panel";
import { HandedOffOverview } from "@/features/deliverables/components/handed-off-overview";
import type { CoordinationPrompts } from "@/features/deliverables/use-coordination";
import type { SessionOutcome } from "@/features/deliverables/components/session-card";
import { WorkspaceActions } from "@/features/deliverables/components/workspace-actions";
import { PhaseBar, type WorkspaceDrawer } from "@/features/deliverables/components/phase-bar";
import { ConnectionsSection } from "@/features/plan-map/components/connections-section";
import { CloseControl } from "@/features/closed/components/close-control";
import { WorkspaceSheets } from "@/features/deliverables/components/workspace-sheets";
import type { SourceAttachment } from "@/features/deliverables/components/source-panel";
import {
  deliverablePersistCommand,
  finishActivityCommand,
  pauseResumeSessionCommand,
  reviewProposalCommand,
  switchDeliverableStepCommand
} from "@/features/deliverables/deliverable-commands";

/**
 * The Deliverables tab and the one workspace behind it.
 *
 * The workspace has two modes. In an engine-allocated session — reached by Start on a
 * recommendation from Now — it is editable and timed. Opened from the list without a session it is
 * the same workspace read-only: where the deliverable is up to, what the engine thinks of it, and
 * nothing that changes it. Work happens only inside a session, so there is no timer or edit here
 * without one.
 *
 * The frame is fixed height at every width — a topbar, a phase bar that pins the current phase's
 * working set (the timer and current step in Carry out, the approval state in Breakdown, criteria
 * progress in Review), the conversation plus one phase-specific context column on desk, and the
 * action row — so the document itself never scrolls, only its panes do. Everything else (Details,
 * Steps, Criteria, Sources, Blockers, Readiness, Session, the retired bulk-extraction proposals)
 * lives behind a Sheet opened from the phase bar's chips, because a working set that fits one screen
 * is worth more than every rail visible at once. A running session is still driven from Now, which
 * is where it is started.
 */
export default function DeliverablesPage() {
  const {
    state,
    saving,
    recommendation,
    continuation,
    saveEntityCommand,
    runActivityCommand,
    finishSession,
    acceptServerState,
    serverClockOffsetMs
  } = usePortal();
  const desk = useMediaQuery("(min-width: 1024px)");
  const [drawer, setDrawer] = useState<WorkspaceDrawer | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<StoredDeliverable | null>(null);
  const [error, setError] = useState("");
  const [proposalDrafts, setProposalDrafts] = useState<Record<string, StoredDeliverableContractProposal>>({});
  /** Bumped when the workspace writes to the chat thread behind the panel's back. */
  const [chatReloadKey, setChatReloadKey] = useState(0);
  /** True from the moment Mark complete lands until the celebration is dismissed. */
  const [celebrating, setCelebrating] = useState(false);
  /**
   * Who (if anyone) is coordinating this deliverable externally, reported up by whichever of
   * ChatPanel/HandedOffOverview is currently mounted — each loads it itself via `useCoordination`.
   * Null (unknown/not handed off) renders the chat, exactly as before this feature existed; only a
   * confirmed `handedOff: true` swaps it for the overview. See the external coordination design note.
   */
  const [coordination, setCoordination] = useState<CoordinationState | null>(null);

  const stored = state.deliverables.find((item) => item.id === selectedId) ?? null;
  const session = stored ? sessionFor(state, stored.id) : null;
  // The session card counts elapsed and remaining seconds; without a session nothing on the page
  // moves faster than the minute.
  const now = useNow(session ? "second" : "minute");
  const mode: WorkspaceMode = session ? "session" : "view";
  const editable = mode === "session";
  const working = (editable ? draft : null) ?? stored;
  const dirty = editable && draft !== null;

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("deliverable");
    if (!requested || selectedId) return;
    if (state.deliverables.some((item) => item.id === requested)) open(requested);
  }, [selectedId, state.deliverables]);

  // A draft belongs to the session that made it. When the session ends the page drops to the
  // read-only view and an unsaved draft would otherwise sit there looking editable.
  if (!editable && draft) setDraft(null);

  const readiness = useMemo(
    () =>
      working
        ? assessDeliverable({
            deliverable: working,
            situation: state.currentSituation,
            conditionDefinitions: state.conditionDefinitions,
            now,
            commitments: state.commitments
          })
        : null,
    [working, state.currentSituation, state.conditionDefinitions, state.commitments, now]
  );

  const engine = useMemo((): EngineOpinion | null | undefined => {
    if (!working) return undefined;
    if (!state.planning?.result) return undefined;
    const deliverableOf = (candidate: { action: unknown }) =>
      (candidate.action as { deliverableId?: string } | null)?.deliverableId;
    const index = recommendation.candidates.findIndex((candidate) => deliverableOf(candidate) === working.id);
    if (index < 0) return null;
    const candidate = recommendation.candidates[index]!;
    return {
      rank: index + 1,
      totalScore: candidate.totalScore,
      eligible: candidate.eligible,
      exclusionReasons: candidate.exclusionReasons,
      recommendedMinutes: candidate.recommendedMinutes,
      recommended: recommendation.primary ? deliverableOf(recommendation.primary) === working.id : false
    };
  }, [working, recommendation, state.planning?.result]);

  // Loaded fresh by whichever component mounts for the newly opened deliverable — stale coordination
  // from the previous one must never carry over and briefly mount the wrong component. The prompts
  // argument is only for the mounted component's own use (copy buttons); the page itself only needs
  // `handedOff` to decide what to mount.
  function handleCoordination(next: CoordinationState | null, _prompts: CoordinationPrompts | null) {
    setCoordination(next);
  }

  function open(id: string) {
    setSelectedId(id);
    setDraft(null);
    setError("");
    setProposalDrafts({});
    setCelebrating(false);
    setDrawer(null);
    setCoordination(null);
  }
  function back() {
    setSelectedId(null);
    setDraft(null);
    setError("");
    setCelebrating(false);
    setDrawer(null);
    setCoordination(null);
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }

  function edit(change: (current: StoredDeliverable) => StoredDeliverable) {
    if (!editable || !stored) return;
    // Functional, so two edits in the same tick both survive.
    setDraft((previous) => change(previous ?? stored));
  }

  async function persist(deliverable: StoredDeliverable, expectedVersion: number | null) {
    await saveEntityCommand(deliverablePersistCommand(deliverable, expectedVersion));
  }
  async function attempt(action: () => Promise<void>, fallback: string) {
    try {
      await action();
      setError("");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
      return false;
    }
  }

  const save = () =>
    attempt(async () => {
      if (!working) return;
      await persist(working, working.version ?? null);
      setDraft(null);
    }, "The deliverable was not saved.");

  // Saves one step's context requirements on their own, independent of `editable`/session state — the
  // read-only workspace has no draft to be dirty, so this writes straight from `stored` rather than
  // going through `edit`/`save`. Bound to `stored`, not `working`, since it is only ever offered while
  // `!editable` (see StepRail's onSaveStepRequirementPathways), when the two are the same thing anyway.
  const saveStepRequirementPathways = (stepId: string, pathways: RequirementPathway[]) =>
    attempt(async () => {
      if (!stored) return;
      await persist(
        {
          ...stored,
          steps: stored.steps.map((item) => (item.id === stepId ? { ...item, requirementPathways: pathways } : item))
        },
        stored?.version ?? null
      );
    }, "The step's requirements were not saved.");

  const approve = () =>
    attempt(async () => {
      if (!working || !readiness) return;
      if (readiness.coverageFailures.length)
        throw new Error("Resolve the coverage problems named under Readiness first.");
      const at = new Date().toISOString();
      await persist(
        {
          ...working,
          contractVersion: working.contractVersion + 1,
          planVersion: working.planVersion + 1,
          contractApprovedAt: at,
          planApprovedAt: at,
          status: working.status === "needs_breakdown" ? "ready" : working.status
        },
        working.version ?? null
      );
      setDraft(null);
    }, "The approval was not recorded.");

  const beginReview = () =>
    attempt(async () => {
      if (!working) return;
      await persist({ ...working, status: "under_review" }, working.version ?? null);
      setDraft(null);
    }, "Review was not started.");

  const markComplete = () =>
    attempt(async () => {
      if (!working) return;
      if (!window.confirm(`Confirm that “${working.title}” is complete? This unlocks any deliverable waiting on it.`))
        return;
      await persist(
        { ...working, status: "completed", completedAt: new Date().toISOString() },
        working.version ?? null
      );
      setDraft(null);
      // Completing the deliverable completes the session: leaving the timer running against closed
      // work would credit minutes to nothing. Ended here, not via `finish`, so the page stays to
      // celebrate instead of bouncing to Now mid-moment.
      try {
        if (session)
          await runActivityCommand(finishActivityCommand(session, "completed", "Deliverable marked complete."));
      } catch (cause) {
        // The deliverable is already closed, so a retry cannot work; say what is left running.
        setCelebrating(true);
        throw new Error(
          `The deliverable is complete, but its timer could not be stopped (${cause instanceof Error ? cause.message : "unknown error"}). End the session from Now.`
        );
      }
      setCelebrating(true);
    }, "Completion was not recorded.");

  // Attaching a source retains it and makes it conversation material; the assistant reads it from
  // the next turn on, and the requirements it implies are agreed in chat rather than bulk-proposed.
  const attachSource = async (request: SourceAttachment) => {
    if (!working) return;
    const response = await fetch(`/api/deliverables/${encodeURIComponent(working.id)}/sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    const result = (await response.json()) as { state?: typeof state; error?: string };
    if (!response.ok || !result.state) throw new Error(result.error ?? "The source could not be attached.");
    acceptServerState(result.state);
    // The route appended the arrival notice to the thread, so the chat has to re-read its history.
    setChatReloadKey((current) => current + 1);
  };

  const onProposalChange = (
    proposal: StoredDeliverableContractProposal,
    change: Partial<StoredDeliverableContractProposal>
  ) =>
    setProposalDrafts((current) => ({
      ...current,
      [proposal.id]: { ...(current[proposal.id] ?? proposal), ...change }
    }));

  const reviewProposal = (proposal: StoredDeliverableContractProposal, decision: "confirm" | "ignore") =>
    attempt(async () => {
      const criterion = proposalDrafts[proposal.id] ?? proposal;
      await saveEntityCommand(reviewProposalCommand(proposal, criterion, decision));
      setProposalDrafts((current) => {
        const next = { ...current };
        delete next[proposal.id];
        return next;
      });
    }, "The requirement review was not saved.");

  const activity = (command: Parameters<typeof runActivityCommand>[0], fallback: string) =>
    attempt(() => runActivityCommand(command), fallback);

  const switchStep = (stepId: string) =>
    session && activity(switchDeliverableStepCommand(session, stepId), "Could not move to that step.");
  const pauseResume = () =>
    session && activity(pauseResumeSessionCommand(session), "The session could not be paused or resumed.");
  const continueSession = () => attempt(() => finishSession("continue"), "The session could not be continued.");
  const finish = (outcome: SessionOutcome, note: string, endedAt?: string) =>
    session &&
    attempt(async () => {
      await runActivityCommand(finishActivityCommand(session, outcome, note, endedAt));
      navigateTo("/");
    }, "The session could not be ended.");

  // With nothing open this lists deliverables; Start on Now and every link to a deliverable land here
  // and open one, because a session needs its workspace.
  if (!working || !readiness)
    return (
      <main className="content-page">
        <PageHeader
          title="Plan"
          answer={deliverablesAnswer(state.deliverables, now.getTime(), state.settings.timezone)}
        />
        <PlaceTabs />
        <DeliverableList
          deliverables={state.deliverables}
          projects={state.projects}
          activeSession={state.activeSession}
          timezone={state.settings.timezone}
          onOpen={(item) => open(item.id)}
        />
      </main>
    );

  const phase = phaseOf(working);
  const closed = CLOSED_DELIVERABLE_STATUSES.has(working.status);
  const projectTitle = state.projects.find((item) => item.id === working.projectId)?.title;
  // What this completion released: deliverables that were waiting on it and now wait on nothing.
  const unlocked = closed
    ? state.deliverables.filter(
        (other) =>
          other.id !== working.id &&
          !CLOSED_DELIVERABLE_STATUSES.has(other.status) &&
          other.dependencyIds.includes(working.id) &&
          other.dependencyIds.every(
            (dependency) =>
              dependency === working.id ||
              state.deliverables.find((item) => item.id === dependency)?.status === "completed"
          )
      )
    : [];

  // A closed deliverable gets an ending, not the working rails: the completion panel is the page,
  // with the celebration overlaid in the moment Mark complete lands.
  if (closed)
    return (
      <main className="deliverable-workspace" data-frame="closed">
        {/* Top of the workbench, same as Now: a ground-truth question about what the engine already
            believes outranks the workspace itself. Renders nothing when there is no pending check-in. */}
        <CheckInBanner />
        <WorkspaceHeader
          deliverable={working}
          projectTitle={projectTitle}
          phase={phase}
          mode={mode}
          currentStepTitle={undefined}
          dirty={false}
          onBack={back}
          closeControl={<CloseControl type="deliverable" id={working.id} />}
        />
        <PlaceTabs />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <CompletionPanel
          deliverable={working}
          projectTitle={projectTitle}
          unlocked={unlocked}
          timezone={state.settings.timezone}
          overlay={false}
          onBack={back}
        />
        {celebrating && (
          <CompletionPanel
            deliverable={working}
            projectTitle={projectTitle}
            unlocked={unlocked}
            timezone={state.settings.timezone}
            overlay
            onDismiss={() => setCelebrating(false)}
            onBack={back}
          />
        )}
      </main>
    );

  const currentStep = session ? working.steps.find((step) => step.id === session.stepId) : undefined;
  const pendingProposals = working.contractProposals.filter((proposal) => proposal.status === "pending");
  const canSwitch =
    editable && session?.status === "running" && phase !== "Breakdown" && new Date(session.plannedEndAt) > now;
  const planningDecisionCurrent =
    state.planning?.status === "current" &&
    Boolean(
      state.planning.validUntil && new Date(state.planning.validUntil) > new Date(now.getTime() + serverClockOffsetMs)
    );

  return (
    <main className="deliverable-workspace" data-phase={phase}>
      {/* Top of the workbench, same as Now: a ground-truth question about what the engine already
          believes outranks the workspace itself. Renders nothing when there is no pending check-in. */}
      <CheckInBanner />
      <WorkspaceHeader
        deliverable={working}
        projectTitle={projectTitle}
        phase={phase}
        mode={mode}
        currentStepTitle={currentStep?.title}
        dirty={dirty}
        onBack={back}
        closeControl={<CloseControl type="deliverable" id={working.id} dirty={dirty} />}
      />
      <PlaceTabs />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <PhaseBar
        deliverable={working}
        readiness={readiness}
        phase={phase}
        session={session}
        now={now}
        currentStepTitle={currentStep?.title}
        canSwitch={Boolean(canSwitch)}
        saving={saving}
        planningDecisionCurrent={planningDecisionCurrent}
        continuation={continuation}
        pendingProposalCount={pendingProposals.length}
        onPauseResume={() => void pauseResume()}
        onContinue={() => void continueSession()}
        onOpen={setDrawer}
      />
      <div className="deliverable-workspace-grid" data-columns={desk ? 2 : 1}>
        <section className="workspace-conversation">
          {/* AT-T: coverage failures block Approve, so they stay on the page at every width rather
              than only behind the Readiness chip. */}
          {phase === "Breakdown" && readiness.coverageFailures.length > 0 && (
            <ReadinessPanel
              deliverable={working}
              readiness={readiness}
              engine={engine}
              timezone={state.settings.timezone}
            />
          )}
          {coordination?.handedOff ? (
            // The chat panel and its composer are not mounted at all while handed off — see
            // The external coordination design note, "The workspace while handed off". This overview
            // owns its own `useCoordination` call and reports back through `onCoordination` the moment
            // a drop-off lands, which is what flips this back to the chat panel below.
            <HandedOffOverview
              deliverableId={working.id}
              deliverable={working}
              readiness={readiness}
              engine={engine}
              conditionDefinitions={state.conditionDefinitions}
              session={session}
              now={now}
              currentStepTitle={currentStep?.title}
              timezone={state.settings.timezone}
              reloadKey={chatReloadKey}
              onCoordination={handleCoordination}
            />
          ) : (
            <ChatPanel
              deliverableId={working.id}
              phase={phase}
              editable={editable}
              dirty={dirty}
              reloadKey={chatReloadKey}
              timezone={state.settings.timezone}
              deliverable={stored}
              onApplied={acceptServerState}
              onUndo={(before, expectedVersion) => persist(before, expectedVersion)}
              onCoordination={handleCoordination}
            />
          )}
        </section>
        {desk && phase === "Breakdown" && (
          <aside className="workspace-rail workspace-plan-rail">
            <StepRail
              deliverable={working}
              readiness={readiness}
              conditionDefinitions={state.conditionDefinitions}
              editable={editable}
              currentStepId={session?.stepId}
              stepSeconds={session?.stepSeconds}
              canSwitch={Boolean(canSwitch)}
              onSwitchStep={(stepId) => void switchStep(stepId)}
              onEdit={edit}
              timezone={state.settings.timezone}
              onSaveStepRequirementPathways={(stepId, pathways) => saveStepRequirementPathways(stepId, pathways)}
              savingRequirementPathways={saving}
            />
            <CriteriaRail deliverable={working} editable={editable} onEdit={edit} />
          </aside>
        )}
        {desk && phase === "Carry out" && (
          <aside className="workspace-rail workspace-plan-rail">
            <StepRail
              deliverable={working}
              readiness={readiness}
              conditionDefinitions={state.conditionDefinitions}
              editable={editable}
              currentStepId={session?.stepId}
              stepSeconds={session?.stepSeconds}
              canSwitch={Boolean(canSwitch)}
              onSwitchStep={(stepId) => void switchStep(stepId)}
              onEdit={edit}
              timezone={state.settings.timezone}
              compact
              onShowAll={() => setDrawer("steps")}
              onSaveStepRequirementPathways={(stepId, pathways) => saveStepRequirementPathways(stepId, pathways)}
              savingRequirementPathways={saving}
            />
          </aside>
        )}
        {desk && phase === "Review" && (
          <aside className="workspace-rail workspace-plan-rail">
            <CriteriaRail deliverable={working} editable={editable} onEdit={edit} />
          </aside>
        )}
      </div>
      {editable && (
        <WorkspaceActions
          deliverable={working}
          readiness={readiness}
          phase={phase}
          dirty={dirty}
          saving={saving}
          onSave={() => void save()}
          onApprove={() => void approve()}
          onBeginReview={() => void beginReview()}
          onMarkComplete={() => void markComplete()}
        />
      )}
      <WorkspaceSheets
        drawer={drawer}
        connections={<ConnectionsSection itemType="deliverable" itemId={working.id} />}
        onClose={() => setDrawer(null)}
        deliverable={working}
        readiness={readiness}
        engine={engine}
        conditionDefinitions={state.conditionDefinitions}
        projects={state.projects}
        others={state.deliverables}
        timezone={state.settings.timezone}
        editable={editable}
        dirty={dirty}
        saving={saving}
        onSaveStepRequirementPathways={(stepId, pathways) => saveStepRequirementPathways(stepId, pathways)}
        session={session}
        now={now}
        currentStepTitle={currentStep?.title}
        canSwitch={Boolean(canSwitch)}
        planningDecisionCurrent={planningDecisionCurrent}
        continuation={continuation}
        proposals={pendingProposals}
        proposalDrafts={proposalDrafts}
        onEdit={edit}
        onSave={() => void save()}
        onSwitchStep={(stepId) => void switchStep(stepId)}
        onAttach={attachSource}
        onPauseResume={() => void pauseResume()}
        onContinue={() => void continueSession()}
        onFinish={(outcome, note, endedAt) => void finish(outcome, note, endedAt)}
        onProposalChange={onProposalChange}
        onDecideProposal={(proposal, decision) => void reviewProposal(proposal, decision)}
      />
    </main>
  );
}
