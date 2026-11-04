import { describe, expect, it } from "vitest";
import { ensureUser } from "./ensure-user";
import { readPortalState } from "./state-read";
import { replaceState } from "./state-replace";
import { daytimeSeed, setupStateStoreSuite, sql } from "./state-store-harness";

/**
 * `ranking-consistency`: `readPortalState`'s
 * `lastEndedSessions` is the latest *ended* session per target — action or deliverable, keyed by
 * `action_id` or (for a deliverable) `target_id` — and a still-running or paused session, which has
 * `ended_at IS NULL`, never counts.
 */

setupStateStoreSuite("openrhen_rank_session_break");

describe("readPortalState: lastEndedSessions", () => {
  it("returns the latest ended session per target, and nothing for running, paused or never-ended sessions", async () => {
    const now = new Date();
    const userId = await ensureUser(sql);
    await replaceState(sql, userId, daytimeSeed(now));
    const actionId = (await readPortalState(sql))!.actions[0]!.id;

    const olderEndedAt = new Date(now.getTime() - 3 * 60 * 60_000);
    const olderId = crypto.randomUUID();
    await sql`
      INSERT INTO sessions (id, user_id, action_id, status, planned_started_at, planned_end_at, started_at, ended_at, planned_minutes, active_minutes, remaining_before_minutes)
      VALUES (${olderId}, ${userId}, ${actionId}, 'completed', ${olderEndedAt}, ${olderEndedAt}, ${olderEndedAt}, ${olderEndedAt}, 60, 60, 0)
    `;
    const latestEndedAt = new Date(now.getTime() - 30 * 60_000);
    const latestId = crypto.randomUUID();
    await sql`
      INSERT INTO sessions (id, user_id, action_id, status, planned_started_at, planned_end_at, started_at, ended_at, planned_minutes, active_minutes, remaining_before_minutes)
      VALUES (${latestId}, ${userId}, ${actionId}, 'completed', ${latestEndedAt}, ${latestEndedAt}, ${latestEndedAt}, ${latestEndedAt}, 45, 45, 0)
    `;

    const deliverableTargetId = crypto.randomUUID();
    const deliverableEndedAt = new Date(now.getTime() - 10 * 60_000);
    const deliverableSessionId = crypto.randomUUID();
    await sql`
      INSERT INTO sessions (id, user_id, target_type, target_id, target_title, status, planned_started_at, planned_end_at, started_at, ended_at, planned_minutes, active_minutes, remaining_before_minutes)
      VALUES (${deliverableSessionId}, ${userId}, 'deliverable', ${deliverableTargetId}, 'Assessment', 'completed', ${deliverableEndedAt}, ${deliverableEndedAt}, ${deliverableEndedAt}, ${deliverableEndedAt}, 30, 30, 0)
    `;

    // A still-running session on a different action must never count, whatever its `active_minutes`.
    const runningActionId = crypto.randomUUID();
    await sql`
      INSERT INTO actions (id, project_id, title, status, optimistic_minutes, expected_minutes, pessimistic_minutes, remaining_minutes, energy, minimum_session_minutes, maximum_session_minutes, splittable, setup_minutes, importance, consequence)
      SELECT ${runningActionId}, project_id, 'Running action', 'active', 20, 30, 45, 30, 'medium', 15, 45, true, 0, 3, 3
      FROM actions WHERE id = ${actionId}
    `;
    const runningId = crypto.randomUUID();
    await sql`
      INSERT INTO sessions (id, user_id, action_id, status, planned_started_at, planned_end_at, started_at, planned_minutes, active_minutes, remaining_before_minutes)
      VALUES (${runningId}, ${userId}, ${runningActionId}, 'running', ${now}, ${now}, ${now}, 30, 30, 30)
    `;

    // A paused session, likewise never counted: `ended_at` is null while paused.
    const pausedActionId = crypto.randomUUID();
    await sql`
      INSERT INTO actions (id, project_id, title, status, optimistic_minutes, expected_minutes, pessimistic_minutes, remaining_minutes, energy, minimum_session_minutes, maximum_session_minutes, splittable, setup_minutes, importance, consequence)
      SELECT ${pausedActionId}, project_id, 'Paused action', 'active', 20, 30, 45, 30, 'medium', 15, 45, true, 0, 3, 3
      FROM actions WHERE id = ${actionId}
    `;
    const pausedId = crypto.randomUUID();
    await sql`
      INSERT INTO sessions (id, user_id, action_id, status, planned_started_at, planned_end_at, started_at, planned_minutes, active_minutes, remaining_before_minutes)
      VALUES (${pausedId}, ${userId}, ${pausedActionId}, 'paused', ${now}, ${now}, ${now}, 30, 10, 30)
    `;

    const state = (await readPortalState(sql))!;
    const byTarget = new Map(state.lastEndedSessions.map((entry) => [entry.targetId, entry]));

    // Only the latest of the two ended sessions on the same action survives.
    expect(byTarget.get(actionId)?.endedAt).toBe(latestEndedAt.toISOString());
    expect(byTarget.get(actionId)?.focusedMinutes).toBe(45);

    // The deliverable's session is keyed by its own target id, not any forecast-unit id.
    expect(byTarget.get(deliverableTargetId)?.endedAt).toBe(deliverableEndedAt.toISOString());
    expect(byTarget.get(deliverableTargetId)?.focusedMinutes).toBe(30);

    // Running and paused sessions never contribute an entry for their own action.
    expect(byTarget.has(runningActionId)).toBe(false);
    expect(byTarget.has(pausedActionId)).toBe(false);
  }, 30_000);
});
