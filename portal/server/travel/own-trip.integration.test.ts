import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { fixedNow, setupStateStoreSuite, sql, store } from "@/server/persistence/postgres/state-store-harness";
import { InvalidCommandError } from "@/server/persistence/postgres/command-errors";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { LocationObservationStore } from "@/server/location/location-observation-store";
import { assertLocation, reading } from "@/server/location/location-test-fixtures";

/**
 * Own trips (the travel time model design note, "Own trips (T2)"): an arrival after a fresh
 * assertion — a real place, not stale — records a Google-free sample in the same transaction as the
 * arrival write, without an extra `recordStateChange` call of its own.
 */
setupStateStoreSuite("openrhen_own_trip");

const HOME = { id: "home-place", latitude: -33.87, longitude: 151.21 };
const WORK = { id: "work-place", latitude: -33.88, longitude: 151.2 };
const CAFE = { id: "cafe-place", latitude: -33.875, longitude: 151.205 };
const WAYPOINT = { id: "waypoint-place", latitude: -33.878, longitude: 151.208 };

async function savePlace(place: { id: string; latitude: number; longitude: number }) {
  await store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: null,
    type: "save_entity",
    entityType: "condition_definition",
    entity: { id: place.id, name: place.id, kind: "location", latitude: place.latitude, longitude: place.longitude }
  });
}

