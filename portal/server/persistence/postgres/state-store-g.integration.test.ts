import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { parseImportCsv } from "@/features/imports/import-csv";
import { ensureUser } from "./ensure-user";
import { InvalidCommandError } from "./command-errors";
import { EXAMPLE_SHARED } from "@/test/example-calendar-sources";
import { fixedNow, importStore, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * State-store journeys, part 7 of 12.
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

setupStateStoreSuite("openrhen_state_store_g");

describe("normalized PostgreSQL portal persistence (part 7)", () => {
  it("replaces whole state when a commitment and a recurrence rule still point at a source", async () => {
    // `commitments.source_id` and `commitment_recurrence_rules.source_id` have no ON DELETE
    // rule, so a single shared-calendar-linked row used to make the whole-state PUT abort on a foreign key
    // violation. The commitment is rewritten from the incoming state; the rule is not written back by
    // `replaceState` at all, so it must survive with its now-dangling source link cleared.
    await store.put(createSeedState(fixedNow));
    const userId = await ensureUser(sql);
    const sourceRows = await sql<{ id: string }[]>`
      INSERT INTO sources (user_id, source_type, external_id, captured_text)
      VALUES (${userId}, ${EXAMPLE_SHARED}, 'event-1', 'Imported calendar event')
      RETURNING id
    `;
    const sourceId = sourceRows[0]!.id;
    const startsAt = new Date(fixedNow.getTime() + 3 * 60 * 60_000);
    await sql`
      INSERT INTO commitments (user_id, title, starts_at, ends_at, source_id)
      VALUES (${userId}, 'Imported event', ${startsAt}, ${new Date(startsAt.getTime() + 60 * 60_000)}, ${sourceId})
    `;
    await sql`
      INSERT INTO commitment_recurrence_rules (user_id, title, timezone, start_date, interval_days, local_start_time, local_end_time, source_id)
      VALUES (${userId}, 'Imported weekly pickup', 'Australia/Sydney', ${startsAt.toISOString().slice(0, 10)}, 7, '15:00', '16:00', ${sourceId})
    `;

    await store.put(createSeedState(fixedNow));

    const rules = await sql<
      { id: string; source_id: string | null }[]
    >`SELECT id, source_id FROM commitment_recurrence_rules WHERE user_id=${userId}`;
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source_id).toBeNull();
    const orphaned = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM commitments WHERE user_id=${userId} AND source_id IS NOT NULL`;
    expect(orphaned[0]!.count).toBe(0);
  });

  it("preserves completed, stopped, and blocked session outcomes with remaining effort", async () => {
    const state = createSeedState(fixedNow);
    const action = state.actions[0]!;
    state.completedToday = [
      {
        id: "stopped-session",
        actionId: action.id,
        actionTitle: action.title,
        result: "stopped",
        startedAt: fixedNow.toISOString(),
        endedAt: new Date(fixedNow.getTime() + 20 * 60_000).toISOString(),
        plannedMinutes: 30,
        activeMinutes: 12,
        remainingBeforeMinutes: 90,
        remainingAfterMinutes: 75
      },
      {
        id: "blocked-session",
        actionId: action.id,
        actionTitle: action.title,
        result: "blocked",
        startedAt: new Date(fixedNow.getTime() + 30 * 60_000).toISOString(),
        endedAt: new Date(fixedNow.getTime() + 40 * 60_000).toISOString(),
        plannedMinutes: 25,
        activeMinutes: 8,
        remainingBeforeMinutes: 75,
        remainingAfterMinutes: 75,
        resultNote: "Waiting for source material"
      }
    ];

    await store.put(state);
    const loaded = await store.get();

    expect(
      loaded?.completedToday.map((item) => ({
        result: item.result,
        activeMinutes: item.activeMinutes,
        remainingAfterMinutes: item.remainingAfterMinutes
      }))
    ).toEqual([
      { result: "stopped", activeMinutes: 12, remainingAfterMinutes: 75 },
      { result: "blocked", activeMinutes: 8, remainingAfterMinutes: 75 }
    ]);
  });

  it("rolls back the whole update when a database invariant is rejected", async () => {
    await store.put(createSeedState(fixedNow));
    const before = await store.get();
    const invalid: PortalState = {
      ...before!,
      projects: before!.projects.map((project, index) => (index === 0 ? { ...project, consequence: 9 } : project))
    };

    await expect(store.put(invalid)).rejects.toBeDefined();
    const after = await store.get();
    expect(after?.projects[0]?.consequence).toBe(before?.projects[0]?.consequence);
    expect(after?.projects.map((project) => project.id)).toEqual(before?.projects.map((project) => project.id));
  });

  it("rejects invalid planning defaults at the database boundary", async () => {
    await store.put(createSeedState(fixedNow));
    const before = await store.get();
    const invalid: PortalState = { ...before!, settings: { ...before!.settings, defaultUsableFraction: 1.2 } };

    await expect(store.put(invalid)).rejects.toBeDefined();
    const after = await store.get();
    expect(after?.settings.defaultUsableFraction).toBe(before?.settings.defaultUsableFraction);
  });

  it("updates one project with optimistic version protection", async () => {
    await store.put(createSeedState(fixedNow));
    const before = await store.get();
    const project = before!.projects[0]!;
    const saved = await store.saveProject({
      expectedVersion: project.version!,
      project: {
        id: project.id,
        outcomeId: project.outcomeId,
        title: "Updated assignment",
        status: project.status,
        uncertainty: project.uncertainty,
        consequence: project.consequence,
        ...(project.internalDeadlineAt ? { internalDeadlineAt: project.internalDeadlineAt } : {}),
        ...(project.externalDeadlineAt ? { externalDeadlineAt: project.externalDeadlineAt } : {}),
        remainingEffortOverrideMinutes: 125
      }
    });
    expect(saved.projects[0]).toMatchObject({
      title: "Updated assignment",
      remainingEffortOverrideMinutes: 125,
      version: project.version! + 1
    });
    await expect(
      store.saveProject({
        expectedVersion: project.version!,
        project: {
          id: project.id,
          outcomeId: project.outcomeId,
          title: "Stale edit",
          status: project.status,
          uncertainty: project.uncertainty,
          consequence: project.consequence
        }
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining("changed after you read it"),
      currentVersion: project.version! + 1
    });
  });

  it("rejects an action dependency cycle transactionally", async () => {
    await store.put(createSeedState(fixedNow));
    const before = await store.get();
    const first = before!.actions[0]!;
    const second = before!.actions[1]!;
    const command = (target: typeof first, dependencyIds: string[]) => ({
      expectedVersion: target.version!,
      action: {
        id: target.id,
        projectId: target.projectId,
        title: target.title,
        status: target.status,
        optimisticMinutes: target.optimisticMinutes,
        expectedMinutes: target.expectedMinutes,
        pessimisticMinutes: target.pessimisticMinutes,
        remainingMinutes: target.remainingMinutes,
        energy: target.energy,
        minimumSessionMinutes: target.minimumSessionMinutes,
        maximumSessionMinutes: target.maximumSessionMinutes,
        splittable: target.splittable,
        setupMinutes: target.setupMinutes,
        importance: target.importance,
        consequence: target.consequence,
        contexts: target.contexts,
        dependencyIds
      }
    });
    await store.saveAction(command(first, [second.id]));
    await expect(store.saveAction(command(second, [first.id]))).rejects.toThrow("cycle");
    const after = await store.get();
    expect(after!.actions.find((item) => item.id === second.id)?.dependencyIds).toEqual([]);
  });

  it("refuses a project or action that names a record that is not there as the caller's mistake, not a crash", async () => {
    await store.put(createSeedState(fixedNow));
    const before = (await store.get())!;
    const project = before.projects[0]!;
    const action = before.actions[0]!;
    const projectCommand = (outcomeId: string) => ({
      expectedVersion: null,
      project: {
        id: crypto.randomUUID(),
        outcomeId,
        title: "Orphan",
        status: "active" as const,
        uncertainty: project.uncertainty,
        consequence: project.consequence
      }
    });
    const actionCommand = (fields: Record<string, unknown>) => ({
      expectedVersion: null,
      action: {
        id: crypto.randomUUID(),
        projectId: action.projectId,
        title: "Orphan",
        status: action.status,
        optimisticMinutes: action.optimisticMinutes,
        expectedMinutes: action.expectedMinutes,
        pessimisticMinutes: action.pessimisticMinutes,
        remainingMinutes: action.remainingMinutes,
        energy: action.energy,
        minimumSessionMinutes: action.minimumSessionMinutes,
        maximumSessionMinutes: action.maximumSessionMinutes,
        splittable: action.splittable,
        setupMinutes: action.setupMinutes,
        importance: action.importance,
        consequence: action.consequence,
        contexts: action.contexts,
        dependencyIds: [],
        ...fields
      }
    });
    const refused = async (attempt: Promise<unknown>, message: string) => {
      const error = await attempt.then(
        () => undefined,
        (caught: unknown) => caught
      );
      expect(error).toBeInstanceOf(InvalidCommandError);
      expect((error as Error).message).toBe(message);
    };
    await refused(
      store.saveProject(projectCommand("no-such-outcome")),
      'Outcome "no-such-outcome" no longer exists, or never existed (the id may be wrong).'
    );
    await refused(
      store.saveAction(actionCommand({ projectId: "no-such-project" })),
      'Project "no-such-project" no longer exists, or never existed (the id may be wrong).'
    );
    await refused(
      store.saveAction(actionCommand({ dependencyIds: ["no-such-action"] })),
      'Dependency action "no-such-action" no longer exists, or never existed (the id may be wrong).'
    );
    await refused(
      store.saveAction(actionCommand({ prepForCommitmentId: "no-such-commitment" })),
      'The commitment this action prepares for "no-such-commitment" no longer exists, or never existed (the id may be wrong).'
    );
  });

  it("previews and atomically commits a related CSV hierarchy", async () => {
    await store.put(createSeedState(fixedNow));
    const records = [
      ...parseImportCsv("areas", "import_key,name,description,status,sort_order\r\nwork,Work,,active,5"),
      ...parseImportCsv(
        "outcomes",
        "import_key,area_key,title,definition_of_done,value,status,deadline_at,review_on\r\nship,work,Ship MVP,Service usable,5,active,,",
        1
      ),
      ...parseImportCsv(
        "projects",
        "import_key,outcome_key,title,status,uncertainty,consequence,internal_deadline_at,external_deadline_at,remaining_effort_override_minutes\r\nimport,ship,Build importer,active,some,5,,,",
        2
      ),
      ...parseImportCsv(
        "actions",
        "import_key,project_key,title,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,splittable,setup_minutes,importance,consequence,contexts,available_from,deadline_at,latest_start_at\r\nreview,import,Review imported plan,active,20,30,45,30,medium,15,30,true,0,5,5,laptop,,,",
        3
      )
    ];
    const preview = await importStore.preview({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records,
      source: { filename: "fixture.csv" }
    });
    expect(preview.status).toBe("ready");
    const committed = await importStore.commit(preview.id, preview.version);
    expect(committed.status).toBe("committed");
    const state = await store.get();
    expect(state?.actions.some((action) => action.title === "Review imported plan")).toBe(true);
    expect(state?.currentRecommendationId).toBeDefined();
  });

  it("writes an imported action's notes on create and on a later update", async () => {
    await store.put(createSeedState(fixedNow));
    const columns =
      "import_key,project_key,title,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,splittable,setup_minutes,importance,consequence,notes";
    const row = (notes: string) =>
      `noted,import,Review imported plan,active,20,30,45,30,medium,15,30,true,0,5,5,${notes}`;
    const importAction = async (notes: string) => {
      const preview = await importStore.preview({
        sourceType: "csv",
        inputKind: "planning_data",
        timezone: "Australia/Sydney",
        templateVersion: "1",
        records: [
          ...parseImportCsv("areas", "import_key,name,description,status,sort_order\r\nwork,Work,,active,5"),
          ...parseImportCsv(
            "outcomes",
            "import_key,area_key,title,definition_of_done,value,status,deadline_at,review_on\r\nship,work,Ship MVP,Service usable,5,active,,",
            1
          ),
          ...parseImportCsv(
            "projects",
            "import_key,outcome_key,title,status,uncertainty,consequence,internal_deadline_at,external_deadline_at,remaining_effort_override_minutes\r\nimport,ship,Build importer,active,some,5,,,",
            2
          ),
          ...parseImportCsv("actions", `${columns}\r\n${row(notes)}`, 3)
        ],
        source: { filename: "fixture.csv" }
      });
      expect(preview.status).toBe("ready");
      await importStore.commit(preview.id, preview.version);
      return (await store.get())?.actions.find((action) => action.title === "Review imported plan");
    };

    expect((await importAction("Marking rubric is in the shared folder"))?.notes).toBe(
      "Marking rubric is in the shared folder"
    );
    expect((await importAction("Rubric moved to the unit page"))?.notes).toBe("Rubric moved to the unit page");
    // Blank behaves as it does for every other scalar on the row: the sheet is what the action says.
    expect((await importAction(""))?.notes).toBeUndefined();
  });

  it("rolls back every imported row when confirmation fails", async () => {
    await store.put(createSeedState(fixedNow));
    const records = parseImportCsv(
      "areas",
      "import_key,name,description,status,sort_order\r\none,Duplicate,,active,7\r\ntwo,Duplicate,,active,8"
    );
    const preview = await importStore.preview({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records,
      source: {}
    });
    await expect(importStore.commit(preview.id, preview.version)).rejects.toBeDefined();
    const state = await store.get();
    expect(state?.areas.some((area) => area.name === "Duplicate")).toBe(false);
  });

  it("reuses stable import keys for versioned updates", async () => {
    await store.put(createSeedState(fixedNow));
    const first = await importStore.preview({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records: parseImportCsv(
        "areas",
        "import_key,name,description,status,sort_order\r\nrepeat,Imported Area,,active,9"
      ),
      source: {}
    });
    await importStore.commit(first.id, first.version);
    const second = await importStore.preview({
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records: parseImportCsv(
        "areas",
        "import_key,name,description,status,sort_order\r\nrepeat,Renamed Area,,active,9"
      ),
      source: {}
    });
    expect(second.records[0]?.operation).toBe("update");
    await importStore.commit(second.id, second.version);
    const state = await store.get();
    expect(state?.areas.filter((area) => area.name === "Renamed Area")).toHaveLength(1);
    expect(state?.areas.some((area) => area.name === "Imported Area")).toBe(false);
  });

  it("reopens the open batch that already holds an upload's content instead of queueing a twin", async () => {
    await store.put(createSeedState(fixedNow));
    // Each upload parses afresh, so every preview carries newly minted record ids, as a browser's would.
    const upload = () => ({
      sourceType: "csv" as const,
      inputKind: "planning_data" as const,
      timezone: "Australia/Sydney",
      templateVersion: "1" as const,
      records: parseImportCsv("areas", "import_key,name,description,status,sort_order\r\ntwice,Twice,,active,3"),
      source: { filename: "areas.csv", contentHash: "f".repeat(64) }
    });
    const first = await importStore.previewOrReopen(upload());
    expect(first.reopened).toBe(false);
    const again = await importStore.previewOrReopen(upload());
    expect(again.reopened).toBe(true);
    expect(again.batch.id).toBe(first.batch.id);
    // The same content under another source type is not the same batch.
    const workbook = await importStore.previewOrReopen({ ...upload(), sourceType: "xlsx" });
    expect(workbook.reopened).toBe(false);
    expect(workbook.batch.id).not.toBe(first.batch.id);
    // Once committed the batch is history, and the same upload starts fresh.
    await importStore.commit(first.batch.id, first.batch.version);
    const afterCommit = await importStore.previewOrReopen(upload());
    expect(afterCommit.reopened).toBe(false);
    expect(afterCommit.batch.id).not.toBe(first.batch.id);
    // A deleted batch is gone, so its content is no longer waiting either.
    await importStore.delete(afterCommit.batch.id);
    const afterDelete = await importStore.previewOrReopen(upload());
    expect(afterDelete.reopened).toBe(false);
    expect(afterDelete.batch.id).not.toBe(afterCommit.batch.id);
    // Batches without a hash never match one another.
    const unhashed = () => ({ ...upload(), source: { filename: "areas.csv" } });
    const one = await importStore.previewOrReopen(unhashed());
    const two = await importStore.previewOrReopen(unhashed());
    expect(two.reopened).toBe(false);
    expect(two.batch.id).not.toBe(one.batch.id);
  });

  it("re-resolves a reopened batch against the database rather than serving its stale statuses", async () => {
    const upload = () => ({
      sourceType: "csv" as const,
      inputKind: "planning_data" as const,
      timezone: "Australia/Sydney",
      templateVersion: "1" as const,
      records: parseImportCsv(
        "areas",
        "import_key,name,description,status,sort_order\r\nreopened,Freshly named,,active,7"
      ),
      source: { filename: "reopen.csv", contentHash: "9".repeat(64) }
    });
    const first = await importStore.previewOrReopen(upload());
    expect(first.reopened).toBe(false);
    expect(first.batch.status).toBe("ready");
    expect(first.batch.records[0]?.errors).toEqual([]);
    // Something else creates an area of the same name after the batch was last resolved — nothing
    // about the batch's own rows changed, but what it would do to the database has. `previewOrReopen`
    // above already made the one user row through `ensureUser`, so it can be read back directly.
    const userId = (await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`)[0]!.id;
    await sql`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Freshly named','active',8)`;
    const reopened = await importStore.previewOrReopen(upload());
    expect(reopened.reopened).toBe(true);
    expect(reopened.batch.id).toBe(first.batch.id);
    expect(reopened.batch.status).toBe("blocked");
    expect(reopened.batch.records[0]?.errors).toContain("An area with this name already exists.");
  });

  it("resolves two concurrent uploads of the same content into a single open batch", async () => {
    const upload = () => ({
      sourceType: "csv" as const,
      inputKind: "planning_data" as const,
      timezone: "Australia/Sydney",
      templateVersion: "1" as const,
      records: parseImportCsv("areas", "import_key,name,description,status,sort_order\r\nrace,Race area,,active,3"),
      source: { filename: "race.csv", contentHash: "c".repeat(64) }
    });
    const [first, second] = await Promise.all([
      importStore.previewOrReopen(upload()),
      importStore.previewOrReopen(upload())
    ]);
    expect(first.batch.id).toBe(second.batch.id);
    // Exactly one of the two calls made the batch; the other found it already open.
    expect([first.reopened, second.reopened].sort()).toEqual([false, true]);
    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM import_batches WHERE content_hash=${"c".repeat(64)}
    `;
    expect(rows[0]!.count).toBe("1");
  });

  it("leaves a value alone when its column is absent from a re-import and clears it when the cell is blank", async () => {
    await store.put(createSeedState(fixedNow));
    const project = (await store.get())!.projects[0]!;
    const projectKey = (
      await importStore.ensureReferenceKeys([{ entityType: "project", entityId: project.id, label: project.title }])
    ).project![project.id]!;
    const csvPreview = async (entity: string, csv: string) =>
      importStore.preview({
        sourceType: "csv",
        inputKind: "planning_data",
        timezone: "Australia/Sydney",
        templateVersion: "1",
        records: parseImportCsv(entity, csv),
        source: {}
      });
    const full =
      "import_key,project_key,title,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,splittable,setup_minutes,importance,consequence,contexts,deadline_at,notes";
    const created = await csvPreview(
      "actions",
      `${full}\r\nkeep,${projectKey},Keep my columns,active,20,30,45,30,medium,15,30,true,0,5,5,laptop|home,2026-09-01T17:00:00+10:00,Bring the rubric`
    );
    expect(created.status).toBe("ready");
    await importStore.commit(created.id, created.version);
    const find = async () => (await store.get())!.actions.find((action) => action.title === "Keep my columns")!;
    expect([...(await find()).contexts].sort()).toEqual(["home", "laptop"]);
    expect((await find()).deadlineAt).toBeDefined();
    expect((await find()).notes).toBe("Bring the rubric");

    // A subset re-import: only the key, the project and the title. Every other column is absent, so
    // the estimate, the deadline, the note and the contexts all stand — and the required fields the
    // sheet does not carry are not demanded of an update.
    const subset = await csvPreview("actions", `import_key,project_key,title\r\nkeep,${projectKey},Kept my columns`);
    expect(subset.records[0]?.errors).toEqual([]);
    expect(subset.records[0]?.operation).toBe("update");
    expect(subset.status).toBe("ready");
    await importStore.commit(subset.id, subset.version);
    const kept = (await store.get())!.actions.find((action) => action.title === "Kept my columns")!;
    expect(kept.expectedMinutes).toBe(30);
    expect([...kept.contexts].sort()).toEqual(["home", "laptop"]);
    expect(kept.deadlineAt).toBeDefined();
    expect(kept.notes).toBe("Bring the rubric");

    // A blank cell in a column that is there is a deliberate blank: it clears the scalar and empties the list.
    const blanked = await csvPreview(
      "actions",
      `import_key,project_key,title,contexts,deadline_at,notes\r\nkeep,${projectKey},Kept my columns,,,`
    );
    expect(blanked.records[0]?.errors).toEqual([]);
    await importStore.commit(blanked.id, blanked.version);
    const cleared = (await store.get())!.actions.find((action) => action.title === "Kept my columns")!;
    expect(cleared.contexts).toEqual([]);
    expect(cleared.deadlineAt).toBeUndefined();
    expect(cleared.notes).toBeUndefined();
    expect(cleared.expectedMinutes).toBe(30);

    // On a create the same absent columns are still required.
    const fresh = await csvPreview("actions", `import_key,project_key,title\r\nnew-one,${projectKey},Brand new`);
    expect(fresh.records[0]?.operation).toBe("rejected");
    expect(fresh.records[0]?.errors).toContain("expectedMinutes is required.");
  });

  it("imports a cadence as a windowless cadence rule, and only an explicit zero ends it", async () => {
    await store.put(createSeedState(fixedNow));
    const settings = (await store.get())!.settings;
    const project = (await store.get())!.projects[0]!;
    const projectKey = (
      await importStore.ensureReferenceKeys([{ entityType: "project", entityId: project.id, label: project.title }])
    ).project![project.id]!;
    const columns =
      "import_key,project_key,title,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,splittable,setup_minutes,importance,consequence,repeat_every_days";
    const importRow = async (csv: string) => {
      const preview = await importStore.preview({
        sourceType: "csv",
        inputKind: "planning_data",
        timezone: "Australia/Sydney",
        templateVersion: "1",
        records: parseImportCsv("actions", csv),
        source: {}
      });
      expect(preview.records[0]?.errors).toEqual([]);
      await importStore.commit(preview.id, preview.version);
      return (await store.get())!.actions.find((action) => action.title === "Practise scales")!;
    };
    const row = (repeat: string) =>
      `run-scales,${projectKey},Practise scales,active,10,20,30,20,medium,10,30,true,0,4,3,${repeat}`;

    const practice = await importRow(`${columns}\r\n${row("3")}`);
    expect(practice.schedulingMode).toBe("cadence");
    expect(practice.recurrence?.intervalDays).toBe(3);
    // A cadence is an interval, not an appointment: it must arrive with no windows at all.
    expect(practice.recurrence?.windows).toEqual([]);
    expect(practice.recurrence?.completionMode).toBe("manual");
    expect(practice.recurrence?.endDate).toBeUndefined();
    expect(practice.recurrence?.timezone).toBe(settings.timezone);
    expect(practice.recurrence?.startDate).toBe(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: settings.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(fixedNow)
    );

    // Re-importing changes the interval of the rule already there rather than adding a second one,
    // and leaves the start date alone — a practice never yet done is due from it.
    const rephrased = await importRow(`${columns}\r\n${row("5")}`);
    expect(rephrased.recurrence?.id).toBe(practice.recurrence?.id);
    expect(rephrased.recurrence?.intervalDays).toBe(5);
    expect(rephrased.recurrence?.startDate).toBe(practice.recurrence?.startDate);

    // A blank cell, or a sheet written before the column existed, must not quietly end the practice.
    const blank = await importRow(`${columns}\r\n${row("")}`);
    expect(blank.schedulingMode).toBe("cadence");
    expect(blank.recurrence?.intervalDays).toBe(5);
    const absent = await importRow(`import_key,project_key,title\r\nrun-scales,${projectKey},Practise scales`);
    expect(absent.schedulingMode).toBe("cadence");

    // Zero is the one thing that does end it, and it takes the rule with it.
    const ended = await importRow(`${columns}\r\n${row("0")}`);
    expect(ended.schedulingMode).toBe("one_off");
    expect(ended.recurrence).toBeUndefined();
  });

  it("writes a commitment's place from location_key, and refuses a key that names no active place", async () => {
    await store.put(createSeedState(fixedNow));
    const place = (id: string, name: string, kind: "location" | "capability") =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "condition_definition",
        entity: { id, name, kind, ...(kind === "location" ? { latitude: -36.1, longitude: 146.9 } : {}) }
      });
    await place("campus", "Campus", "location");
    await place("laptop", "Laptop", "capability");
    const starts = new Date(fixedNow.getTime() + 26 * 60 * 60_000).toISOString();
    const ends = new Date(fixedNow.getTime() + 28 * 60 * 60_000).toISOString();
    const commitmentPreview = (csv: string) =>
      importStore.preview({
        sourceType: "csv",
        inputKind: "capacity_commitments",
        timezone: "Australia/Sydney",
        templateVersion: "1",
        records: parseImportCsv("fixed_commitments", csv),
        source: {}
      });
    const full =
      "import_key,location_key,title,starts_at,ends_at,status,location,setup_before_minutes,transition_after_minutes";
    const row = (key: string) => `lecture,${key},Lecture,${starts},${ends},confirmed,Room 4,10,5`;
    const created = await commitmentPreview(`${full}\r\n${row("campus")}`);
    expect(created.records[0]?.errors).toEqual([]);
    await importStore.commit(created.id, created.version);
    const find = async () => (await store.get())!.commitments.find((item) => item.title === "Lecture")!;
    expect(await find()).toMatchObject({ location: "Room 4", locationId: "campus" });

    // The same absent-versus-blank rule every column obeys: left out, the place stands; blank, it goes.
    const subset = await commitmentPreview(`import_key,title\r\nlecture,Lecture`);
    await importStore.commit(subset.id, subset.version);
    expect((await find()).locationId).toBe("campus");
    const blanked = await commitmentPreview(`import_key,location_key,title\r\nlecture,,Lecture`);
    await importStore.commit(blanked.id, blanked.version);
    expect((await find()).locationId).toBeUndefined();

    // A key naming nothing, and a key naming a context that is not a place, both block the batch.
    for (const key of ["mars", "laptop"]) {
      const blocked = await commitmentPreview(`${full}\r\n${row(key)}`);
      expect(blocked.records[0]?.errors).toContain("location_key must name an active location context.");
      expect(blocked.records[0]?.operation).toBe("rejected");
      expect(blocked.status).toBe("blocked");
    }
  });
});
