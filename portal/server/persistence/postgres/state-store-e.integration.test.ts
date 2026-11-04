import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { ensureUser } from "./ensure-user";
import { daytimeSeed, fixedNow, sayEnergy, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * State-store journeys, part 5 of 12.
 *
 * One 6,800-line file until 2026-09-10, when it was the integration gate's wall clock: about ten
 * minutes of a fourteen-minute run, so every other file finished long before it and their workers
 * idled. The tests are unchanged and still run in the order they were written; only the file they
 * live in changed. The fixture they share is `./state-store-harness`, and the base name below is
 * what gives this file its own database — no two of these files may share one, or they would
 * truncate each other in `beforeEach`.
 *
 * Split again on 2026-10-30, from four files into twelve, for the same reason: two of the four were
 * the gate's wall clock at about 130 seconds each, and vitest parallelises by file only.
 */

setupStateStoreSuite("openrhen_state_store_e");

describe("normalized PostgreSQL portal persistence (part 5)", () => {
  it("times a deliverable session per step without counting a minute twice", async () => {
    // Seeded at real time: starting a session is only allowed against a current engine result, and
    // capacity anchored to a fixed past instant leaves nothing eligible now.
    const sessionNow = new Date();
    await store.put(daytimeSeed(sessionNow));
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    const step = (key: string, title: string) => ({
      id: key,
      title,
      status: "planned",
      optimisticMinutes: 20,
      expectedMinutes: 30,
      pessimisticMinutes: 45,
      remainingMinutes: 30,
      energy: "low",
      minimumSessionMinutes: 15,
      maximumSessionMinutes: 60
    });
    const afterSave = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        id,
        projectId: project.id,
        title: "Assessment 2",
        status: "in_progress",
        uncertainty: "some",
        importance: 5,
        consequence: 5,
        contractVersion: 1,
        planVersion: 1,
        contractApprovedAt: fixedNow.toISOString(),
        planApprovedAt: fixedNow.toISOString(),
        steps: [step("step-diagram", "Build the diagram"), step("step-explain", "Write the explanation")],
        criteria: [{ key: "c", title: "Connectivity", required: true, stepIds: ["step-diagram", "step-explain"] }]
      }
    });
    expect(afterSave.planning?.result?.currentDirective.kind).toBe("deliverable");
    const normalized = await sql<
      {
        kind: string;
        target_type: string;
        target_id: string | null;
        execution_option_id: string | null;
        primary_action_id: string | null;
      }[]
    >`SELECT kind,target_type,target_id,execution_option_id,primary_action_id FROM recommendations WHERE user_id=(SELECT id FROM users LIMIT 1) AND superseded_at IS NULL`;
    expect(normalized[0]).toMatchObject({
      kind: "deliverable",
      target_type: "deliverable",
      target_id: id,
      primary_action_id: null
    });
    expect(normalized[0]?.execution_option_id).toBeNull();
    const candidates = await sql<
      { target_type: string; target_id: string; execution_option_id: string | null; action_id: string | null }[]
    >`
      SELECT rc.target_type,rc.target_id,rc.execution_option_id,rc.action_id
      FROM recommendation_candidates rc
      JOIN recommendations r ON r.id=rc.recommendation_id
      WHERE r.user_id=(SELECT id FROM users LIMIT 1) AND r.superseded_at IS NULL`;
    expect(candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ target_type: "deliverable", target_id: id, action_id: null })])
    );
    expect(candidates.find((candidate) => candidate.target_type === "deliverable")?.execution_option_id).toBeNull();
    let state = afterSave;
    const deliverable = state.deliverables.find((item) => item.id === id)!;
    const diagram = deliverable.steps.find((item) => item.title === "Build the diagram")!;
    const explain = deliverable.steps.find((item) => item.title === "Write the explanation")!;
    // Start is allowed only against the current engine result, but the engine names the aggregate
    // deliverable rather than an internal step. The workspace chooses a step after opening.
    const directive = state.planning?.result?.currentDirective;
    expect(directive?.kind).toBe("deliverable");
    if (directive?.kind !== "deliverable") throw new Error("expected a deliverable directive");
    expect(directive.targetId).toBe(id);
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: deliverable.version ?? null,
      type: "start_activity",
      targetType: "deliverable",
      targetId: id,
      plannedMinutes: directive.recommendedMinutes
    });
    expect(state.activeSession).toMatchObject({ targetType: "deliverable", targetTitle: "Assessment 2" });
    expect(state.activeSession!.stepId).toBeUndefined();
    // The trail (below) needs slots at or after this moment — the session's own `started_at`,
    // stamped by the command handler, not `sessionNow` above.
    const sessionStartedAt = new Date(state.activeSession!.startedAt);
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "switch_deliverable_step",
      sessionId: state.activeSession!.id,
      stepId: diagram.id
    });
    const other = explain.id;

    // Moving to the next step must close the open segment; two open segments would double-count.
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "switch_deliverable_step",
      sessionId: state.activeSession!.id,
      stepId: other
    });
    expect(state.activeSession?.stepId).toBe(other);
    const openSegments = await sql<
      { count: number }[]
    >`SELECT COUNT(*)::int count FROM session_segments WHERE session_id=${state.activeSession!.id} AND ended_at IS NULL`;
    expect(openSegments[0]?.count).toBe(1);
    const bothSteps = await sql<
      { count: number }[]
    >`SELECT COUNT(DISTINCT step_id)::int count FROM session_segments WHERE session_id=${state.activeSession!.id}`;
    expect(bothSteps[0]?.count).toBe(2);

    // Pausing closes the open segment, so paused time is not work.
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "pause_activity",
      sessionId: state.activeSession!.id
    });
    expect(state.activeSession?.status).toBe("paused");
    const whilePaused = await sql<
      { count: number }[]
    >`SELECT COUNT(*)::int count FROM session_segments WHERE session_id=${state.activeSession!.id} AND ended_at IS NULL`;
    expect(whilePaused[0]?.count).toBe(0);

    // A paused session and its current step survive a reload from persisted state alone.
    const reloaded = (await store.get())!;
    expect(reloaded.activeSession).toMatchObject({ status: "paused", targetType: "deliverable", stepId: other });

    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: reloaded.activeSession?.version ?? null,
      type: "resume_activity",
      sessionId: reloaded.activeSession!.id
    });

    // `unansweredCheckIns`/`lastVerifiedAt` are derived at read time from the check-in trail — see
    // The session reconciliation design note. Three slots time out to `unknown` behind this running
    // session, oldest first.
    const trailUserId = await ensureUser(sql);
    const trailSlotAt = (minutesAfterStart: number) =>
      new Date(sessionStartedAt.getTime() + minutesAfterStart * 60_000);
    const trailCheckIns = await Promise.all(
      [10, 20, 30].map(async (minutesAfterStart) => {
        const slotAt = trailSlotAt(minutesAfterStart);
        const rows = await sql<{ id: string }[]>`
          INSERT INTO check_in (user_id, slot_at, directive_kind, directive_target_id, directive_title, status, answered_at)
          VALUES (${trailUserId}, ${slotAt}, 'deliverable', ${id}, 'Assessment 2', 'unknown', NULL)
          RETURNING id
        `;
        return { id: rows[0]!.id, slotAt };
      })
    );
    let withTrail = (await store.get())!;
    expect(withTrail.activeSession?.unansweredCheckIns).toBe(3);
    // The session has an open segment (resumed above), so the fallback is the segment start, not
    // the session's own `startedAt`.
    expect(withTrail.activeSession?.lastVerifiedAt).toBe(withTrail.activeSession?.segmentStartedAt);

    // Answering the oldest slot `on_track` removes it from the trail and becomes the new verified
    // moment.
    await sql`
      UPDATE check_in SET status='on_track', answered_at=now(), answer_source='session_reconciliation'
      WHERE id=${trailCheckIns[0]!.id}
    `;
    withTrail = (await store.get())!;
    expect(withTrail.activeSession?.unansweredCheckIns).toBe(2);
    expect(withTrail.activeSession?.lastVerifiedAt).toBe(trailCheckIns[0]!.slotAt.toISOString());

    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });
    expect(state.activeSession).toBeNull();

    // The whole-session total is the sum of its segments, never a separate accumulating count.
    const totals = await sql<{ active_minutes: number; segment_seconds: number }[]>`
      SELECT s.active_minutes, COALESCE(SUM(EXTRACT(EPOCH FROM (ss.ended_at-ss.started_at))),0)::int segment_seconds
      FROM sessions s JOIN session_segments ss ON ss.session_id=s.id
      WHERE s.target_id=${id} AND ss.ended_at IS NOT NULL GROUP BY s.active_minutes`;
    expect(totals[0]?.active_minutes).toBe(Math.round((totals[0]?.segment_seconds ?? 0) / 60));
    const finished = (await store.get())!.deliverables.find((item) => item.id === id)!;
    expect(finished.steps.find((item) => item.id === other)?.status).toBe("done");
    expect(finished.lastWorkedAt).toBeDefined();
  }, 120_000);

  // `lastVerifiedAt` used to be computed only for a deliverable
  // session (`readers/sessions.ts`); the pulse resolver's "when last confirmed" needs it for every session
  // target type a check-in can actually be asked about. One `on_track` row per target type is enough
  // to prove the widened query reaches each of them — the deliverable case is already covered above.
  it("populates lastVerifiedAt for an action session, a routine step session and a commitment session", async () => {
    const userId = await ensureUser(sql);
    const insertOnTrack = async (kind: string, targetId: string, startedAt: Date) => {
      const slotAt = new Date(startedAt.getTime() + 10 * 60_000);
      await sql`
        INSERT INTO check_in (user_id, slot_at, directive_kind, directive_target_id, directive_title, status, answered_at)
        VALUES (${userId}, ${slotAt}, ${kind}, ${targetId}, 'Still on it?', 'on_track', now())
      `;
      return slotAt;
    };

    // Action.
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    const action = state.actions[0]!;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "start",
      actionId: action.id,
      plannedMinutes: 15
    });
    const actionSlotAt = await insertOnTrack(
      "action",
      state.activeSession!.targetId ?? state.activeSession!.actionId,
      new Date(state.activeSession!.startedAt)
    );
    state = (await store.get())!;
    expect(state.activeSession?.targetType).toBe("action");
    expect(state.activeSession?.lastVerifiedAt).toBe(actionSlotAt.toISOString());
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });

    // Routine step.
    await store.put(createSeedState(fixedNow));
    state = (await store.get())!;
    const commitment = state.commitments[0]!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_step",
      entity: {
        id: crypto.randomUUID(),
        commitmentId: commitment.id,
        title: "Pack bag",
        durationMinutes: 10,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        contexts: [],
        status: "pending"
      }
    });
    const routineStep = state.routineSteps[0]!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: routineStep.version ?? null,
      type: "start_activity",
      targetType: "routine_step",
      targetId: routineStep.id,
      plannedMinutes: routineStep.durationMinutes
    });
    const routineSlotAt = await insertOnTrack(
      "routine_step",
      state.activeSession!.targetId!,
      new Date(state.activeSession!.startedAt)
    );
    state = (await store.get())!;
    expect(state.activeSession?.targetType).toBe("routine_step");
    expect(state.activeSession?.lastVerifiedAt).toBe(routineSlotAt.toISOString());
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });

    // Commitment (fixed_commitment — the belief kind check-in rows call `protected_commitment`).
    await store.put(createSeedState(fixedNow));
    state = (await store.get())!;
    const disruptionId = crypto.randomUUID();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id: disruptionId,
        title: "Called away",
        startsAt: new Date(fixedNow.getTime() - 30 * 60_000).toISOString(),
        endsAt: new Date(fixedNow.getTime() + 4 * 60 * 60_000).toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        origin: "disruption",
        disruptionSource: "family",
        disruptionOpenEnded: true,
        landedAt: fixedNow.toISOString()
      }
    });
    const disruption = state.commitments.find((item) => item.id === disruptionId)!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: disruption.version ?? null,
      type: "start_activity",
      targetType: "fixed_commitment",
      targetId: disruptionId,
      phase: "active",
      plannedMinutes: 30
    });
    const commitmentSlotAt = await insertOnTrack(
      "protected_commitment",
      state.activeSession!.targetId!,
      new Date(state.activeSession!.startedAt)
    );
    state = (await store.get())!;
    expect(state.activeSession?.targetType).toBe("fixed_commitment");
    expect(state.activeSession?.lastVerifiedAt).toBe(commitmentSlotAt.toISOString());
  }, 30_000);

  it("rolls a running deliverable session onto the next step when the step it is timing is saved done elsewhere", async () => {
    // The deliverable chat's mark_steps_complete tool and the workspace's own step checkbox both mark
    // a step done through this same save_entity command, with no idea whether a session is currently
    // timing that exact step. Completing it here must move a running session onto whatever comes next
    // — the person should never have to notice a stale timer and switch or stop it by hand.
    const sessionNow = new Date();
    await store.put(daytimeSeed(sessionNow));
    await sayEnergy();
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    const step = (key: string, title: string) => ({
      id: key,
      title,
      status: "planned",
      optimisticMinutes: 5,
      expectedMinutes: 10,
      pessimisticMinutes: 15,
      remainingMinutes: 10,
      energy: "low",
      minimumSessionMinutes: 5,
      maximumSessionMinutes: 30
    });
    const afterSave = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        id,
        projectId: project.id,
        title: "Assessment 2 – drawing package",
        status: "in_progress",
        uncertainty: "some",
        importance: 5,
        consequence: 5,
        contractVersion: 1,
        planVersion: 1,
        contractApprovedAt: sessionNow.toISOString(),
        planApprovedAt: sessionNow.toISOString(),
        steps: [step("step-zip", "Create and verify the ZIP package"), step("step-submit", "Submit the final package")],
        criteria: [{ key: "c", title: "Package submitted", required: true, stepIds: ["step-zip", "step-submit"] }]
      }
    });
    let state = afterSave;
    const deliverable = state.deliverables.find((item) => item.id === id)!;
    const zipStep = deliverable.steps.find((item) => item.title === "Create and verify the ZIP package")!;
    const submitStep = deliverable.steps.find((item) => item.title === "Submit the final package")!;
    const directive = state.planning?.result?.currentDirective;
    if (directive?.kind !== "deliverable") throw new Error("expected a deliverable directive");

    // The person starts a Now/Today session on the ZIP step.
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: deliverable.version ?? null,
      type: "start_activity",
      targetType: "deliverable",
      targetId: id,
      plannedMinutes: directive.recommendedMinutes,
      stepId: zipStep.id
    });
    const session = state.activeSession!;
    expect(session.stepId).toBe(zipStep.id);

    // Independently — the deliverable chat's completion tool, or the workspace checkbox — the ZIP step
    // is recorded done while the session above is still open and still tracking that step.
    const midway = state.deliverables.find((item) => item.id === id)!;
    const afterComplete = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: midway.version ?? null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        ...midway,
        steps: midway.steps.map((item) =>
          item.id === zipStep.id
            ? { ...item, status: "done", remainingMinutes: 0, completedAt: sessionNow.toISOString() }
            : item
        )
      }
    });

    // The very same save already rolled the session onto the submit step — the ZIP step's own
    // completion never had to wait for anyone to notice and switch by hand.
    expect(afterComplete.activeSession).toMatchObject({ id: session.id, status: "running", stepId: submitStep.id });
    const rolledDeliverable = afterComplete.deliverables.find((item) => item.id === id)!;
    expect(rolledDeliverable.steps.find((item) => item.id === zipStep.id)?.status).toBe("done");
    expect(rolledDeliverable.steps.find((item) => item.id === submitStep.id)?.status).toBe("doing");

    // Exactly one open segment, on the new step — the rollover closed the old one instead of doubling up.
    const openSegments = await sql<
      { step_id: string | null }[]
    >`SELECT step_id FROM session_segments WHERE session_id=${session.id} AND ended_at IS NULL`;
    expect(openSegments).toHaveLength(1);
    expect(openSegments[0]?.step_id).toBe(submitStep.id);

    // Finishing from here credits time to both steps actually worked and leaves the ZIP step, already
    // done, untouched.
    const finished = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: afterComplete.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    expect(finished.activeSession).toBeNull();
    const finalDeliverable = finished.deliverables.find((item) => item.id === id)!;
    expect(finalDeliverable.steps.find((item) => item.id === zipStep.id)?.status).toBe("done");
    expect(finalDeliverable.steps.find((item) => item.id === submitStep.id)?.status).toBe("done");
  }, 30_000);

  it("stops a running deliverable session automatically when the step it is timing was the last one left", async () => {
    const sessionNow = new Date();
    await store.put(daytimeSeed(sessionNow));
    await sayEnergy();
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    const afterSave = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        id,
        projectId: project.id,
        title: "Assessment 3 – single step",
        status: "in_progress",
        uncertainty: "some",
        importance: 5,
        consequence: 5,
        contractVersion: 1,
        planVersion: 1,
        contractApprovedAt: sessionNow.toISOString(),
        planApprovedAt: sessionNow.toISOString(),
        steps: [
          {
            id: "step-only",
            title: "The only step",
            status: "planned",
            optimisticMinutes: 5,
            expectedMinutes: 10,
            pessimisticMinutes: 15,
            remainingMinutes: 10,
            energy: "low",
            minimumSessionMinutes: 5,
            maximumSessionMinutes: 30
          }
        ],
        criteria: [{ key: "c", title: "Done", required: true, stepIds: ["step-only"] }]
      }
    });
    let state = afterSave;
    const deliverable = state.deliverables.find((item) => item.id === id)!;
    const onlyStep = deliverable.steps[0]!;
    const directive = state.planning?.result?.currentDirective;
    if (directive?.kind !== "deliverable") throw new Error("expected a deliverable directive");
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: deliverable.version ?? null,
      type: "start_activity",
      targetType: "deliverable",
      targetId: id,
      plannedMinutes: directive.recommendedMinutes,
      stepId: onlyStep.id
    });
    const session = state.activeSession!;

    const midway = state.deliverables.find((item) => item.id === id)!;
    const afterComplete = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: midway.version ?? null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        ...midway,
        steps: midway.steps.map((item) => ({
          ...item,
          status: "done",
          remainingMinutes: 0,
          completedAt: sessionNow.toISOString()
        }))
      }
    });

    // Nothing left to roll into: the session ends on its own rather than sitting open, pointed at a
    // step with no work left, waiting for the person to notice and stop it.
    expect(afterComplete.activeSession).toBeNull();
    const finalStep = afterComplete.deliverables.find((item) => item.id === id)!.steps[0]!;
    expect(finalStep.status).toBe("done");
    const sessionRow = await sql<{ status: string }[]>`SELECT status FROM sessions WHERE id=${session.id}`;
    expect(sessionRow[0]?.status).toBe("completed");
  }, 30_000);

  it("does not reopen a step already completed elsewhere when a paused session finishes as blocked", async () => {
    // A running session rolls forward on its own (see above); a paused one has no open segment to roll
    // and is left for the person to resolve by hand. If the step it was pointed at is completed
    // elsewhere while it sits paused, finishing it later must not revert that completion — and must
    // not be read as "that step is blocked" either. The person meant "I'm blocked now, on what's
    // next", not "undo that earlier step".
    const sessionNow = new Date();
    await store.put(daytimeSeed(sessionNow));
    await sayEnergy();
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    const step = (key: string, title: string) => ({
      id: key,
      title,
      status: "planned",
      optimisticMinutes: 5,
      expectedMinutes: 10,
      pessimisticMinutes: 15,
      remainingMinutes: 10,
      energy: "low",
      minimumSessionMinutes: 5,
      maximumSessionMinutes: 30
    });
    const afterSave = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        id,
        projectId: project.id,
        title: "Assessment 2 – drawing package (paused)",
        status: "in_progress",
        uncertainty: "some",
        importance: 5,
        consequence: 5,
        contractVersion: 1,
        planVersion: 1,
        contractApprovedAt: sessionNow.toISOString(),
        planApprovedAt: sessionNow.toISOString(),
        steps: [step("step-zip", "Create and verify the ZIP package"), step("step-submit", "Submit the final package")],
        criteria: [{ key: "c", title: "Package submitted", required: true, stepIds: ["step-zip", "step-submit"] }]
      }
    });
    let state = afterSave;
    const deliverable = state.deliverables.find((item) => item.id === id)!;
    const zipStep = deliverable.steps.find((item) => item.title === "Create and verify the ZIP package")!;
    const directive = state.planning?.result?.currentDirective;
    if (directive?.kind !== "deliverable") throw new Error("expected a deliverable directive");

    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: deliverable.version ?? null,
      type: "start_activity",
      targetType: "deliverable",
      targetId: id,
      plannedMinutes: directive.recommendedMinutes,
      stepId: zipStep.id
    });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "pause_activity",
      sessionId: state.activeSession!.id
    });
    const session = state.activeSession!;
    expect(session.status).toBe("paused");

    // Independently, the ZIP step is recorded done while the session above sits paused and still
    // pointed at it.
    const midway = state.deliverables.find((item) => item.id === id)!;
    const afterComplete = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: midway.version ?? null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        ...midway,
        steps: midway.steps.map((item) =>
          item.id === zipStep.id
            ? { ...item, status: "done", remainingMinutes: 0, completedAt: sessionNow.toISOString() }
            : item
        )
      }
    });
    // A paused session is left alone: no rollover, and its version is untouched by the save above.
    expect(afterComplete.activeSession).toMatchObject({ id: session.id, status: "paused", stepId: zipStep.id });

    // The person then finishes the paused session by reporting they are blocked, meaning blocked in
    // general — not that the ZIP step un-happened.
    await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: session.version ?? null,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "blocked"
    });

    const finished = (await store.get())!.deliverables.find((item) => item.id === id)!;
    const finishedZipStep = finished.steps.find((item) => item.id === zipStep.id)!;
    expect(finishedZipStep.status).toBe("done");
    expect(finishedZipStep.completedAt).toBeDefined();
  }, 30_000);

  it("never starts a session on its own when a step is completed with none already running", async () => {
    // Rolling forward is only for time already being tracked. Marking a step done with no session open
    // must not spontaneously start one — that would credit time nobody asked to spend.
    const sessionNow = new Date();
    await store.put(daytimeSeed(sessionNow));
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    const step = (key: string, title: string) => ({
      id: key,
      title,
      status: "planned",
      optimisticMinutes: 5,
      expectedMinutes: 10,
      pessimisticMinutes: 15,
      remainingMinutes: 10,
      energy: "low",
      minimumSessionMinutes: 5,
      maximumSessionMinutes: 30
    });
    const afterSave = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        id,
        projectId: project.id,
        title: "Assessment 2 – no session yet",
        status: "in_progress",
        uncertainty: "some",
        importance: 5,
        consequence: 5,
        contractVersion: 1,
        planVersion: 1,
        contractApprovedAt: sessionNow.toISOString(),
        planApprovedAt: sessionNow.toISOString(),
        steps: [step("step-zip", "Create and verify the ZIP package"), step("step-submit", "Submit the final package")],
        criteria: [{ key: "c", title: "Package submitted", required: true, stepIds: ["step-zip", "step-submit"] }]
      }
    });
    expect(afterSave.activeSession).toBeNull();
    const deliverable = afterSave.deliverables.find((item) => item.id === id)!;
    const zipStep = deliverable.steps.find((item) => item.title === "Create and verify the ZIP package")!;

    const afterComplete = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: deliverable.version ?? null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        ...deliverable,
        steps: deliverable.steps.map((item) =>
          item.id === zipStep.id
            ? { ...item, status: "done", remainingMinutes: 0, completedAt: sessionNow.toISOString() }
            : item
        )
      }
    });
    expect(afterComplete.activeSession).toBeNull();
    expect(
      afterComplete.deliverables.find((item) => item.id === id)?.steps.find((item) => item.id === zipStep.id)?.status
    ).toBe("done");
  }, 30_000);

  it("refuses more work once the engine allocation is spent", async () => {
    const sessionNow = new Date();
    await store.put(daytimeSeed(sessionNow));
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    const step = (key: string, title: string) => ({
      id: key,
      title,
      status: "planned",
      optimisticMinutes: 20,
      expectedMinutes: 30,
      pessimisticMinutes: 45,
      remainingMinutes: 30,
      energy: "low",
      minimumSessionMinutes: 15,
      maximumSessionMinutes: 60
    });
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        id,
        projectId: project.id,
        title: "Assessment 4",
        status: "in_progress",
        uncertainty: "some",
        importance: 5,
        consequence: 5,
        contractVersion: 1,
        planVersion: 1,
        contractApprovedAt: sessionNow.toISOString(),
        planApprovedAt: sessionNow.toISOString(),
        steps: [step("step-a", "Draft"), step("step-b", "Revise")],
        criteria: [{ key: "c", title: "Complete", required: true, stepIds: ["step-a", "step-b"] }]
      }
    });
    let state = (await store.get())!;
    const directive = state.planning?.result?.currentDirective;
    if (directive?.kind !== "deliverable") throw new Error("expected a deliverable directive");
    const deliverable = state.deliverables.find((item) => item.id === id)!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: deliverable.version ?? null,
      type: "start_activity",
      targetType: "deliverable",
      targetId: id,
      plannedMinutes: directive.recommendedMinutes,
      stepId: deliverable.steps[0]!.id
    });
    const session = state.activeSession!;
    // Drive the clock past the allocation rather than waiting it out.
    await sql`UPDATE sessions SET planned_end_at=${new Date(Date.now() - 60_000)} WHERE id=${session.id}`;
    const other = deliverable.steps[1]!.id;
    await expect(
      store.runActivityCommand({
        commandId: crypto.randomUUID(),
        expectedVersion: session.version ?? null,
        type: "switch_deliverable_step",
        sessionId: session.id,
        stepId: other
      })
    ).rejects.toThrow("checkpoint");
    // Pausing stays available, because it stops the clock rather than continuing it.
    const paused = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: session.version ?? null,
      type: "pause_activity",
      sessionId: session.id
    });
    expect(paused.activeSession?.status).toBe("paused");
    await expect(
      store.runActivityCommand({
        commandId: crypto.randomUUID(),
        expectedVersion: paused.activeSession?.version ?? null,
        type: "resume_activity",
        sessionId: session.id
      })
    ).rejects.toThrow("checkpoint");
    const stopped = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: paused.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "stopped"
    });
    expect(stopped.activeSession).toBeNull();
  }, 120_000);
});