describe("own trips on arrival", () => {
  it("records a sample when a fresh assertion is followed by an arrival somewhere else", async () => {
    await store.put(createSeedState(fixedNow));
    await savePlace(HOME);
    await savePlace(WORK);

    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "current_availability",
      entity: {
        currentEnergy: state.currentEnergy,
        assertedConditions: state.assertedConditions,
        currentSituation: { locationId: HOME.id }
      }
    });
    expect(state.currentSituation.locationId).toBe(HOME.id);

    // Backdates the HOME assertion's own clock by 20 minutes — well inside both the "not stale"
    // window (8 hours) and the own-trip gap cap (4 hours) — so the recorded gap is a real, easily
    // distinguished number of minutes rather than whatever the test's own wall-clock overhead happens
    // to be between the two saves.
    await sql`
      UPDATE user_preferences
      SET current_situation = jsonb_set(current_situation, '{locationSetAt}', to_jsonb((now() - interval '20 minutes')::text))
    `;

    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "current_availability",
      entity: {
        currentEnergy: state.currentEnergy,
        assertedConditions: state.assertedConditions,
        currentSituation: { locationId: WORK.id }
      }
    });
    expect(state.currentSituation.locationId).toBe(WORK.id);

    const samples = await sql<
      { origin_location_id: string; destination_location_id: string; source: string; minutes: string }[]
    >`SELECT origin_location_id, destination_location_id, source, minutes FROM journey_samples WHERE source='own_trip'`;
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      origin_location_id: HOME.id,
      destination_location_id: WORK.id,
      source: "own_trip"
    });
    expect(Number(samples[0]!.minutes)).toBeCloseTo(20, 0);
  });

  it("records a phone-sustained arrival from when the sustained run began, not from now", async () => {
    await store.put(createSeedState(fixedNow));
    await savePlace(HOME);
    await savePlace(WORK); // unused here, but keeps the place ids apart from the other test's
    await savePlace(CAFE);
    await savePlace(WAYPOINT);
    const userId = await ensureUser(sql);

    // A fresh HOME assertion well in the past (90 minutes ago) — not stale, and far enough back that
    // the departure evidence below is unambiguous.
    await assertLocation(sql, userId, HOME.id, new Date(Date.now() - 90 * 60_000));

    const observationStore = new LocationObservationStore(sql);
    // An intermediate reading away from home — matched to a different place than the eventual
    // arrival, 40 minutes ago — is real departure evidence (the first device observation away from
    // P) without itself joining the cafe's sustained run below.
    // The server's own clock is passed too: sustained presence is measured on receipt, not on the
    // reading's own date, so each ping is delivered when it was taken.
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await observationStore.recordPhonePing(reading(WAYPOINT, 40), minutesAgo(40));
    // The sustained run at the cafe: two agreeing readings 12 minutes apart — the first 12 minutes
    // ago, the second just now — cross the 10-minute sustained-presence threshold on the second ping.
    const firstOfRun = await observationStore.recordPhonePing(reading(CAFE, 12), minutesAgo(12));
    expect(firstOfRun.decision).not.toBe("asserted"); // one reading alone is never sustained
    const arrived = await observationStore.recordPhonePing(reading(CAFE, 0));
    expect(arrived.decision).toBe("asserted");
    expect(arrived.locationId).toBe(CAFE.id);

    const samples = await sql<
      { origin_location_id: string; destination_location_id: string; minutes: string }[]
    >`SELECT origin_location_id, destination_location_id, minutes FROM journey_samples WHERE source='own_trip'`;
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ origin_location_id: HOME.id, destination_location_id: CAFE.id });
    // Arrival is the sustained run's own start (12 minutes ago), not the final ping (now): the gap
    // from the 40-minutes-ago departure evidence to a 12-minutes-ago arrival is 28 minutes. Using
    // "now" instead (the bug being fixed) would have produced 40 minutes.
    expect(Number(samples[0]!.minutes)).toBeCloseTo(28, 0);
  });

  it("records nothing on the first-ever assertion (no previous place to have left)", async () => {
    await store.put(createSeedState(fixedNow));
    await savePlace(HOME);
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "current_availability",
      entity: {
        currentEnergy: state.currentEnergy,
        assertedConditions: state.assertedConditions,
        currentSituation: { locationId: HOME.id }
      }
    });
    expect(state.currentSituation.locationId).toBe(HOME.id);

    const samples = await sql`SELECT id FROM journey_samples WHERE source='own_trip'`;
    expect(samples).toHaveLength(0);
  });

  it("uses On my way's own departedAt when underway names this arrival's origin", async () => {
    await store.put(createSeedState(fixedNow));
    await savePlace(HOME);
    await savePlace(WORK);

    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "current_availability",
      entity: {
        currentEnergy: state.currentEnergy,
        assertedConditions: state.assertedConditions,
        currentSituation: { locationId: HOME.id }
      }
    });

    // On my way tapped 45 minutes before arrival — a departure figure the device trail alone would
    // not reconstruct (no observations at all here), and that the recent-assertion heuristic would
    // otherwise read as only the few seconds since the previous save.
    const departedAt = new Date(Date.now() - 45 * 60_000).toISOString();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "current_availability",
      entity: {
        currentEnergy: state.currentEnergy,
        assertedConditions: state.assertedConditions,
        currentSituation: {
          underway: {
            commitmentId: "c1",
            occurrenceStartsAt: fixedNow.toISOString(),
            fromLocationId: HOME.id,
            departedAt
          }
        }
      }
    });
    expect(state.currentSituation.underway).toMatchObject({ fromLocationId: HOME.id });
    // The server stamps `departedAt` itself (a client's value is ignored), so the 45-minute departure
    // is placed in storage rather than sent.
    expect(state.currentSituation.underway?.departedAt).not.toBe(departedAt);
    await sql`
      UPDATE user_preferences
      SET current_situation = jsonb_set(current_situation, '{underway,departedAt}', to_jsonb(${departedAt}::text))
    `;

    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "current_availability",
      entity: {
        currentEnergy: state.currentEnergy,
        assertedConditions: state.assertedConditions,
        currentSituation: { locationId: WORK.id }
      }
    });
    expect(state.currentSituation.locationId).toBe(WORK.id);
    expect(state.currentSituation.underway).toBeNull();

    const samples = await sql<{ minutes: string }[]>`
      SELECT minutes FROM journey_samples WHERE source='own_trip' AND origin_location_id=${HOME.id} AND destination_location_id=${WORK.id}
    `;
    expect(samples).toHaveLength(1);
    expect(Number(samples[0]!.minutes)).toBeCloseTo(45, 0);
  });
  it("refuses a locationId that is not an active saved place, and still accepts null", async () => {
    await store.put(createSeedState(fixedNow));
    await savePlace(HOME);
    let state = (await store.get())!;
    const assert = (locationId: unknown) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "current_availability",
        entity: {
          currentEnergy: state.currentEnergy,
          assertedConditions: state.assertedConditions,
          currentSituation: { locationId }
        }
      });
    await expect(assert("nowhere")).rejects.toBeInstanceOf(InvalidCommandError);
    await expect(assert("")).rejects.toBeInstanceOf(InvalidCommandError);
    await expect(assert(` ${HOME.id} `)).rejects.toBeInstanceOf(InvalidCommandError);
    state = await assert(HOME.id);
    expect(state.currentSituation.locationId).toBe(HOME.id);
    state = await assert(null);
    expect(state.currentSituation.locationId).toBeNull();
  });

  it("still saves the whole situation once the stored place is archived, and keeps the trip's departure", async () => {
    await store.put(createSeedState(fixedNow));
    await savePlace(HOME);
    const save = async (locationId: string) => {
      const current = (await store.get())!;
      return store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: current.settings.version ?? null,
        type: "save_entity",
        entityType: "current_availability",
        entity: {
          currentEnergy: current.currentEnergy,
          assertedConditions: current.assertedConditions,
          currentSituation: { ...current.currentSituation, locationId, travelOff: true }
        }
      });
    };
    await save(HOME.id);
    const departedAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const underway = {
      commitmentId: "c1",
      occurrenceStartsAt: fixedNow.toISOString(),
      fromLocationId: HOME.id,
      departedAt
    };
    await sql`UPDATE user_preferences SET current_situation = jsonb_set(current_situation, '{underway}', ${sql.json(underway as never)})`;
    await sql`UPDATE condition_definitions SET status='archived' WHERE id=${HOME.id}`;
    // The CLI's `save current_availability` sends the stored situation back whole, underway included.
    const state = await save(HOME.id);
    expect(state.currentSituation).toMatchObject({ locationId: HOME.id, travelOff: true, underway });
  });

  it("stores a malformed underway as nothing, so a later move still succeeds", async () => {
    await store.put(createSeedState(fixedNow));
    await savePlace(HOME);
    await savePlace(WORK);
    let state = (await store.get())!;
    const save = (currentSituation: Record<string, unknown>) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "current_availability",
        entity: { currentEnergy: state.currentEnergy, assertedConditions: state.assertedConditions, currentSituation }
      });
    state = await save({ locationId: HOME.id });
    state = await save({
      underway: { commitmentId: "x", occurrenceStartsAt: "x", fromLocationId: HOME.id, departedAt: "x" }
    });
    expect(state.currentSituation.underway ?? null).toBeNull();
    state = await save({ locationId: WORK.id });
    expect(state.currentSituation.locationId).toBe(WORK.id);
  });
});
