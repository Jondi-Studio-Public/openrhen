import { describe, expect, it } from "vitest";
import { entityExtensions } from "./entity-extensions";
import { buildPlanForecastRequest, requestPlanForecast } from "@openrhen/database";
import { activeFocusProjectIds, createSeedState } from "@/state/portal-state";
import { ensureUser } from "./ensure-user";
import {
  daytimeSeed,
  deliverableProposalStore,
  engineToken,
  engineUrl,
  fixedNow,
  setupStateStoreSuite,
  sql,
  store
} from "./state-store-harness";

/**
 * State-store journeys, part 1 of 12.
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

setupStateStoreSuite("openrhen_state_store");

describe("normalized PostgreSQL portal persistence (part 1)", () => {
  // Regression guard for the bug class `NormalizedPostgresStateStore.put()` shipped once: `put()` opens
  // its own transaction and, inside it, calls `persistPlanningEvidence(tx, ...)` → `readPortalState(tx)`
  // → `ensureUser(tx)` — a transaction handle three layers removed from the top-level `sql.begin` call.
  // `ensureUser` unconditionally calling `sql.begin` again there threw
  // `TypeError: sql.begin is not a function` (postgres.js transaction handles have no `.begin`; nested
  // transactions are `tx.savepoint`), and it only ever surfaced on the whole-state write path, not on
  // any of the narrower per-command writes. `beforeEach` truncates `users` before every test in this
  // file, so `put()` here also exercises `ensureUser`'s cold-start create, not just its read.
  it("writes whole state through put()'s own transaction end to end, from a cold database", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const state = await store.get();
    expect(state).not.toBeNull();
    expect(state!.areas.length).toBeGreaterThan(0);
  });

  it("persists versioned weekly focus and makes the current undated project forecastable", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const state = (await store.get())!;
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: state.settings.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(now);
    const date = new Date(`${local}T00:00:00.000Z`);
    const offset = (date.getUTCDay() + 6) % 7;
    const start = new Date(date.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(date.getTime() + (6 - offset) * 86_400_000).toISOString().slice(0, 10);
    const undated = state.projects.find((project) => !project.internalDeadlineAt && !project.externalDeadlineAt)!;
    const saved = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "planning_focus",
      entity: { id: crypto.randomUUID(), kind: "weekly", periodStart: start, periodEnd: end, projectIds: [undated.id] }
    });
    expect(saved.planningFocus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "weekly", periodStart: start, periodEnd: end, projectIds: [undated.id] })
      ])
    );
    expect(activeFocusProjectIds(saved, now)).toContain(undated.id);
  });

  it("persists a deliverable with its contract, steps, prerequisites and blockers as one aggregate", async () => {
    await store.put(createSeedState(fixedNow));
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    const step = (suffix: string, extra: Record<string, unknown> = {}) => ({
      id: `step-${suffix}`,
      title: `Step ${suffix}`,
      status: "planned",
      optimisticMinutes: 20,
      expectedMinutes: 30,
      pessimisticMinutes: 45,
      remainingMinutes: 30,
      energy: "high",
      minimumSessionMinutes: 15,
      maximumSessionMinutes: 60,
      ...extra
    });
    const entity = {
      id,
      projectId: project.id,
      title: "Assessment 2",
      status: "needs_breakdown",
      uncertainty: "some",
      importance: 5,
      consequence: 5,
      steps: [
        step("diagram"),
        step("configure", { dependencyIds: ["step-diagram"], requirementPathways: [["laptop"]] })
      ],
      criteria: [
        {
          key: "connectivity",
          title: "Demonstrate successful connectivity",
          required: true,
          sourceDocument: "Assessment Brief",
          sourceLocation: "Task 3",
          stepIds: ["step-configure"]
        }
      ],
      blockers: [
        {
          id: "blocker-evidence",
          description: "Evidence requirements are unclear",
          category: "missing_information",
          state: "open",
          stepIds: ["step-configure"]
        }
      ]
    };
    const saved = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity
    });
    const deliverable = saved.deliverables.find((item) => item.title === "Assessment 2")!;
    expect(deliverable.steps).toHaveLength(2);
    const configure = deliverable.steps.find((item) => item.title === "Step configure")!;
    const diagram = deliverable.steps.find((item) => item.title === "Step diagram")!;
    expect(configure.dependencyIds).toEqual([diagram.id]);
    expect(configure.requirementPathways[0]?.contextIds).toEqual(["laptop"]);
    expect(deliverable.criteria[0]).toMatchObject({
      key: "connectivity",
      required: true,
      state: "unsatisfied",
      sourceLocation: "Task 3"
    });
    expect(deliverable.criteria[0]?.stepIds).toEqual([configure.id]);
    expect(deliverable.blockers[0]).toMatchObject({ category: "missing_information", state: "open" });
    expect(deliverable.blockers[0]?.stepIds).toEqual([configure.id]);
    // Never approved, so the deliverable is not yet claiming to know how much work it holds.
    expect(deliverable.contractVersion).toBe(0);
    // A second save replaces the children rather than accumulating them.
    const again = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: deliverable.version ?? null,
      type: "save_entity",
      entityType: "deliverable",
      entity: { ...entity, steps: [step("diagram")], criteria: [], blockers: [] }
    });
    const replaced = again.deliverables.find((item) => item.id === deliverable.id)!;
    expect(replaced.steps).toHaveLength(1);
    expect(replaced.criteria).toHaveLength(0);
    expect(replaced.blockers).toHaveLength(0);
  });

  it("keeps extracted contract requirements as source-backed proposals until explicit acceptance", async () => {
    await store.put(createSeedState(fixedNow));
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    const approvedAt = fixedNow.toISOString();
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        id,
        projectId: project.id,
        title: "Assessment 2",
        status: "ready",
        uncertainty: "some",
        importance: 5,
        consequence: 5,
        contractVersion: 1,
        planVersion: 1,
        contractApprovedAt: approvedAt,
        planApprovedAt: approvedAt,
        steps: [
          {
            id: "draft",
            title: "Draft response",
            status: "planned",
            optimisticMinutes: 20,
            expectedMinutes: 30,
            pessimisticMinutes: 45,
            remainingMinutes: 30,
            energy: "low",
            minimumSessionMinutes: 15,
            maximumSessionMinutes: 60
          }
        ],
        criteria: [{ key: "existing", title: "Existing criterion", required: true, stepIds: ["draft"] }]
      }
    });
    const captureCount = state.captures.length;
    const retainedBytes = new TextEncoder().encode("retained assessment source");
    state = await deliverableProposalStore.preview({
      deliverableId: id,
      sourceTitle: "Assessment brief",
      sourceType: "deliverable_upload",
      capturedText: "Task 2: include a labelled diagram",
      contentHash: "source-hash-1",
      files: [
        { filename: "assessment.pdf", mimeType: "application/pdf", bytes: retainedBytes, contentHash: "file-hash-1" }
      ],
      criteria: [
        {
          key: "task-2",
          title: "Include a labelled diagram",
          required: true,
          interpretation: null,
          sourceLocation: "Task 2, page 4",
          expectedEvidence: "A labelled diagram",
          verificationMethod: "llm_inspection",
          notes: null,
          basis: "explicit",
          confidence: "high",
          evidence: ["include a labelled diagram"]
        },
        {
          key: "task-3",
          title: "Explain the addressing choices",
          required: true,
          interpretation: null,
          sourceLocation: "Task 3, page 5",
          expectedEvidence: null,
          verificationMethod: null,
          notes: null,
          basis: "explicit",
          confidence: "medium",
          evidence: ["explain your addressing choices"]
        }
      ]
    });
    const pending = state.deliverables
      .find((item) => item.id === id)!
      .contractProposals.find((item) => item.key === "task-2")!;
    expect(pending).toMatchObject({
      status: "pending",
      key: "task-2",
      sourceDocument: "Assessment brief",
      sourceLocation: "Task 2, page 4",
      basis: "explicit",
      confidence: "high"
    });
    const retained = state.deliverables.find((item) => item.id === id)!.sourceFiles[0]!;
    expect(retained).toMatchObject({
      filename: "assessment.pdf",
      mimeType: "application/pdf",
      byteSize: retainedBytes.byteLength
    });
    await expect(deliverableProposalStore.getFile(retained.id)).resolves.toMatchObject({
      filename: "assessment.pdf",
      mimeType: "application/pdf",
      bytes: retainedBytes
    });
    expect(state.deliverables.find((item) => item.id === id)?.criteria.map((item) => item.key)).toEqual(["existing"]);
    expect(state.captures).toHaveLength(captureCount);

    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: pending.version,
      type: "save_entity",
      entityType: "deliverable_contract_review",
      entity: {
        id: pending.id,
        decision: "confirm",
        criterion: { ...pending, title: "Submit a labelled network diagram" }
      }
    });
    const reviewed = state.deliverables.find((item) => item.id === id)!;
    expect(reviewed.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "task-2",
          title: "Submit a labelled network diagram",
          sourceDocument: "Assessment brief",
          state: "unsatisfied"
        })
      ])
    );
    expect(reviewed.contractProposals.find((item) => item.key === "task-2")?.status).toBe("confirmed");
    expect(reviewed.contractProposals.find((item) => item.key === "task-3")?.status).toBe("pending");
    expect(reviewed.contractApprovedAt).toBeUndefined();
    expect(reviewed.planApprovedAt).toBeUndefined();
    const request = await buildPlanForecastRequest(state, fixedNow);
    expect(request.deliverables.find((item) => item.id === id)?.approved).toBe(false);
  }, 120_000);

  // Sources a feature registers whose captured text is never replayed (none in the OpenRhen export).
  const redactedSources = entityExtensions().flatMap((extension) => extension.textlessSourceTypes ?? []);
  it.each(redactedSources)(
    "never replays a %s source's captured text to the chat or the coordination pack",
    async (sourceType) => {
      await store.put(createSeedState(fixedNow));
      const project = (await store.get())!.projects[0]!;
      const deliverableId = crypto.randomUUID();
      await store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "deliverable",
        entity: {
          id: deliverableId,
          projectId: project.id,
          title: "Permission slip",
          status: "ready",
          uncertainty: "some",
          importance: 5,
          consequence: 5,
          steps: [],
          criteria: []
        }
      });
      const userId = await ensureUser(sql);
      const otherSourceId = crypto.randomUUID();
      const manualSourceId = crypto.randomUUID();
      await sql`INSERT INTO sources (id,user_id,source_type,external_id,title,captured_text,content_hash)
      VALUES (${otherSourceId},${userId},${sourceType},${crypto.randomUUID()},'A parent','Pick up at 3pm',${crypto.randomUUID()})`;
      await sql`INSERT INTO sources (id,user_id,source_type,external_id,title,captured_text,content_hash)
      VALUES (${manualSourceId},${userId},'manual_capture',${crypto.randomUUID()},'Manual note','Bring swimsuit',${crypto.randomUUID()})`;
      await sql`INSERT INTO deliverable_sources (deliverable_id,source_id,role) VALUES
      (${deliverableId},${otherSourceId},'completion_contract'),
      (${deliverableId},${manualSourceId},'completion_contract')`;
      // Give the source a retained file so it still shows up in `chatContext`, which
      // otherwise drops any source with neither captured text nor files.
      await sql`INSERT INTO source_files (source_id,filename,mime_type,byte_size,content_hash,content_base64,sort_order)
      VALUES (${otherSourceId},'note.txt','text/plain',4,${crypto.randomUUID()},'AAAA',0)`;

      const chat = await deliverableProposalStore.chatContext(deliverableId, {
        maxFiles: 10,
        maxTotalBytes: 1_000_000,
        maxTextChars: 1_000
      });
      const otherChatSource = chat.sources.find((source) => source.title === "A parent");
      const manualChatSource = chat.sources.find((source) => source.title === "Manual note");
      expect(otherChatSource?.capturedText).toBeNull();
      expect(manualChatSource?.capturedText).toBe("Bring swimsuit");

      const pack = await deliverableProposalStore.packSources(deliverableId);
      const otherPackSource = pack.find((source) => source.sourceType === sourceType);
      const manualPackSource = pack.find((source) => source.sourceType === "manual_capture");
      expect(otherPackSource?.capturedText).toBeNull();
      expect(manualPackSource?.capturedText).toBe("Bring swimsuit");
    },
    60_000
  );

  // Sweep S2-01: an aggregate save used to delete every step and reinsert it, and
  // `session_segments.step_id` is ON DELETE SET NULL, so each save detached the time already logged.
  it("keeps logged session time attached to a step across a deliverable save, and drops it only with the step", async () => {
    await store.put(createSeedState(fixedNow));
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    const step = (stepId: string, title: string) => ({
      id: stepId,
      title,
      status: "planned",
      optimisticMinutes: 10,
      expectedMinutes: 20,
      pessimisticMinutes: 30,
      remainingMinutes: 20,
      energy: "low",
      minimumSessionMinutes: 10,
      maximumSessionMinutes: 30
    });
    const entity = (steps: ReturnType<typeof step>[]) => ({
      id,
      projectId: project.id,
      title: "Report",
      status: "ready",
      uncertainty: "some",
      importance: 3,
      consequence: 3,
      steps,
      criteria: []
    });
    const save = (steps: ReturnType<typeof step>[], expectedVersion: number | null) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion,
        type: "save_entity",
        entityType: "deliverable",
        entity: entity(steps)
      });
    await save([step("a", "Draft"), step("b", "Review")], null);
    const version = async () =>
      (await sql<{ version: number }[]>`SELECT version FROM deliverables WHERE id=${id}`)[0]!.version;
    const stepRows = () =>
      sql<{ id: string; title: string }[]>`SELECT id,title FROM actions WHERE deliverable_id=${id} ORDER BY sort_order`;
    const [first, second] = await stepRows();
    const userId = await ensureUser(sql);
    const session = await sql<
      { id: string }[]
    >`INSERT INTO sessions (user_id,action_id,target_type,target_id,status,planned_started_at,planned_end_at,started_at,ended_at,planned_minutes,remaining_before_minutes)
      VALUES (${userId},${first!.id},'deliverable',${id},'completed',CURRENT_TIMESTAMP-INTERVAL '1 hour',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP-INTERVAL '1 hour',CURRENT_TIMESTAMP,60,60) RETURNING id`;
    await sql`INSERT INTO session_segments (session_id,started_at,ended_at,step_id) VALUES (${session[0]!.id},CURRENT_TIMESTAMP-INTERVAL '1 hour',CURRENT_TIMESTAMP-INTERVAL '30 minutes',${first!.id}),(${session[0]!.id},CURRENT_TIMESTAMP-INTERVAL '30 minutes',CURRENT_TIMESTAMP,${second!.id})`;
    const attached = () =>
      sql<
        { step_id: string | null }[]
      >`SELECT step_id FROM session_segments WHERE session_id=${session[0]!.id} ORDER BY started_at`;

    await save([step("a", "Draft v2"), step("b", "Review")], await version());
    expect((await stepRows()).map((row) => row.id)).toEqual([first!.id, second!.id]);
    expect((await stepRows())[0]!.title).toBe("Draft v2");
    expect((await attached()).map((row) => row.step_id)).toEqual([first!.id, second!.id]);

    await save([step("a", "Draft v2")], await version());
    expect((await stepRows()).map((row) => row.id)).toEqual([first!.id]);
    expect((await attached()).map((row) => row.step_id)).toEqual([first!.id, null]);

    // A save with no steps at all clears them (an empty kept-list is its own path), and a new save can follow.
    // The session's own action_id has no cascade, so it goes before the step it names.
    await sql`DELETE FROM sessions WHERE id=${session[0]!.id}`;
    await save([], await version());
    expect(await stepRows()).toEqual([]);
    await save([step("a", "Draft v3")], await version());
    expect((await stepRows()).map((row) => row.title)).toEqual(["Draft v3"]);
  }, 60_000);

  it("carries an approved deliverable through the real engine as a directive naming the deliverable, not a step", async () => {
    await store.put(daytimeSeed(fixedNow));
    const state = (await store.get())!;
    const project = state.projects[0]!;
    const id = crypto.randomUUID();
    const entity = {
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
      steps: [
        {
          id: "step-diagram",
          title: "Build the network diagram",
          status: "planned",
          optimisticMinutes: 20,
          expectedMinutes: 30,
          pessimisticMinutes: 45,
          remainingMinutes: 30,
          energy: "low",
          minimumSessionMinutes: 15,
          maximumSessionMinutes: 60
        }
      ],
      criteria: [{ key: "connectivity", title: "Demonstrate connectivity", required: true, stepIds: ["step-diagram"] }]
    };
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity
    });
    const request = await buildPlanForecastRequest((await store.get())!, fixedNow);
    // The projection is built by the request builder, not read out of state by the engine.
    expect(request.deliverables).toHaveLength(1);
    expect(request.deliverables[0]).toMatchObject({
      id,
      approved: true,
      remainingMinutes: 30,
      dependenciesSatisfied: true
    });
    expect(request.deliverables[0]?.executionOptions.map((option) => option.title)).toEqual([
      "Build the network diagram"
    ]);
    const body = await requestPlanForecast({ url: engineUrl, token: engineToken, timeoutMs: 10_000 }, request);
    expect(body.currentDirective.kind).toBe("deliverable");
    if (body.currentDirective.kind !== "deliverable") throw new Error("expected a deliverable directive");
    expect(body.currentDirective.targetId).toBe(id);
    expect(body.currentDirective).not.toHaveProperty("executionOptionTitle");
  }, 30_000);

  it("offers a breakdown session, never zero effort, for an unapproved deliverable", async () => {
    await store.put(createSeedState(fixedNow));
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        id,
        projectId: project.id,
        title: "Assessment 3",
        status: "needs_breakdown",
        uncertainty: "some",
        importance: 5,
        consequence: 5
      }
    });
    const request = await buildPlanForecastRequest((await store.get())!, fixedNow);
    expect(request.deliverables[0]).toMatchObject({
      approved: false,
      remainingMinutes: null,
      minimumUsefulSessionMinutes: null
    });
    expect(request.deliverables[0]?.executionOptions).toEqual([]);
  }, 30_000);
});
