import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { formatZonedMoment } from "@/shared/date-format";
import { commitmentEditorFrom, commitmentEntityFrom } from "@/features/today/today-drafts";
import { ensureUser } from "./ensure-user";
import {
  currentDayPlan,
  daytimeSeed,
  pinClockToSeedZoneHour,
  setupStateStoreSuite,
  sql,
  store
} from "./state-store-harness";

/**
 * State-store journeys, part 3 of 12.
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

setupStateStoreSuite("openrhen_state_store_c");

describe("normalized PostgreSQL portal persistence (part 3)", () => {
  // A wake at or before the effective start (a future-dated actual_start_at from clock skew or a
  // stray backfill) must not corrupt allowed_minutes with a zero/negative span — the same "unknown"
  // stance completedSleepMinutesEndingAt takes in engine/core/src/engine.ts.
  it("leaves allowed minutes untouched when the actual start is not before the wake", async () => {
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
    const futureStart = new Date(Date.now() + 60 * 60_000);
    await sql`UPDATE sleep_plans SET actual_start_at=${futureStart} WHERE id=${planned.id}`;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: session.version ?? null,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    const tracked = state.sleepPlans.find((item) => item.id === planned.id)!;
    expect(tracked.status).toBe("completed");
    expect(tracked.allowedMinutes).toBe(plannedMinutes);
  }, 30_000);

  it("rejects a stale client sleep duration instead of recalculating it in the website", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    await sql`UPDATE commitments SET status='cancelled'`;
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: {
        ...state.settings,
        desiredSleepMinutes: 540,
        minimumSleepMinutes: 300,
        lastWokeAt: new Date(now.getTime() - 21 * 60 * 60_000).toISOString(),
        setupCompleted: true
      }
    });
    const sleep = state.sleepPlans.find((item) => item.status === "planned")!;
    expect(sleep.targetMinutes).toBeGreaterThanOrEqual(300);
    await expect(
      store.runActivityCommand({
        commandId: crypto.randomUUID(),
        expectedVersion: sleep.version ?? null,
        type: "start_activity",
        targetType: "sleep",
        targetId: sleep.id,
        plannedMinutes: 1
      })
    ).rejects.toThrow(
      /The plan gives this sleep plan \d+ minutes, not 1.*Repeat the same rhen_activity call with minutes \d+/
    );
    expect((await store.get())?.activeSession).toBeNull();
  }, 30_000);

  it("lets confirmed but not tentative commitments force a visible minimum-sleep shortfall", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    await sql`UPDATE commitments SET status='cancelled'`;
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: {
        ...state.settings,
        desiredSleepMinutes: 540,
        minimumSleepMinutes: 300,
        lastWokeAt: new Date(now.getTime() - 21 * 60 * 60_000).toISOString(),
        setupCompleted: true
      }
    });
    const id = crypto.randomUUID();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id,
        title: "Early tentative work",
        startsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
        status: "tentative",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    });
    let sleep = state.sleepPlans.find((item) => item.status === "planned")!;
    expect(sleep.allowedMinutes).toBeGreaterThanOrEqual(300);
    const commitment = state.commitments.find((item) => item.id === id)!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: commitment.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: { ...commitment, status: "confirmed" }
    });
    sleep = state.sleepPlans.find((item) => item.status === "planned")!;
    expect(sleep.allowedMinutes).toBeLessThan(300);
    expect(sleep.minimumShortfallMinutes).toBeGreaterThan(0);
    expect(sleep.wakeConstraint).toMatchObject({ commitmentId: id, title: "Early tentative work" });
    expect(sleep.explanation).toContain("confirmed commitment");
  }, 30_000);

  it("stores a commitment's presence, and never resets it from a save that does not mention it", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const id = crypto.randomUUID();
    const window = {
      startsAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
      endsAt: new Date(now.getTime() + 5 * 60 * 60_000).toISOString()
    };
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id,
        title: "Swimming carnival",
        ...window,
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        presence: "anchor"
      }
    });
    expect(state.commitments.find((item) => item.id === id)?.presence).toBe("anchor");
    // An importer or a capture proposal saves the same row without an opinion about presence. That
    // silence must not be read as "blocking": it is the absence of an answer, not an answer.
    const stored = state.commitments.find((item) => item.id === id)!;
    const { presence: _omitted, ...withoutPresence } = stored;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: stored.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: { ...withoutPresence, title: "Swimming carnival (finals)" }
    });
    const renamed = state.commitments.find((item) => item.id === id)!;
    expect(renamed.title).toBe("Swimming carnival (finals)");
    expect(renamed.presence).toBe("anchor");
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: renamed.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: { ...renamed, presence: "blocking" }
    });
    expect(state.commitments.find((item) => item.id === id)?.presence).toBe("blocking");
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: state.commitments.find((item) => item.id === id)!.version ?? null,
        type: "save_entity",
        entityType: "commitment",
        entity: { ...state.commitments.find((item) => item.id === id)!, presence: "sometimes" }
      })
    ).rejects.toThrow('Commitment presence "sometimes" is not valid. Use one of: blocking, anchor.');
  }, 30_000);

  // A disruption is not a proposal waiting to be reviewed: it is real the moment it is captured, and
  // the whole point is that the projected day reflows around it without anybody approving anything.
  it("makes a captured disruption a real commitment the projected day plans around", async () => {
    const now = new Date();
    await store.put(daytimeSeed(now));
    const id = crypto.randomUUID();
    const landedAt = new Date(now.getTime() - 60_000);
    const state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id,
        title: "Drive Mum to the shops",
        startsAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        endsAt: new Date(now.getTime() + 150 * 60_000).toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        origin: "disruption",
        disruptionSource: "family",
        landedAt: landedAt.toISOString()
      }
    });
    const [row] = await sql<{ origin: string; disruption_source: string | null; landed_at: Date | null }[]>`
      SELECT origin,disruption_source,landed_at FROM commitments WHERE id=${id}
    `;
    expect(row).toMatchObject({ origin: "disruption", disruption_source: "family" });
    expect(row!.landed_at?.toISOString()).toBe(landedAt.toISOString());
    expect(state.commitments.find((item) => item.id === id)).toMatchObject({
      origin: "disruption",
      disruptionSource: "family",
      landedAt: landedAt.toISOString()
    });
    const dayPlan = await currentDayPlan();
    expect(dayPlan?.blocks.some((block) => block.kind === "commitment" && block.targetId === id)).toBe(true);
    // A source is only ever half of an answer: on its own it says nothing about how the row came to be.
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "commitment",
        entity: {
          id: crypto.randomUUID(),
          title: "Ordinary meeting",
          startsAt: new Date(now.getTime() + 4 * 60 * 60_000).toISOString(),
          endsAt: new Date(now.getTime() + 5 * 60 * 60_000).toISOString(),
          status: "confirmed",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          disruptionSource: "work"
        }
      })
    ).rejects.toThrow("only belongs on a disruption");
  }, 30_000);

  it("keeps a disruption's provenance through an ordinary commitment edit, place and all", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id: "shops", name: "The shops", kind: "location", latitude: -36.1, longitude: 146.9 }
    });
    const id = crypto.randomUUID();
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id,
        title: "Drive Mum to the shops",
        startsAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        endsAt: new Date(now.getTime() + 150 * 60_000).toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        location: "Harbor Mart car park",
        locationId: "shops",
        origin: "disruption",
        disruptionSource: "family",
        disruptionOpenEnded: true,
        landedAt: now.toISOString()
      }
    });
    // The ordinary commitment editor is what a "still out — another hour" nudge goes through, and it
    // has no idea disruptions exist. Round-tripping the stored record through it must not demote the
    // row to a planned commitment, nor blank the place the editor did carry.
    const stored = state.commitments.find((item) => item.id === id)!;
    const editor = commitmentEditorFrom(stored, state.settings);
    const entity = commitmentEntityFrom(editor, id, state.settings.timezone);
    expect(entity).not.toHaveProperty("origin");
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: stored.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: { ...entity, title: "Drive Mum to the shops (longer)" }
    });
    expect(state.commitments.find((item) => item.id === id)).toMatchObject({
      title: "Drive Mum to the shops (longer)",
      origin: "disruption",
      disruptionSource: "family",
      disruptionOpenEnded: true,
      location: "Harbor Mart car park",
      locationId: "shops"
    });
    const [row] = await sql<{ origin: string; disruption_source: string | null; location_id: string | null }[]>`
      SELECT origin,disruption_source,location_id FROM commitments WHERE id=${id}
    `;
    expect(row).toMatchObject({ origin: "disruption", disruption_source: "family", location_id: "shops" });
  }, 30_000);

  // Sleep needs no disruption-specific handling: a night still being forecast is keyed off the
  // instant it starts, so a disruption running past the computed bedtime yields a *different* id —
  // the old row goes and a fresh `planned` one lands after the disruption. This is the whole of the
  // "thaw" the capture design relies on, and it is the reason none of the four columns reach the
  // engine. (A night the user has already overridden by hand is retained verbatim instead and does
  // not move; only a live forecast re-plans.)
  it("re-plans tonight's bedtime around a disruption that runs past it", async () => {
    const now = pinClockToSeedZoneHour();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: {
        ...state.settings,
        desiredSleepMinutes: 480,
        minimumSleepMinutes: 300,
        lastWokeAt: new Date(now.getTime() - 6 * 60 * 60_000).toISOString(),
        setupCompleted: true
      }
    });
    const planned = state.sleepPlans.find((item) => item.status === "planned")!;
    const bedtime = new Date(planned.plannedStartAt);
    const disruptionStart = new Date(bedtime.getTime() - 60 * 60_000);
    const disruptionEnd = new Date(bedtime.getTime() + 90 * 60_000);
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id: crypto.randomUUID(),
        title: "Called away out of town",
        startsAt: disruptionStart.toISOString(),
        endsAt: disruptionEnd.toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        origin: "disruption",
        disruptionSource: "family",
        landedAt: now.toISOString()
      }
    });
    // The night that was planned for the old bedtime is re-planned around the disruption: its window
    // moves clear of the disruption's span rather than staying put and getting double-booked. Most
    // hours that shows up as a fresh id replacing the old one, but when this test runs after the
    // computed bedtime has already passed, "tonight's" plan is itself a missed-start recovery —
    // engine/core/src/recurrence/sleep.ts deliberately keys a missed-start plan's id off `lastWokeAt`
    // rather than its own (ever-advancing) start, precisely so that identity survives recompute after
    // recompute instead of churning any in-progress bedtime routine tied to it. That legitimately keeps
    // the same id here while the start/end still move past the disruption, so the id itself is not a
    // safe thing to assert on at every hour; the window it lands on is (checked below, and via the
    // general invariant a few lines down).
    const replanned = state.sleepPlans.find(
      (item) => item.status === "planned" && item.allowedMinutes >= 300 && new Date(item.plannedStartAt) >= bedtime
    )!;
    expect(new Date(replanned.plannedStartAt).getTime()).toBeGreaterThanOrEqual(disruptionEnd.getTime());
    expect(replanned.overridden).toBeUndefined();
    // Depending on the hour this runs, the planner may also legitimately offer another sleep window
    // elsewhere in the day — e.g. a full catch-up block that fits entirely before the disruption
    // starts (the planning run is timestamped off the real wall clock — see the `fixedNow` comment
    // near the top of this file — so a fixed `now` here cannot pin the hour away, and the size or
    // presence of such a window is incidental to this test). What must hold regardless of the hour
    // is the actual re-planning guarantee: nothing that overlaps the disruption's own time span is
    // ever offered as a real (>= minimum) night — that would mean the disruption got silently
    // double-booked instead of re-planned around.
    for (const item of state.sleepPlans) {
      const start = new Date(item.plannedStartAt);
      const end = new Date(item.plannedWakeAt);
      const overlapsDisruption = start < disruptionEnd && end > disruptionStart;
      if (overlapsDisruption) expect(item.allowedMinutes).toBeLessThan(300);
    }
  }, 30_000);

  // (P3) "Done, heading home": while a disruption's end is only a guess, the engine offers nothing
  // inside the window it holds — there is no telling how long it actually runs. Resolving the guess
  // (the same editor round trip `endDisruptionNow` sends) reopens whatever it was holding shut.
  it("returns evening work once 'Done, heading home' resolves an open-ended disruption", async () => {
    const now = new Date();
    await store.put(daytimeSeed(now));
    const id = crypto.randomUUID();
    const disruptionEnd = new Date(now.getTime() + 4 * 60 * 60_000);
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id,
        title: "Called away for the evening",
        startsAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
        endsAt: disruptionEnd.toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        origin: "disruption",
        disruptionSource: "family",
        disruptionOpenEnded: true,
        landedAt: now.toISOString()
      }
    });
    const stored = state.commitments.find((item) => item.id === id)!;
    expect(stored.disruptionOpenEnded).toBe(true);
    const workInside = (blocks: { kind: string; startsAt: string }[]) =>
      blocks.some(
        (block) =>
          block.kind !== "commitment" &&
          block.kind !== "gap" &&
          new Date(block.startsAt) >= now &&
          new Date(block.startsAt) < disruptionEnd
      );
    const heldDayPlan = await currentDayPlan();
    expect(workInside(heldDayPlan!.blocks)).toBe(false);
    // The same round trip through the ordinary editor mappers `endDisruptionNow` sends — every field
    // the editor carries, `endsAt` moved to now, the open end cleared.
    const editor = commitmentEditorFrom(stored, state.settings);
    const entity = {
      ...commitmentEntityFrom(editor, id, state.settings.timezone),
      endsAt: now.toISOString(),
      disruptionOpenEnded: false
    };
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: stored.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity
    });
    const dayPlan = await currentDayPlan();
    // The evening it was holding shut is offered again.
    expect(workInside(dayPlan!.blocks)).toBe(true);
    const [row] = await sql<{ origin: string; disruption_open_ended: boolean }[]>`
      SELECT origin,disruption_open_ended FROM commitments WHERE id=${id}
    `;
    expect(row).toMatchObject({ origin: "disruption", disruption_open_ended: false });
  }, 30_000);

  // Finishing a tracked timer against an open-ended disruption used to be a pure
  // no-op on the commitment, so the guess stayed open and the renegotiation warning kept coming back
  // even after the user had, in fact, finished. Completing the session now closes the guess the same
  // way "Done, heading home" does — the two tests above and below this one are the other half: the
  // ordinary editor round trip still works, and the two outcomes that do NOT mean "it's over" leave
  // the guess alone.
  it("resolves an open-ended disruption when the timer tracking it is completed", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const id = crypto.randomUUID();
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id,
        title: "Called away",
        startsAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
        endsAt: new Date(now.getTime() + 4 * 60 * 60_000).toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        origin: "disruption",
        disruptionSource: "family",
        disruptionOpenEnded: true,
        landedAt: now.toISOString()
      }
    });
    const commitment = state.commitments.find((item) => item.id === id)!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: commitment.version ?? null,
      type: "start_activity",
      targetType: "fixed_commitment",
      targetId: id,
      phase: "active",
      plannedMinutes: 30
    });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });
    const resolved = state.commitments.find((item) => item.id === id)!;
    expect(resolved.disruptionOpenEnded).toBeUndefined();
    expect(resolved.origin).toBe("disruption");
    // The guess is over: the end moved back from four hours out to (about) when the timer was
    // finished, rather than staying wherever the open-ended guess had it.
    expect(new Date(resolved.endsAt).getTime()).toBeLessThan(new Date(commitment.endsAt).getTime());
    const [row] = await sql<{ disruption_open_ended: boolean }[]>`
      SELECT disruption_open_ended FROM commitments WHERE id=${id}
    `;
    expect(row).toMatchObject({ disruption_open_ended: false });
  }, 30_000);

  it("leaves an open-ended disruption's guess untouched when its timer is marked blocked", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const id = crypto.randomUUID();
    const guessedEnd = new Date(now.getTime() + 4 * 60 * 60_000);
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id,
        title: "Called away",
        startsAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
        endsAt: guessedEnd.toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        origin: "disruption",
        disruptionSource: "family",
        disruptionOpenEnded: true,
        landedAt: now.toISOString()
      }
    });
    const commitment = state.commitments.find((item) => item.id === id)!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: commitment.version ?? null,
      type: "start_activity",
      targetType: "fixed_commitment",
      targetId: id,
      phase: "active",
      plannedMinutes: 30
    });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "blocked",
      note: "Could not get away."
    });
    const untouched = state.commitments.find((item) => item.id === id)!;
    expect(untouched.disruptionOpenEnded).toBe(true);
    expect(untouched.endsAt).toBe(guessedEnd.toISOString());
  }, 30_000);

  it("leaves an open-ended disruption's guess untouched when its timer is marked did-not-start", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const id = crypto.randomUUID();
    const guessedEnd = new Date(now.getTime() + 4 * 60 * 60_000);
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id,
        title: "Called away",
        startsAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
        endsAt: guessedEnd.toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        origin: "disruption",
        disruptionSource: "family",
        disruptionOpenEnded: true,
        landedAt: now.toISOString()
      }
    });
    const commitment = state.commitments.find((item) => item.id === id)!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: commitment.version ?? null,
      type: "start_activity",
      targetType: "fixed_commitment",
      targetId: id,
      phase: "active",
      plannedMinutes: 30
    });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "did_not_start"
    });
    const untouched = state.commitments.find((item) => item.id === id)!;
    expect(untouched.disruptionOpenEnded).toBe(true);
    expect(untouched.endsAt).toBe(guessedEnd.toISOString());
  }, 30_000);

  // Reported 2026-08-17: a manual entry dated a day ahead set last_woke_at into the future, so the
  // planner read the user as still asleep and re-issued a bedtime that waiting could never clear.
  it("refuses a manually logged sleep that has not happened yet", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const state = (await store.get())!;
    const log = (sleepAt: Date, wakeAt: Date, extra: Record<string, unknown> = {}) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity: { sleepAt: sleepAt.toISOString(), wakeAt: wakeAt.toISOString(), ...extra }
      });
    await expect(
      log(new Date(now.getTime() + 20 * 60 * 60_000), new Date(now.getTime() + 28 * 60 * 60_000))
    ).rejects.toThrow("wake time in the future");
    expect((await store.get())?.settings.lastWokeAt).toBe(state.settings.lastWokeAt);
  }, 30_000);

  // Reported 2026-09-04: the create branch (a hand-logged night with no live session
  // behind it) omitted sleep_deficit_minutes from its INSERT, leaving it at the column's 0 default —
  // indistinguishable from "goal fully met" — even for a 20-minute nap 460 minutes short of the
  // desired 480. Every sibling write (override, correction, live Start/Stop finish) computes this
  // column; only the brand-new hand-log path missed it.
  it("computes the sleep deficit on a hand-logged night with no live session behind it", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const state = (await store.get())!;
    const napStart = new Date(now.getTime() - 20 * 60_000);
    const logged = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "sleep_log_entry",
      entity: { sleepAt: napStart.toISOString(), wakeAt: now.toISOString() }
    });
    const nap = logged.sleepPlans.find((item) => item.manual && item.actualStartAt === napStart.toISOString())!;
    expect(nap.allowedMinutes).toBe(20);
    expect(nap.sleepDeficitMinutes).toBe(state.settings.desiredSleepMinutes - 20);
    // Persisted, not just echoed back.
    const reloaded = (await store.get())!;
    const reloadedNap = reloaded.sleepPlans.find((item) => item.id === nap.id)!;
    expect(reloadedNap.sleepDeficitMinutes).toBe(state.settings.desiredSleepMinutes - 20);
  }, 30_000);

  it("edits and removes a manually logged sleep, deriving last wake from what remains", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const log = (sleepAt: Date, wakeAt: Date) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity: { sleepAt: sleepAt.toISOString(), wakeAt: wakeAt.toISOString() }
      });
    const older = new Date(now.getTime() - 30 * 60 * 60_000),
      olderWake = new Date(now.getTime() - 22 * 60 * 60_000);
    state = await log(older, olderWake);
    expect(state.settings.lastWokeAt).toBe(olderWake.toISOString());
    const recent = new Date(now.getTime() - 10 * 60 * 60_000),
      recentWake = new Date(now.getTime() - 2 * 60 * 60_000);
    state = await log(recent, recentWake);
    expect(state.settings.lastWokeAt).toBe(recentWake.toISOString());
    const logged = state.sleepPlans.filter((item) => item.manual);
    expect(logged).toHaveLength(2);
    // Correcting the latest entry must move last wake with it rather than leave the stale value.
    const latest = logged.find((item) => item.actualWakeAt === recentWake.toISOString())!;
    const corrected = new Date(now.getTime() - 3 * 60 * 60_000);
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: latest.version ?? null,
      type: "save_entity",
      entityType: "sleep_log_entry",
      entity: { id: latest.id, sleepAt: recent.toISOString(), wakeAt: corrected.toISOString() }
    });
    expect(state.settings.lastWokeAt).toBe(corrected.toISOString());
    // Removing it must fall back to the older entry, not to null or the removed value.
    const correctedLatest = state.sleepPlans.find((item) => item.id === latest.id)!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: correctedLatest.version ?? null,
      type: "save_entity",
      entityType: "sleep_log_entry",
      entity: { id: latest.id, remove: true }
    });
    expect(state.sleepPlans.filter((item) => item.manual)).toHaveLength(1);
    expect(state.settings.lastWokeAt).toBe(olderWake.toISOString());
  }, 30_000);

  it("keeps a wake recorded directly when an older night is logged, and moves on for a later one", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const hours = (count: number) => new Date(now.getTime() - count * 60 * 60_000);
    const log = (sleepAt: Date, wakeAt: Date) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity: { sleepAt: sleepAt.toISOString(), wakeAt: wakeAt.toISOString() }
      });
    state = await log(hours(40), hours(32));
    // An agent says when the person woke, with only that field: the rest of settings is untouched.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { lastWokeAt: hours(4).toISOString() }
    });
    expect(state.settings.lastWokeAt).toBe(hours(4).toISOString());
    // Logging an earlier night does not pull it back to that night's wake.
    state = await log(hours(30), hours(24));
    expect(state.settings.lastWokeAt).toBe(hours(4).toISOString());
    // A night that ended later than it does take over.
    state = await log(hours(10), hours(2));
    expect(state.settings.lastWokeAt).toBe(hours(2).toISOString());
  }, 30_000);

  // An agent told "bed at 11:40, up at 7:30" saved a second night for hours the person had already logged
  // by hand: the history double-counted the sleep and the latest wake was whichever was written last.
  it("refuses a logged night that overlaps another recorded one, and lets touching nights stand", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const userId = await ensureUser(sql);
    const hours = (count: number) => new Date(now.getTime() - count * 60 * 60_000);
    const write = (entity: Record<string, unknown>, expectedVersion: number | null = null) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity
      });
    const log = (from: number, to: number) =>
      write({ sleepAt: hours(from).toISOString(), wakeAt: hours(to).toISOString() });
    const zone = (await sql<{ timezone: string | null }[]>`SELECT timezone FROM users WHERE id=${userId}`)[0]?.timezone;
    const local = (moment: Date) => formatZonedMoment(moment, zone ?? "UTC", now);

    let state = await log(60, 52);
    const night = state.sleepPlans.find((item) => item.manual)!;
    // Over its end, over its start, inside it, around it: each is refused naming the night and how to correct it.
    for (const [from, to] of [
      [56, 48],
      [64, 56],
      [58, 54],
      [70, 40]
    ] as const)
      await expect(log(from, to)).rejects.toThrow(
        `overlaps one already logged, from ${local(hours(60))} to ${local(hours(52))} (id ${night.id}). To correct that night, update it by its id`
      );
    state = (await store.get())!;
    expect(state.sleepPlans.filter((item) => item.manual)).toHaveLength(1);
    expect(state.settings.lastWokeAt).toBe(hours(52).toISOString());
    // A night tracked live is a recorded night like any other.
    const tracked = crypto.randomUUID();
    await sql`
      INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,explanation,status,actual_start_at,actual_wake_at)
      VALUES (${tracked},${userId},${hours(100)},${hours(92)},480,480,'Tracked night.','completed',${hours(100)},${hours(92)})
    `;
    await expect(log(96, 90)).rejects.toThrow(`(id ${tracked})`);
    // Touching is not overlapping: the night before ends as this one starts, the next starts as it ends.
    await log(68, 60);
    state = await log(52, 44);
    expect(state.sleepPlans.filter((item) => item.manual)).toHaveLength(3);
    expect(state.settings.lastWokeAt).toBe(hours(44).toISOString());
    // An update is held to the same rule against the other nights, and is never its own overlap.
    const latest = state.sleepPlans.find((item) => item.actualWakeAt === hours(44).toISOString())!;
    await expect(
      write(
        { id: latest.id, sleepAt: hours(54).toISOString(), wakeAt: hours(44).toISOString() },
        latest.version ?? null
      )
    ).rejects.toThrow(`(id ${night.id})`);
    state = await write(
      { id: night.id, sleepAt: hours(60).toISOString(), wakeAt: hours(52).toISOString() },
      night.version ?? null
    );
    const kept = state.sleepPlans.find((item) => item.id === night.id)!;
    expect(kept.version).toBe((night.version ?? 0) + 1);
    state = await write(
      { id: night.id, sleepAt: hours(59).toISOString(), wakeAt: hours(53).toISOString() },
      kept.version ?? null
    );
    expect(state.sleepPlans.find((item) => item.id === night.id)!.actualStartAt).toBe(hours(59).toISOString());
    expect(state.settings.lastWokeAt).toBe(hours(44).toISOString());
  }, 30_000);
});
