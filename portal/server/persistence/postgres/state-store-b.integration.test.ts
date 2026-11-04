import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * State-store journeys, part 2 of 12.
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

setupStateStoreSuite("openrhen_state_store_b");

describe("normalized PostgreSQL portal persistence (part 2)", () => {
  it("round-trips the per-tool AI model settings, leaving fields another page owns untouched", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    expect(state.settings.deliverableChatModel).toBeUndefined();
    expect(state.settings.importExtractorModel).toBeUndefined();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: {
        deliverableChatModel: "gpt-5",
        importExtractorModel: "gpt-4.1-mini-custom"
      }
    });
    expect(state.settings.deliverableChatModel).toBe("gpt-5");
    expect(state.settings.importExtractorModel).toBe("gpt-4.1-mini-custom");
    // A save that omits every AI field — the buffers page, say — leaves both exactly as they were.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { arrivalMarginMinutes: 5 }
    });
    expect(state.settings.deliverableChatModel).toBe("gpt-5");
    expect(state.settings.importExtractorModel).toBe("gpt-4.1-mini-custom");
    // An empty string is how the AI settings page reports "back to Default".
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { deliverableChatModel: "" }
    });
    expect(state.settings.deliverableChatModel).toBeUndefined();
    expect(state.settings.importExtractorModel).toBe("gpt-4.1-mini-custom");
  });

  it("round-trips the session break setting", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    expect(state.settings.sessionBreakMinutes).toBe(15);
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { sessionBreakMinutes: 20 }
    });
    expect(state.settings.sessionBreakMinutes).toBe(20);
    // A save that omits it leaves it exactly as it was.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { arrivalMarginMinutes: 5 }
    });
    expect(state.settings.sessionBreakMinutes).toBe(20);
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "settings",
        entity: { sessionBreakMinutes: 150 }
      })
    ).rejects.toThrow(/[Ss]ession break/);
  });

  it("stores quiet one-off places and archives only the ones nothing upcoming refers to", async () => {
    await store.put(createSeedState(fixedNow));
    const pastPlaceId = crypto.randomUUID();
    const futurePlaceId = crypto.randomUUID();
    const freshPlaceId = crypto.randomUUID();
    const place = (id: string, name: string) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "condition_definition",
        entity: { id, name, kind: "location", oneOff: true, latitude: -36.12, longitude: 146.89, address: name }
      });
    await place(pastPlaceId, "Dentist, Riverside VIC");
    await place(futurePlaceId, "Interview, Elmwood NY");
    let state = await place(freshPlaceId, "Abandoned search");
    expect(state.conditionDefinitions.find((entry) => entry.id === pastPlaceId)).toMatchObject({
      oneOff: true,
      status: "active"
    });
    // An ordinary place save leaves the flag off.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id: "plain-place", name: "Plain place", kind: "location", latitude: -36.1, longitude: 146.9 }
    });
    expect(state.conditionDefinitions.find((entry) => entry.id === "plain-place")?.oneOff).toBeUndefined();
    const commitment = (id: string, title: string, locationId: string, offsetHours: number) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "commitment",
        entity: {
          id,
          title,
          startsAt: new Date(fixedNow.getTime() + offsetHours * 3_600_000).toISOString(),
          endsAt: new Date(fixedNow.getTime() + (offsetHours + 1) * 3_600_000).toISOString(),
          status: "confirmed",
          location: title,
          locationId,
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      });
    state = await commitment("dentist-checkup", "Checkup", pastPlaceId, -3);
    state = await commitment("elmwood-interview", "Interview", futurePlaceId, 2);
    expect(state.commitments.find((entry) => entry.title === "Checkup")?.locationId).toBe(pastPlaceId);
    expect(state.commitments.find((entry) => entry.title === "Interview")?.locationId).toBe(futurePlaceId);
    // The dentist and interview places are old enough for housekeeping; the abandoned one is not,
    // which is the grace that keeps a place from being archived between its creation and the save
    // of the commitment that references it.
    await sql`UPDATE condition_definitions SET created_at=created_at-INTERVAL '2 hours' WHERE id IN ${sql([
      pastPlaceId,
      futurePlaceId
    ])}`;
    // Any write replans, and the forecast persist runs the archive pass alongside the routine sync.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "capture",
      entity: { id: crypto.randomUUID(), text: "Trigger a replan", status: "pending" }
    });
    const statuses = new Map(state.conditionDefinitions.map((entry) => [entry.id, entry.status]));
    expect(statuses.get(pastPlaceId)).toBe("archived");
    expect(statuses.get(futurePlaceId)).toBe("active");
    expect(statuses.get(freshPlaceId)).toBe("active");
  });

  it("confirms a reviewed capture and creates its action atomically", async () => {
    await store.put(createSeedState(fixedNow));
    const captureId = crypto.randomUUID();
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "capture",
      entity: {
        id: captureId,
        text: "Draft the report",
        createdAt: fixedNow.toISOString(),
        status: "pending",
        proposalType: "unclassified",
        proposedFields: {},
        sourceType: "manual_capture"
      }
    });
    const capture = state.captures.find((item) => item.id === captureId)!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: capture.version ?? null,
      type: "save_entity",
      entityType: "capture_review",
      entity: {
        id: captureId,
        proposalType: "action",
        draft: {
          title: "Draft the report",
          projectId: state.projects[0]!.id,
          expectedMinutes: 30,
          pessimisticMinutes: 45,
          energy: "medium"
        }
      }
    });
    expect(state.captures.find((item) => item.id === captureId)?.status).toBe("confirmed");
    expect(state.actions.find((item) => item.id === captureId)?.title).toBe("Draft the report");
  });

  it("sends a Someday item back to review and refuses to reopen a confirmed action", async () => {
    await store.put(createSeedState(fixedNow));
    const captureId = async (text: string) => {
      const id = crypto.randomUUID();
      const created = await store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "capture",
        entity: {
          id,
          text,
          createdAt: fixedNow.toISOString(),
          status: "pending",
          proposalType: "unclassified",
          proposedFields: {},
          sourceType: "manual_capture"
        }
      });
      return { id, version: created.captures.find((item) => item.id === id)!.version ?? null };
    };
    const review = async (
      capture: { id: string; version: number | null },
      proposalType: string,
      draft: Record<string, unknown>
    ) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: capture.version,
        type: "save_entity",
        entityType: "capture_review",
        entity: { id: capture.id, proposalType, draft }
      });
    const reopen = (id: string, version: number | null, proposalType: string) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: version,
        type: "save_entity",
        entityType: "capture",
        entity: { id, status: "pending", proposalType, proposedFields: { title: "Learn the cello" } }
      });

    const someday = await captureId("Learn the cello");
    let state = await review(someday, "someday", { title: "Learn the cello" });
    let kept = state.captures.find((item) => item.id === someday.id)!;
    expect(kept).toMatchObject({ status: "confirmed", proposalType: "someday" });
    state = await reopen(someday.id, kept.version ?? null, "someday");
    kept = state.captures.find((item) => item.id === someday.id)!;
    expect(kept.status).toBe("pending");
    expect(kept.reviewedAt).toBeUndefined();
    // Back in review, it confirms as real work under its own id like any fresh proposal.
    const projectId = state.projects[0]!.id;
    state = await review({ id: someday.id, version: kept.version ?? null }, "action", {
      title: "Learn the cello",
      projectId,
      expectedMinutes: 30,
      pessimisticMinutes: 45,
      energy: "medium"
    });
    expect(state.actions.find((item) => item.id === someday.id)?.title).toBe("Learn the cello");

    const action = await captureId("Book the tuner");
    state = await review(action, "action", {
      title: "Book the tuner",
      projectId,
      expectedMinutes: 30,
      pessimisticMinutes: 45,
      energy: "medium"
    });
    const confirmed = state.captures.find((item) => item.id === action.id)!;
    await expect(reopen(action.id, confirmed.version ?? null, "action")).rejects.toThrow(
      "Only a Someday or Reference item can go back to review."
    );
  });

  it("restores a replaced proposal to pending, and refuses to restore anything that is not replaced", async () => {
    await store.put(createSeedState(fixedNow));
    const create = async (text: string) => {
      const id = crypto.randomUUID();
      await store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "capture",
        entity: {
          id,
          text,
          createdAt: fixedNow.toISOString(),
          status: "pending",
          proposalType: "unclassified",
          proposedFields: { title: text },
          sourceType: "manual_capture"
        }
      });
      return id;
    };
    const restore = async (id: string) => {
      const current = (await store.get())!.captures.find((item) => item.id === id)!;
      return store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: current.version ?? null,
        type: "save_entity",
        entityType: "capture",
        entity: { id, status: "pending", proposalType: current.proposalType, proposedFields: {}, restore: true }
      });
    };
    const setStatus = (id: string, status: string) =>
      sql`UPDATE captures SET status=${status}, reviewed_at=CURRENT_TIMESTAMP, version=version+1 WHERE id=${id}`;

    const replaced = await create("Replaced by the reasoner");
    await setStatus(replaced, "superseded");
    const state = await restore(replaced);
    const back = state.captures.find((item) => item.id === replaced)!;
    expect(back.status).toBe("pending");
    expect(back.reviewedAt).toBeUndefined();
    // The stored fields are the server's own, not the client's copy.
    expect(back.proposedFields).toMatchObject({ title: "Replaced by the reasoner" });

    for (const status of ["pending", "confirmed", "ignored"]) {
      const id = await create(`A ${status} one`);
      if (status !== "pending") await setStatus(id, status);
      await expect(restore(id)).rejects.toThrow("Only a replaced proposal can be restored.");
      expect((await store.get())!.captures.find((item) => item.id === id)?.status).toBe(status);
    }
  });

  it("confirms a deliverable proposal, creates the deliverable and links its source", async () => {
    await store.put(createSeedState(fixedNow));
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "capture",
      entity: {
        id: crypto.randomUUID(),
        text: "Assessment 3 due next Friday",
        createdAt: fixedNow.toISOString(),
        status: "pending",
        proposalType: "unclassified",
        proposedFields: { suggestedShape: "deliverable" },
        sourceType: "email"
      }
    });
    const captureId = state.captures.find((item) => item.text === "Assessment 3 due next Friday")!.id;
    const capture = state.captures.find((item) => item.id === captureId)!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: capture.version ?? null,
      type: "save_entity",
      entityType: "capture_review",
      entity: {
        id: captureId,
        proposalType: "deliverable",
        draft: {
          title: "Assessment 3",
          projectId: state.projects[0]!.id,
          externalDeadlineAt: new Date(fixedNow.getTime() + 7 * 86_400_000).toISOString(),
          notes: "Covers modules 4-6."
        }
      }
    });
    expect(state.captures.find((item) => item.id === captureId)?.status).toBe("confirmed");
    const deliverable = state.deliverables.find((item) => item.id === captureId)!;
    expect(deliverable).toMatchObject({
      title: "Assessment 3",
      status: "needs_breakdown",
      projectId: state.projects[0]!.id,
      details: "Covers modules 4-6."
    });
    const sourceLink = await sql`
      SELECT ds.role FROM deliverable_sources ds
      JOIN captures p ON p.source_id = ds.source_id
      WHERE ds.deliverable_id = ${captureId} AND p.id = ${captureId}
    `;
    expect(sourceLink[0]?.role).toBe("email");
  });

  it("holds a proposal with open questions until each is answered, then applies the answers", async () => {
    await store.put(createSeedState(fixedNow));
    const captureId = crypto.randomUUID();
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "capture",
      entity: {
        id: captureId,
        text: "Draft the report",
        createdAt: fixedNow.toISOString(),
        status: "pending",
        proposalType: "unclassified",
        proposedFields: {},
        sourceType: "manual_capture",
        questions: [{ field: "projectId", question: "Which project?", suggestions: ["A", "B"] }]
      }
    });
    const stored = state.captures.find((item) => item.id === captureId)!;
    expect(stored.questions).toEqual([{ field: "projectId", question: "Which project?", suggestions: ["A", "B"] }]);
    const confirm = (answers?: Record<string, string>) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: stored.version ?? null,
        type: "save_entity",
        entityType: "capture_review",
        entity: {
          id: captureId,
          proposalType: "action",
          draft: { title: "Draft the report", expectedMinutes: 30, pessimisticMinutes: 45, energy: "medium" },
          ...(answers ? { answers } : {})
        }
      });
    await expect(confirm()).rejects.toThrow(/Which project\?/);
    await expect(confirm({ projectId: "  " })).rejects.toThrow(/Which project\?/);
    state = await confirm({ projectId: state.projects[0]!.id });
    const done = state.captures.find((item) => item.id === captureId)!;
    expect(done.status).toBe("confirmed");
    expect(done.questions?.[0]).toMatchObject({ field: "projectId", answer: state.projects[0]!.id });
    expect(state.actions.some((action) => action.title === "Draft the report")).toBe(true);
  });

  it("refuses to confirm a deliverable proposal with no valid project", async () => {
    await store.put(createSeedState(fixedNow));
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "capture",
      entity: {
        id: crypto.randomUUID(),
        text: "Assessment due soon",
        createdAt: fixedNow.toISOString(),
        status: "pending",
        proposalType: "unclassified",
        proposedFields: {},
        sourceType: "email"
      }
    });
    const captureId = state.captures.find((item) => item.text === "Assessment due soon")!.id;
    const capture = state.captures.find((item) => item.id === captureId)!;
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: capture.version ?? null,
        type: "save_entity",
        entityType: "capture_review",
        entity: {
          id: captureId,
          proposalType: "deliverable",
          draft: { title: "Assessment", projectId: "not-a-real-project" }
        }
      })
    ).rejects.toThrow(/Project "not-a-real-project" no longer exists/);
  });

  it("persists session segments, excludes paused time, survives reload and records progress", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    const action = state.actions[0]!;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "start",
      actionId: action.id,
      plannedMinutes: 30
    });
    const session = state.activeSession!;
    expect(session.status).toBe("running");
    await sql`UPDATE session_segments SET started_at=CURRENT_TIMESTAMP-INTERVAL '10 minutes' WHERE session_id=${session.id} AND ended_at IS NULL`;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: session.version ?? null,
      type: "pause",
      sessionId: session.id
    });
    expect(state.activeSession?.status).toBe("paused");
    expect(state.activeSession?.activeElapsedSeconds).toBeGreaterThanOrEqual(599);
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "resume",
      sessionId: session.id
    });
    await sql`UPDATE session_segments SET started_at=CURRENT_TIMESTAMP-INTERVAL '5 minutes' WHERE session_id=${session.id} AND ended_at IS NULL`;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "request_feedback",
      sessionId: session.id
    });
    expect((await store.get())?.activeSession?.status).toBe("feedback");
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish",
      sessionId: session.id,
      outcome: "progress",
      remainingMinutes: 45
    });
    expect(state.activeSession).toBeNull();
    expect(state.completedToday.at(-1)).toMatchObject({
      result: "stopped",
      remainingAfterMinutes: 45,
      segmentCount: 2,
      activeMinutes: 15
    });
  });

  it("returns the same result for a repeated command id", async () => {
    await store.put(createSeedState(fixedNow));
    const action = (await store.get())!.actions[0]!;
    const commandId = crypto.randomUUID();
    const first = await store.runSessionCommand({
      commandId,
      expectedVersion: action.version ?? null,
      type: "start",
      actionId: action.id,
      plannedMinutes: 15
    });
    const repeated = await store.runSessionCommand({
      commandId,
      expectedVersion: action.version ?? null,
      type: "start",
      actionId: action.id,
      plannedMinutes: 15
    });
    expect(repeated.activeSession?.id).toBe(first.activeSession?.id);
  });
  it("migrates a legacy snapshot into normalized records once", async () => {
    const seed = createSeedState(fixedNow);
    await sql`INSERT INTO portal_state (id, state_json) VALUES (1, ${sql.json(seed as never)})`;

    const loaded = await store.get();
    expect(loaded?.projects.map((project) => project.title)).toEqual(seed.projects.map((project) => project.title));
    expect(loaded?.actions.map((action) => action.title)).toEqual(seed.actions.map((action) => action.title));
    expect(loaded?.projects[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);

    const counts = await sql<{ legacy: number; areas: number; outcomes: number; projects: number; actions: number }[]>`
      SELECT
        (SELECT count(*)::int FROM portal_state) AS legacy,
        (SELECT count(*)::int FROM areas) AS areas,
        (SELECT count(*)::int FROM outcomes) AS outcomes,
        (SELECT count(*)::int FROM projects) AS projects,
        (SELECT count(*)::int FROM actions) AS actions
    `;
    expect(counts[0]).toMatchObject({ legacy: 0, areas: 2, outcomes: 2, projects: 2, actions: 2 });
  });

  it("saves, updates, and reloads normalized state with stable identifiers", async () => {
    await store.put(createSeedState(fixedNow));
    const first = await store.get();
    expect(first).not.toBeNull();

    const updated: PortalState = {
      ...first!,
      actions: first!.actions.map((action, index) =>
        index === 0
          ? { ...action, remainingMinutes: 55 }
          : index === 1
            ? { ...action, dependencyIds: [first!.actions[0]!.id] }
            : action
      ),
      commitments: first!.commitments.map((commitment, index) =>
        index === 0
          ? { ...commitment, location: "Kitchen", setupBeforeMinutes: 5, transitionAfterMinutes: 15 }
          : commitment
      ),
      captures: [
        {
          id: "capture-integration-test",
          text: "Networking assignment due next Friday",
          createdAt: fixedNow.toISOString(),
          status: "ignored",
          proposalType: "reference",
          proposedFields: { title: "Networking assignment source note" },
          sourceType: "manual_capture",
          sourceLink: "https://example.test/source",
          confidence: 0.8,
          reviewedAt: new Date(fixedNow.getTime() + 60_000).toISOString()
        }
      ],
      settings: {
        ...first!.settings,
        timezone: "Australia/Perth",
        planningHorizonEnd: "21:30",
        defaultUsableFraction: 0.8,
        defaultSetupBufferMinutes: 15,
        defaultTransitionBufferMinutes: 20,
        submissionBufferMinutes: 90,
        submissionBufferPercent: 0.15,
        energyMeanings: { ...first!.settings.energyMeanings, high: "Complex assignment work" },
        estimateBucketsMinutes: [10, 20, 45, 90, 180]
      },
      assertedConditions: ["home", "laptop", "quiet"]
    };
    await store.put(updated);
    const second = await store.get();

    expect(second?.projects.map((project) => project.id)).toEqual(first?.projects.map((project) => project.id));
    expect(second?.actions.map((action) => action.id)).toEqual(first?.actions.map((action) => action.id));
    expect(second?.actions[0]?.remainingMinutes).toBe(55);
    expect(second?.areas.map((area) => area.name)).toEqual(first?.areas.map((area) => area.name));
    expect(second?.outcomes.map((outcome) => outcome.definitionOfDone)).toEqual(
      first?.outcomes.map((outcome) => outcome.definitionOfDone)
    );
    expect(second?.actions[1]?.dependencyIds).toEqual([second?.actions[0]?.id]);
    expect(second?.commitments[0]).toMatchObject({
      status: "confirmed",
      location: "Kitchen",
      setupBeforeMinutes: 5,
      transitionAfterMinutes: 15
    });
    expect(second?.captures[0]).toMatchObject({
      text: "Networking assignment due next Friday",
      status: "ignored",
      proposalType: "reference",
      proposedFields: { title: "Networking assignment source note" },
      sourceType: "manual_capture",
      sourceLink: "https://example.test/source",
      confidence: 0.8
    });
    expect(second?.captures[0]?.reviewedAt).toBe(new Date(fixedNow.getTime() + 60_000).toISOString());
    expect(second?.settings).toMatchObject({
      timezone: "Australia/Perth",
      planningHorizonEnd: "21:30",
      defaultUsableFraction: 0.8,
      defaultSetupBufferMinutes: 15,
      defaultTransitionBufferMinutes: 20,
      submissionBufferMinutes: 90,
      submissionBufferPercent: 0.15,
      energyMeanings: { high: "Complex assignment work" },
      estimateBucketsMinutes: [10, 20, 45, 90, 180]
    });
    expect(second?.assertedConditions).toEqual(["home", "laptop", "quiet"]);
  });

  it("persists a paused session and its remaining timer across reload", async () => {
    const state = createSeedState(fixedNow);
    state.activeSession = {
      id: "paused-session",
      actionId: state.actions[0]!.id,
      status: "paused",
      startedAt: fixedNow.toISOString(),
      plannedEndAt: new Date(fixedNow.getTime() + 50 * 60_000).toISOString(),
      plannedMinutes: 50,
      remainingBeforeMinutes: state.actions[0]!.remainingMinutes,
      activeElapsedSeconds: 11 * 60,
      pausedRemainingSeconds: 1_440
    };
    await store.put(state);

    const loaded = await store.get();
    expect(loaded?.activeSession).toMatchObject({
      status: "paused",
      pausedRemainingSeconds: 1_440,
      activeElapsedSeconds: 660,
      plannedMinutes: 50
    });
    expect(loaded?.activeSession?.actionId).toBe(loaded?.actions[0]?.id);
  });
});
