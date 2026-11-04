import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { setupStateStoreSuite, sql, fixedNow, unplannedStore as store } from "./state-store-harness";

/**
 * `projects.last_reviewed_at` (migration 0122): written only by the "confirm project still wanted" command,
 * never by an ordinary project save, whatever the save's payload says.
 */
setupStateStoreSuite("openrhen_project_review");

type Project = NonNullable<Awaited<ReturnType<typeof store.get>>>["projects"][number];

async function seedProject(): Promise<Project> {
  await store.put(createSeedState(fixedNow));
  return (await store.get())!.projects[0]!;
}

const plainSave = (project: Project, extra: Record<string, unknown> = {}) =>
  store.saveProject({
    expectedVersion: project.version!,
    project: {
      id: project.id,
      outcomeId: project.outcomeId,
      title: `${project.title} (edited)`,
      status: project.status,
      uncertainty: project.uncertainty,
      consequence: project.consequence,
      ...extra
    } as never
  });

describe("confirmProjectWanted", () => {
  it("starts empty, then stamps now, bumps the version and reads back in state", async () => {
    const project = await seedProject();
    expect(project.lastReviewedAt).toBeUndefined();
    const before = Date.now();
    const state = await store.confirmProjectWanted({ projectId: project.id, expectedVersion: project.version! });
    const kept = state.projects.find((item) => item.id === project.id)!;
    expect(kept.version).toBe(project.version! + 1);
    expect(new Date(kept.lastReviewedAt!).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(kept.status).toBe(project.status);
    expect(kept.title).toBe(project.title);
    // The migration's column holds it, as a timestamptz.
    const rows = await sql<{ last_reviewed_at: Date | null }[]>`SELECT last_reviewed_at FROM projects`;
    expect(rows.filter((row) => row.last_reviewed_at instanceof Date)).toHaveLength(1);
  });

  it("is idempotent for a repeated command id", async () => {
    const project = await seedProject();
    const command = { commandId: crypto.randomUUID(), projectId: project.id, expectedVersion: project.version! };
    await store.confirmProjectWanted(command);
    const again = await store.confirmProjectWanted(command);
    expect(again.projects.find((item) => item.id === project.id)!.version).toBe(project.version! + 1);
  });

  it("refuses a stale version and an unknown project", async () => {
    const project = await seedProject();
    await store.confirmProjectWanted({ projectId: project.id, expectedVersion: project.version! });
    await expect(
      store.confirmProjectWanted({ projectId: project.id, expectedVersion: project.version! })
    ).rejects.toThrow(/changed after you read it/);
    await expect(store.confirmProjectWanted({ projectId: "no-such-project", expectedVersion: 1 })).rejects.toThrow(
      /no longer exists/
    );
  });

  it("puts an earlier value (or none) back when the command carries reviewedAt, as undo does", async () => {
    const project = await seedProject();
    const kept = (
      await store.confirmProjectWanted({ projectId: project.id, expectedVersion: project.version! })
    ).projects.find((item) => item.id === project.id)!;
    const restored = await store.confirmProjectWanted({
      projectId: project.id,
      expectedVersion: kept.version!,
      reviewedAt: null
    });
    expect(restored.projects.find((item) => item.id === project.id)!.lastReviewedAt).toBeUndefined();
    const earlier = "2026-10-01T00:00:00.000Z";
    const set = await store.confirmProjectWanted({
      projectId: project.id,
      expectedVersion: kept.version! + 1,
      reviewedAt: earlier
    });
    expect(set.projects.find((item) => item.id === project.id)!.lastReviewedAt).toBe(earlier);
  });
  it("clamps a stamp later than now, so a project cannot hide from the stale list", async () => {
    const project = await seedProject();
    const after = Date.now();
    const state = await store.confirmProjectWanted({
      projectId: project.id,
      expectedVersion: project.version!,
      reviewedAt: "2099-01-01T00:00:00.000Z"
    });
    const kept = new Date(state.projects.find((item) => item.id === project.id)!.lastReviewedAt!).getTime();
    expect(kept).toBeLessThanOrEqual(Date.now());
    expect(kept).toBeGreaterThanOrEqual(after - 1000);
  });
});

describe("confirmProjectWanted as overdue_seen (migration 0123)", () => {
  it("stamps overdueSeenAt, not lastReviewedAt, and undo clears it", async () => {
    const project = await seedProject();
    const seen = (
      await store.confirmProjectWanted({
        projectId: project.id,
        expectedVersion: project.version!,
        kind: "overdue_seen"
      })
    ).projects.find((item) => item.id === project.id)!;
    expect(seen.overdueSeenAt).toBeDefined();
    expect(seen.lastReviewedAt).toBeUndefined();
    expect(seen.version).toBe(project.version! + 1);
    const cleared = (
      await store.confirmProjectWanted({
        projectId: project.id,
        expectedVersion: seen.version!,
        kind: "overdue_seen",
        reviewedAt: null
      })
    ).projects.find((item) => item.id === project.id)!;
    expect(cleared.overdueSeenAt).toBeUndefined();
  });

  it("is kept by an ordinary project save and carried by a whole-state put", async () => {
    const project = await seedProject();
    const seen = (
      await store.confirmProjectWanted({
        projectId: project.id,
        expectedVersion: project.version!,
        kind: "overdue_seen"
      })
    ).projects.find((item) => item.id === project.id)!;
    const saved = (await plainSave(seen)).projects.find((item) => item.id === project.id)!;
    expect(saved.overdueSeenAt).toBe(seen.overdueSeenAt);
    await store.put((await store.get())!);
    expect((await store.get())!.projects.find((item) => item.id === project.id)!.overdueSeenAt).toBe(
      seen.overdueSeenAt
    );
  });
});

describe("a whole-state put", () => {
  it("carries lastReviewedAt through and reads it back", async () => {
    const seed = createSeedState(fixedNow);
    const reviewedAt = new Date(fixedNow.getTime() - 3 * 86_400_000).toISOString();
    const [first, ...rest] = seed.projects;
    await store.put({ ...seed, projects: [{ ...first!, lastReviewedAt: reviewedAt }, ...rest] });
    const read = (await store.get())!.projects;
    expect(new Date(read.find((item) => item.title === first!.title)!.lastReviewedAt!).toISOString()).toBe(reviewedAt);
    expect(read.filter((item) => item.lastReviewedAt)).toHaveLength(1);
  });
});

describe("an ordinary project save", () => {
  it("keeps the stored lastReviewedAt, whatever the payload says", async () => {
    const project = await seedProject();
    const kept = (
      await store.confirmProjectWanted({ projectId: project.id, expectedVersion: project.version! })
    ).projects.find((item) => item.id === project.id)!;
    const stamp = kept.lastReviewedAt!;

    const saved = (await plainSave(kept)).projects.find((item) => item.id === project.id)!;
    expect(saved.title).toBe(`${project.title} (edited)`);
    expect(saved.lastReviewedAt).toBe(stamp);

    // A payload that names the field (or a forged value) is ignored too, not stored and not cleared.
    const forged = (await plainSave(saved, { lastReviewedAt: "2020-01-01T00:00:00.000Z" })).projects.find(
      (item) => item.id === project.id
    )!;
    expect(forged.lastReviewedAt).toBe(stamp);
    const cleared = (await plainSave(forged, { lastReviewedAt: null })).projects.find(
      (item) => item.id === project.id
    )!;
    expect(cleared.lastReviewedAt).toBe(stamp);
  });

  it("never sets it on a project that was not kept", async () => {
    const project = await seedProject();
    const saved = (await plainSave(project, { lastReviewedAt: "2026-10-01T00:00:00.000Z" })).projects.find(
      (item) => item.id === project.id
    )!;
    expect(saved.lastReviewedAt).toBeUndefined();
  });
});
