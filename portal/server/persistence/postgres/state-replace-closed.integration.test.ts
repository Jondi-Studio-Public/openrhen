import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { ensureUser } from "./ensure-user";
import { fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * A whole-state put deletes and rewrites the plan tables, and the state document does not carry closed_* (archive-removals
 * design, section 5). `replaceState` reads the closed stamps first and puts them back, so a put never re-dates a close.
 */

setupStateStoreSuite("openrhen_state_replace_closed");

describe("whole-state put and closed stamps", () => {
  it("keeps closed_at, closed_by and closed_reason on a closed row the put rewrites", async () => {
    const state = createSeedState(fixedNow);
    await store.put(state);
    const userId = await ensureUser(sql);
    const closedAt = new Date("2026-01-02T03:04:05.000Z");
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('priorities.actor', 'person', true)`;
      await tx`UPDATE areas SET status = 'archived', closed_at = ${closedAt}, closed_reason = 'tidying'
        WHERE id = (SELECT id FROM areas WHERE user_id = ${userId} ORDER BY sort_order LIMIT 1)`;
    });
    const before = await sql<{ id: string; closed_by: string | null }[]>`
      SELECT id, closed_by FROM areas WHERE user_id = ${userId} AND status = 'archived'`;
    expect(before).toHaveLength(1);

    const archived = (await sql<{ name: string }[]>`SELECT name FROM areas WHERE id = ${before[0]!.id}`)[0]!.name;
    const next = createSeedState(fixedNow);
    const area = next.areas.find((candidate) => candidate.name === archived)!;
    area.status = "archived";
    await store.put(next);

    const after = await sql<
      { closed_at: Date; closed_by: string | null; closed_reason: string | null; closed_from_status: string | null }[]
    >`SELECT closed_at, closed_by, closed_reason, closed_from_status FROM areas WHERE id = ${before[0]!.id}`;
    expect(after).toHaveLength(1);
    expect(after[0]!.closed_at.toISOString()).toBe(closedAt.toISOString());
    expect(after[0]!.closed_reason).toBe("tidying");
    expect(after[0]!.closed_by).toBe(before[0]!.closed_by);
  });
});
