import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_JOB_TYPE } from "@openrhen/database";
import { planForecastResponseSchema } from "@openrhen/contracts";
import { createSeedState } from "@/state/portal-state";
import { saveEntity } from "./entity-commands";
import { refreshPlanning, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * Primary case, fixed: "Edit this occurrence" on a recurring commitment marks the row
 * `schedule_source='custom'`, and the edit survives the recalculation the save itself enqueues — both
 * in the engine's `commitmentRepeats` (`deriveCommitmentRepeats`'s overlay, `engine/core/src/engine.ts`)
 * and in the `commitments` row (the persist upsert's `schedule_source` guard,
 * `plan-forecast-runtime.ts`). **Use the series** (`revertCommitmentToSeriesCommand`, `commitment-save.ts`) sends the
 * stored row's own values back with `scheduleSource: "inherit"`, which detaches nothing itself but lets
 * the next recalculation heal the row from the rule again. Every save here goes through the file's one
 * `recordStateChange`, so each also writes a `write_rows` row and enqueues that recalculation.
 *
 * The secondary case (a series edit reaching an occurrence already under way) is pinned in
 * platform/database/src/planning/plan-forecast-persist-audit.integration.test.ts.
 */

setupStateStoreSuite("openrhen_occurrence_edit");

const HOUR = 3_600_000;

