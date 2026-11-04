import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { parseImportCsv } from "@/features/imports/import-csv";
import { parseImportWorkbook } from "@/features/imports/import-xlsx";
import {
  createReferencePackWorkbook,
  referenceKeyCandidates,
  selectReferencePack
} from "@/server/imports/reference-pack";
import { ImportConflictError } from "./import-store";
import { fixedNow, importStore, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * State-store journeys, part 8 of 12.
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

setupStateStoreSuite("openrhen_state_store_h");

describe("normalized PostgreSQL portal persistence (part 8)", () => {
  it("refuses an import that would archive the home location", async () => {
    await store.put(createSeedState(fixedNow));
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id: "home", name: "Home", kind: "location", latitude: -36.1, longitude: 146.9 }
    });
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, assertedConditions: state.assertedConditions, homeLocationId: "home" }
    });
    const archiving = await importStore.preview({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records: parseImportCsv("conditions", "import_key,name,kind,status\r\nhome,Home,location,archived"),
      source: {}
    });
    // Nothing about the sheet is wrong — only the plan it would leave behind, which commit refuses.
    expect(archiving.records[0]?.errors).toEqual([]);
    await expect(importStore.commit(archiving.id, archiving.version)).rejects.toThrow(
      "Choose another home in Settings before archiving it."
    );
    expect((await store.get())!.conditionDefinitions.find((item) => item.id === "home")?.status).toBe("active");
  });

  it("commits the ready records and moves the blocked ones into a new batch, atomically", async () => {
    await store.put(createSeedState(fixedNow));
    // One clean area, one area with no name (blocked), an outcome under the blocked area (ready in
    // itself, but stranded), and an outcome under the clean area (ready).
    const records = [
      ...parseImportCsv(
        "areas",
        "import_key,name,description,status,sort_order\r\nclean,Clean area,,active,4\r\nbroken,,,active,5"
      ),
      ...parseImportCsv(
        "outcomes",
        "import_key,area_key,title,definition_of_done,value,status,deadline_at,review_on\r\nunder-clean,clean,Under clean,Done,3,active,,\r\nunder-broken,broken,Under broken,Done,3,active,,",
        2
      )
    ];
    const preview = await importStore.preview({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records,
      source: { filename: "plan.csv", contentHash: "e".repeat(64) }
    });
    expect(preview.status).toBe("blocked");
    await expect(importStore.commit(preview.id, preview.version)).rejects.toThrow(/blocking record/);
    // A stale version is refused before anything is written.
    await expect(importStore.commitReady(preview.id, preview.version + 1)).rejects.toBeInstanceOf(ImportConflictError);

    const { batch, deferred } = await importStore.commitReady(preview.id, preview.version);
    expect(batch.status).toBe("committed");
    expect(batch.records.map((record) => record.importKey).sort()).toEqual(["clean", "under-clean"]);
    expect(deferred).not.toBeNull();
    expect(deferred!.id).not.toBe(batch.id);
    expect(deferred!.status).toBe("blocked");
    expect(deferred!.sourceType).toBe("csv");
    expect(deferred!.timezone).toBe("Australia/Sydney");
    expect(deferred!.source).toMatchObject({ filename: "plan.csv (blocked rows)", contentHash: "e".repeat(64) });
    expect(deferred!.records.map((record) => record.importKey).sort()).toEqual(["broken", "under-broken"]);
    // The stranded outcome kept its own clean validation and was told why it moved.
    const stranded = deferred!.records.find((record) => record.importKey === "under-broken")!;
    expect(stranded.errors).toEqual([]);
    expect(stranded.warnings).toContain("Moved with broken, which this record depends on and which was blocked.");
    // The blocked area still carries its blocker.
    expect(deferred!.records.find((record) => record.importKey === "broken")?.errors).toContain("name is required.");

    const state = (await store.get())!;
    expect(state.areas.some((area) => area.name === "Clean area")).toBe(true);
    expect(state.outcomes.some((outcome) => outcome.title === "Under clean")).toBe(true);
    expect(state.outcomes.some((outcome) => outcome.title === "Under broken")).toBe(false);

    // The deferred batch is an ordinary draft: re-uploading the same file finds it, and it can be
    // fixed and committed like any other, with its stranded outcome resolving against the batch.
    const reupload = await importStore.previewOrReopen({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records: [],
      source: { filename: "plan.csv", contentHash: "e".repeat(64) }
    });
    expect(reupload).toMatchObject({ reopened: true, batch: { id: deferred!.id } });
    const fixed = deferred!.records.map((record) =>
      record.importKey === "broken"
        ? {
            ...record,
            fields: {
              ...record.fields,
              name: {
                value: "Fixed area",
                basis: "explicit" as const,
                confidence: "high" as const,
                evidence: [],
                needsReview: false
              }
            }
          }
        : record
    );
    const saved = await importStore.update(deferred!.id, deferred!.version, fixed);
    expect(saved.status).toBe("ready");
    const second = await importStore.commitReady(saved.id, saved.version);
    expect(second.batch.status).toBe("committed");
    expect(second.deferred).toBeNull();
    const after = (await store.get())!;
    expect(after.areas.some((area) => area.name === "Fixed area")).toBe(true);
    expect(after.outcomes.some((outcome) => outcome.title === "Under broken")).toBe(true);
  });

  it("strands a commitment whose location_key names a rejected context, rather than committing a dangling location_id", async () => {
    // The context's `kind` is valid ("location") but its `portability` is not, so it is rejected for a
    // reason that has nothing to do with its kind. Before the fix, `conditionKinds` was built from every
    // batch context record regardless of whether it carried an error, so this context's valid `kind`
    // alone was enough to make the commitment's location_key resolve as if the context would actually
    // be written. A commitment's location_key is a field-carried relation (`asField` in import-spec.ts),
    // not a plain relationship, so it also needs commit-split.ts's stranding to follow it. A clean area
    // rides along so commitReady has something ready to actually write.
    const records = [
      ...parseImportCsv("areas", "import_key,name,description,status,sort_order\r\nclean,Clean area,,active,1"),
      ...parseImportCsv("conditions", "import_key,name,kind,portability\r\nloc-x,Office,location,nonsense", 1),
      ...parseImportCsv(
        "fixed_commitments",
        "import_key,location_key,title,starts_at,ends_at,status,location,setup_before_minutes,transition_after_minutes\r\nstandup,loc-x,Standup,2026-09-10T09:00:00+10:00,2026-09-10T09:15:00+10:00,confirmed,,0,0",
        2
      )
    ];
    const preview = await importStore.preview({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records,
      source: { filename: "location.csv", contentHash: "d".repeat(64) }
    });
    expect(preview.status).toBe("blocked");
    const contextRecord = preview.records.find((record) => record.importKey === "loc-x")!;
    expect(contextRecord.errors).toContain("portability must be one of: fixed, portable.");
    expect(contextRecord.operation).toBe("rejected");
    const commitmentRecord = preview.records.find((record) => record.importKey === "standup")!;
    expect(commitmentRecord.errors).toContain("location_key must name an active location context.");
    expect(commitmentRecord.operation).toBe("rejected");

    const { batch, deferred } = await importStore.commitReady(preview.id, preview.version);
    expect(batch.status).toBe("committed");
    expect(batch.records.map((record) => record.importKey)).toEqual(["clean"]);
    expect(deferred).not.toBeNull();
    expect(deferred!.records.map((record) => record.importKey).sort()).toEqual(["loc-x", "standup"]);

    const state = (await store.get())!;
    expect(state.areas.some((area) => area.name === "Clean area")).toBe(true);
    expect(state.commitments.some((commitment) => commitment.title === "Standup")).toBe(false);
    const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM commitments WHERE title='Standup'`;
    expect(rows[0]!.count).toBe("0");
  });

  it("refuses a partial commit that would write nothing", async () => {
    await store.put(createSeedState(fixedNow));
    const preview = await importStore.preview({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records: parseImportCsv("areas", "import_key,name,description,status,sort_order\r\nbroken,,,active,5"),
      source: {}
    });
    await expect(importStore.commitReady(preview.id, preview.version)).rejects.toThrow(/No records are ready/);
    expect((await importStore.get(preview.id))?.status).toBe("blocked");
    expect((await store.get())?.areas.some((area) => area.name === "")).toBe(false);
  });

  it("imports deliverable shells and dependencies without creating BCR internals", async () => {
    await store.put(createSeedState(fixedNow));
    const before = (await store.get())!;
    const project = before.projects[0]!;
    const keys = await importStore.ensureReferenceKeys([
      { entityType: "project", entityId: project.id, label: project.title }
    ]);
    const records = [
      ...parseImportCsv(
        "deliverables",
        `import_key,project_key,title,details,status,uncertainty,importance,consequence,internal_deadline_at,external_deadline_at\r\nassessment-1,${keys.project![project.id]},Assessment 1,First shell,needs_breakdown,some,4,4,,2026-08-21T17:00:00+10:00\r\nassessment-2,${keys.project![project.id]},Assessment 2,Second shell,needs_breakdown,high,5,5,,2026-08-28T17:00:00+10:00`
      ),
      ...parseImportCsv(
        "deliverable_dependencies",
        "import_key,deliverable_key,depends_on_deliverable_key\r\nassessment-2-after-1,assessment-2,assessment-1",
        2
      )
    ];
    const preview = await importStore.preview({
      sourceType: "xlsx",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records,
      source: {}
    });
    expect(preview.status).toBe("ready");
    await importStore.commit(preview.id, preview.version);

    const after = (await store.get())!;
    const first = after.deliverables.find((item) => item.title === "Assessment 1")!;
    const second = after.deliverables.find((item) => item.title === "Assessment 2")!;
    expect(second).toMatchObject({
      status: "needs_breakdown",
      projectId: project.id,
      dependencyIds: [first.id],
      contractVersion: 0,
      planVersion: 0,
      steps: [],
      criteria: []
    });
  });

  it("re-imports a committed recurring commitment as an update, not a stale-entity conflict", async () => {
    await store.put(createSeedState(fixedNow));
    const csv =
      "import_key,title,timezone,start_date,end_date,interval_days,local_start_time,local_end_time,location,setup_before_minutes,transition_after_minutes\r\ncooking-class,Cooking class,Australia/Sydney,2026-08-14,,7,12:00,15:00,,10,10";
    const first = await importStore.preview({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records: parseImportCsv("fixed_commitment_recurrences", csv),
      source: {}
    });
    expect(first.records[0]?.operation).toBe("create");
    await importStore.commit(first.id, first.version);
    const second = await importStore.preview({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records: parseImportCsv("fixed_commitment_recurrences", csv),
      source: {}
    });
    expect(second.records[0]?.operation).toBe("update");
    expect(second.records[0]?.errors).toEqual([]);
  });

  it("assigns one persistent import key when a reference pack includes a manually created record", async () => {
    await store.put(createSeedState(fixedNow));
    const state = (await store.get())!;
    const action = state.actions[0]!;
    const first = await importStore.ensureReferenceKeys([
      { entityType: "action", entityId: action.id, label: action.title }
    ]);
    const second = await importStore.ensureReferenceKeys([
      { entityType: "action", entityId: action.id, label: "A later title does not change the key" }
    ]);
    expect(first.action?.[action.id]).toMatch(/^manual-/);
    expect(second.action?.[action.id]).toBe(first.action?.[action.id]);
  });

  // a replaced document folds an action's legacy flat `contexts` into one pathway — but only
  // the tags naming a definition this person already has. `put` never writes definitions, so the
  // seed's "laptop" (no definition yet) must leave the action unconstrained, exactly as it was before
  // the flat store went; once the definition exists the same document folds into a real requirement.
  it("folds a replaced document's flat contexts into a pathway only once their definitions exist", async () => {
    await store.put(createSeedState(fixedNow));
    const draft = () =>
      store
        .get()
        .then((state) => state!.actions.find((item) => item.title === "Draft networking assignment section 1")!);
    expect((await draft()).requirementPathways).toEqual([]);
    expect((await draft()).contexts).toEqual([]);
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id: "laptop", name: "Laptop", kind: "capability", portability: "portable" }
    });
    await store.put(createSeedState(fixedNow));
    expect((await draft()).requirementPathways.map((pathway) => pathway.contextIds)).toEqual([["laptop"]]);
    expect((await draft()).contexts).toEqual(["laptop"]);
  }, 30_000);

  it("round-trips the reference pack: generate, parse back, preview clean, commit, and reads typed contexts back", async () => {
    const seed = createSeedState(fixedNow);
    await store.put(seed);
    // the flat context catalogue is retired, and with it the reference pack's old first-pass
    // guess at typed rows for a legacy tag with nothing typed yet — typed definitions are the sole,
    // authoritative source now, so this seeds the two the fixture's actions already carry a
    // (`state.put`'s own `contexts`-to-pathway fallback, see `state-replace.ts`) requirement pathway
    // for, the same way a real migrated dataset already would.
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id: "home", name: "Home", kind: "location", latitude: -36.1, longitude: 146.9 }
    });
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id: "laptop", name: "Laptop", kind: "capability", portability: "portable" }
    });
    // Put the seed again now that the definitions exist: the fold above only honours tags naming a
    // definition already stored, so the first put (with none) left the actions unconstrained.
    await store.put(seed);
    const before = (await store.get())!;
    const selection = selectReferencePack(before, [{ type: "all" }]);
    const keys = await importStore.ensureReferenceKeys(referenceKeyCandidates(selection));
    const bytes = await createReferencePackWorkbook(selection, keys, "roundtrip");
    const records = await parseImportWorkbook(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    );

    const preview = await importStore.preview({
      sourceType: "xlsx",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records,
      source: { filename: "roundtrip.xlsx" }
    });
    expect(preview.records.every((record) => !record.errors.length)).toBe(true);
    // Every entity type — contexts included, now that they already exist as typed rows — previews as
    // an update: nothing in this pack is new.
    expect(preview.records.every((record) => record.operation === "update")).toBe(true);
    expect(preview.status).toBe("ready");

    const committed = await importStore.commit(preview.id, preview.version);
    expect(committed.status).toBe("committed");

    const after = (await store.get())!;
    const originalAction = before.actions[0]!;
    const importedAction = after.actions.find((item) => item.id === originalAction.id)!;
    expect(importedAction.requirementPathways.map((pathway) => pathway.contextIds)).toEqual([originalAction.contexts]);
    expect(importedAction.contexts).toEqual(originalAction.contexts);
    expect(after.conditionDefinitions.map((item) => item.id).sort()).toEqual(["home", "laptop"]);
    expect(after.conditionDefinitions.find((item) => item.id === "home")).toMatchObject({ kind: "location" });
    expect(after.conditionDefinitions.find((item) => item.id === "laptop")).toMatchObject({
      kind: "capability",
      portability: "portable"
    });
  });

  it("rejects a requirements reference to an unknown condition and a self-referential composite pathway", async () => {
    await store.put(createSeedState(fixedNow));
    const state = (await store.get())!;
    const unknownReferenceRecords = [
      ...parseImportCsv(
        "conditions",
        "import_key,name,kind,status,portability,grants,pathways,travel_minutes,setup_before_minutes,transition_after_minutes,channels\r\ndesktop,Desktop,capability,active,fixed,,,,,,"
      ),
      ...parseImportCsv(
        "actions",
        `import_key,project_key,title,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,splittable,setup_minutes,importance,consequence,contexts,requirements,prefers,available_from,deadline_at,latest_start_at\r\nreview,${state.projects[0]!.id},Needs a made-up context,active,20,30,45,30,medium,15,30,true,0,5,5,,not-a-real-context,,,,`,
        1
      )
    ];
    const unknownPreview = await importStore.preview({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records: unknownReferenceRecords,
      source: {}
    });
    expect(
      unknownPreview.records
        .find((record) => record.entityType === "action")
        ?.errors.some((error) => error.includes("does not exist"))
    ).toBe(true);
    expect(unknownPreview.status).toBe("blocked");

    const cyclicRecords = [
      ...parseImportCsv(
        "conditions",
        "import_key,name,kind,status,portability,grants,pathways,travel_minutes,setup_before_minutes,transition_after_minutes,channels\r\nvideo-call-capable,Video call capable,capability,active,fixed,,desktop+video-call-capable,,,,"
      )
    ];
    const cyclicPreview = await importStore.preview({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records: cyclicRecords,
      source: {}
    });
    expect(cyclicPreview.records[0]?.errors.some((error) => error.includes("circular"))).toBe(true);
    expect(cyclicPreview.status).toBe("blocked");
  });

  it("no longer gates a current-condition or location-assertion save behind a condition catalogue", async () => {
    // The flat context catalogue (and its "contexts" rename/delete command) is retired: typed condition
    // definitions are the sole source now. This used to fail with "Every current context must exist
    // in the context catalogue" the moment `assertedConditions` named anything the catalogue had not
    // already grown to include — which, per the 2026-09-05 review, could trip on a plain location
    // assertion (`current_situation.locationId`) sent alongside it, unrelated to the location itself.
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "current_availability",
      entity: {
        currentEnergy: state.currentEnergy,
        assertedConditions: ["somewhere-new"],
        currentSituation: { locationId: null }
      }
    });
    expect(state.assertedConditions).toEqual(["somewhere-new"]);
  });

  it("plans sleep and records an actual sleep session", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: {
        ...state.settings,
        assertedConditions: ["home"],
        lastWokeAt: fixedNow.toISOString(),
        setupCompleted: true
      }
    });
    expect(state.sleepPlans.length).toBeGreaterThan(0);
    const sleep = state.sleepPlans[0]!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: sleep.version ?? null,
      type: "start_activity",
      targetType: "sleep",
      targetId: sleep.id,
      plannedMinutes: sleep.allowedMinutes
    });
    expect(state.activeSession).toMatchObject({ targetType: "sleep", targetTitle: "Sleep" });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });
    expect(state.activeSession).toBeNull();
    expect(state.completedToday.at(-1)).toMatchObject({ targetType: "sleep", result: "completed" });
    expect(state.settings.lastWokeAt).toBeDefined();
  });

  // allowed_minutes is frozen at the planned allowance the moment sleep tracking starts, so a night
  // that ran far longer than planned (a sick night, e.g.) used to keep showing that planned length
  // forever once finished — disagreeing with the real actual_start_at/actual_wake_at sitting right
  // next to it. Finishing must now recompute it from the real span.
  it("recomputes a tracked sleep's allowed minutes from the actual span on wake, not the frozen planned allowance", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, assertedConditions: ["home"], lastWokeAt: now.toISOString(), setupCompleted: true }
    });
    const planned = state.sleepPlans.find((item) => item.status === "planned")!;
    const plannedMinutes = planned.allowedMinutes;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: planned.version ?? null,
      type: "start_activity",
      targetType: "sleep",
      targetId: planned.id,
      plannedMinutes
    });
    const session = state.activeSession!;
    // Backdate the tracked start well past the planned allowance, as if this were a much longer
    // night than scheduled — the exact staleness this fix targets.
    const backdatedStart = new Date(now.getTime() - (plannedMinutes + 600) * 60_000);
    await sql`UPDATE sessions SET started_at=${backdatedStart} WHERE id=${session.id}`;
    await sql`UPDATE session_segments SET started_at=${backdatedStart} WHERE session_id=${session.id}`;
    await sql`UPDATE sleep_plans SET actual_start_at=${backdatedStart} WHERE id=${planned.id}`;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: session.version ?? null,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    const tracked = state.sleepPlans.find((item) => item.id === planned.id)!;
    const expectedMinutes = Math.round((new Date(tracked.actualWakeAt!).getTime() - backdatedStart.getTime()) / 60000);
    expect(expectedMinutes).toBeGreaterThan(plannedMinutes + 500);
    expect(tracked.allowedMinutes).toBe(expectedMinutes);
    expect(tracked.allowedMinutes).not.toBe(plannedMinutes);
    expect(tracked.sleepDeficitMinutes).toBe(0);
    // Persisted, not just echoed back: a fresh read shows the same recomputed minutes.
    const reloaded = (await store.get())!;
    expect(reloaded.sleepPlans.find((item) => item.id === planned.id)?.allowedMinutes).toBe(expectedMinutes);
  }, 30_000);

  // The pulse criteria and publish design note (Decision Q2, "Self-started session"): `plan_sanction`
  // is decided once, at start, and frozen — whichever reading applies, `sanction_until` matches
  // `planned_end_at` for a directive/alternative/day-plan sanction and is null for `free`/unsanctioned.
  it("stores plan_sanction and sanction_until at session start (action)", async () => {
    await store.put(createSeedState(fixedNow));
    const state = (await store.get())!;
    const action = state.actions[0]!;
    const started = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "start",
      actionId: action.id,
      plannedMinutes: 30
    });
    const session = started.activeSession!;
    const rows = await sql<
      { plan_sanction: string | null; sanction_until: Date | null; planned_end_at: Date }[]
    >`SELECT plan_sanction, sanction_until, planned_end_at FROM sessions WHERE id=${session.id}`;
    const row = rows[0]!;
    expect(["directive", "alternative", "day_plan_block", "free", null]).toContain(row.plan_sanction);
    if (row.plan_sanction === "free" || row.plan_sanction === null) expect(row.sanction_until).toBeNull();
    else expect(row.sanction_until?.getTime()).toBe(row.planned_end_at.getTime());
  });

  it("stores plan_sanction 'continuation' with a moved sanction_until on continue", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    const action = state.actions[0]!;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "start",
      actionId: action.id,
      plannedMinutes: 20
    });
    const session = state.activeSession!;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: session.version ?? null,
      type: "request_feedback",
      sessionId: session.id
    });
    const continuation = (await store.get())!.planning?.result?.continuation as {
      safe?: boolean;
      recommendedMinutes?: number;
    } | null;
    if (!continuation?.safe || !continuation.recommendedMinutes) return;
    await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "continue",
      sessionId: session.id,
      requestedMinutes: continuation.recommendedMinutes
    });
    const rows = await sql<
      { plan_sanction: string | null; sanction_until: Date | null; planned_end_at: Date }[]
    >`SELECT plan_sanction, sanction_until, planned_end_at FROM sessions WHERE id=${session.id}`;
    expect(rows[0]!.plan_sanction).toBe("continuation");
    expect(rows[0]!.sanction_until?.getTime()).toBe(rows[0]!.planned_end_at.getTime());
  });
});