async function changeLogCount() {
  const rows = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM write_rows`;
  return Number(rows[0]!.count);
}

async function pendingRecalculationJobCount() {
  const rows = await sql<
    { count: string }[]
  >`SELECT COUNT(*)::text AS count FROM jobs WHERE type=${PLAN_FORECAST_JOB_TYPE}`;
  return Number(rows[0]!.count);
}

describe("an occurrence-level edit to a recurring commitment", () => {
  it("survives a full recalculation, and Use the series reverts it", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const ruleId = crypto.randomUUID();
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(now);
    const state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id: ruleId,
        title: "Shift",
        timezone: "Australia/Sydney",
        startDate: localDate,
        repeat: { unit: "days", intervalDays: 7 },
        localStartTime: "09:00",
        localEndTime: "17:00",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        presence: "blocking"
      }
    });
    // Next week's occurrence, so it cannot already be under way: that is the secondary case, not this one.
    const occurrence = state.commitments
      .filter(
        (item) => item.recurrenceRuleId === ruleId && new Date(item.startsAt).getTime() > now.getTime() + 6 * 24 * HOUR
      )
      .sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime())[0];
    expect(occurrence, "the materialiser should have produced next week's occurrence").toBeDefined();
    const ruleStartsAt = new Date(occurrence!.startsAt);
    const ruleEndsAt = new Date(occurrence!.endsAt);
    const editedStartsAt = new Date(ruleStartsAt.getTime() + HOUR);
    const editedEndsAt = new Date(ruleEndsAt.getTime() + HOUR);

    const storedTimes = async () => {
      const rows = await sql<{ starts_at: Date; ends_at: Date; schedule_source: string }[]>`
        SELECT starts_at, ends_at, schedule_source FROM commitments WHERE id=${occurrence!.id}
      `;
      return rows[0]!;
    };

    const storedVersion = async () => {
      const rows = await sql<{ version: number }[]>`SELECT version FROM commitments WHERE id=${occurrence!.id}`;
      return rows[0]!.version;
    };

    const repeatsFor = async () => {
      const runs = await sql<{ result: unknown }[]>`
        SELECT result FROM planning_runs WHERE superseded_at IS NULL ORDER BY calculated_at DESC LIMIT 1
      `;
      expect(runs, "the save should have produced a planning run").toHaveLength(1);
      // `derivedState` is typed as plain JSON at the contract boundary; these are the engine's repeat rows.
      const repeats = planForecastResponseSchema.parse(runs[0]!.result).derivedState.commitmentRepeats as Array<{
        id: string;
        startsAt: string;
        endsAt: string;
      }>;
      const planned = repeats.find((item) => item.id === occurrence!.id);
      expect(planned, "the engine should still plan this occurrence").toBeDefined();
      return planned!;
    };

    // "Edit this occurrence": 9–5 becomes 10–6 on this one date. The stored row is spread whole, so
    // the payload carries the row's own `scheduleSource: "inherit"` — as any caller that round-trips a
    // stored record does. A real edit must still detach the row: `inherit` only reattaches when
    // nothing else in the payload changed (Use the series, below). Called unwrapped, so the save lands
    // without the harness's automatic replan and the edit, and its own write_rows/job writes, can be
    // seen before the recalculation runs.
    expect(occurrence!.scheduleSource, "a freshly materialised occurrence tracks its rule").toBe("inherit");
    const { scheduleSource: _storedScheduleSource, ...occurrenceForEdit } = occurrence!;
    const changeLogBeforeEdit = await changeLogCount();
    const jobsBeforeEdit = await pendingRecalculationJobCount();
    await saveEntity(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: occurrence!.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: { ...occurrence!, startsAt: editedStartsAt.toISOString(), endsAt: editedEndsAt.toISOString() }
    });
    expect(await changeLogCount(), "the occurrence save should write one write_rows row").toBe(changeLogBeforeEdit + 1);
    expect(await pendingRecalculationJobCount(), "the occurrence save should enqueue a recalculation").toBeGreaterThan(
      jobsBeforeEdit
    );
    expect(
      await storedTimes(),
      "the occurrence save itself should store the edited times and mark the row custom"
    ).toEqual({
      starts_at: editedStartsAt,
      ends_at: editedEndsAt,
      schedule_source: "custom"
    });

    // The recalculation the save enqueued, run through the real engine.
    await refreshPlanning();

    const plannedAfterEdit = await repeatsFor();
    expect(new Date(plannedAfterEdit.startsAt), "the engine should keep the edited time").toEqual(editedStartsAt);
    expect(await storedTimes(), "the edit should survive the persist upsert").toEqual({
      starts_at: editedStartsAt,
      ends_at: editedEndsAt,
      schedule_source: "custom"
    });

    // **Use the series**: the stored (edited) row's own values, plus scheduleSource: "inherit".
    const revertExpectedVersion = await storedVersion();
    const changeLogBeforeRevert = await changeLogCount();
    const jobsBeforeRevert = await pendingRecalculationJobCount();
    await saveEntity(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: revertExpectedVersion,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id: occurrence!.id,
        title: occurrenceForEdit.title,
        startsAt: editedStartsAt.toISOString(),
        endsAt: editedEndsAt.toISOString(),
        status: occurrenceForEdit.status,
        setupBeforeMinutes: occurrenceForEdit.setupBeforeMinutes,
        transitionAfterMinutes: occurrenceForEdit.transitionAfterMinutes,
        shareToCalendar: occurrenceForEdit.shareToCalendar ?? false,
        scheduleSource: "inherit"
      }
    });
    expect(await changeLogCount(), "Use the series should write one write_rows row").toBe(changeLogBeforeRevert + 1);
    expect(await pendingRecalculationJobCount(), "Use the series should enqueue a recalculation").toBeGreaterThan(
      jobsBeforeRevert
    );
    expect((await storedTimes()).schedule_source, "the row reattaches immediately").toBe("inherit");

    // The recalculation Use the series enqueued: the rule heals the row and the plan back to 9–5.
    await refreshPlanning();

    const plannedAfterRevert = await repeatsFor();
    expect(new Date(plannedAfterRevert.startsAt), "the engine should plan the rule's own time again").toEqual(
      ruleStartsAt
    );
    expect(await storedTimes(), "the persist upsert should heal the row back to the rule's times").toEqual({
      starts_at: ruleStartsAt,
      ends_at: ruleEndsAt,
      schedule_source: "inherit"
    });
  }, 60_000);
});
