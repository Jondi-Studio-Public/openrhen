import { describe, expect, it } from "vitest";
import { runIndependentLoops } from "./independent-loops.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("runIndependentLoops", () => {
  it("keeps running one step while another is stuck", async () => {
    let stopping = false;
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => (releaseSlow = resolve));
    let slowStarts = 0;
    let fastRuns = 0;
    const done = runIndependentLoops(
      [
        {
          name: "roster-sync",
          run: async () => {
            slowStarts += 1;
            await slow;
          }
        },
        {
          name: "jobs",
          run: async () => {
            fastRuns += 1;
            return "idle";
          }
        }
      ],
      { isStopping: () => stopping, onError: () => {}, sleep: tick }
    );
    for (let i = 0; i < 20; i += 1) await tick();
    expect(fastRuns).toBeGreaterThan(5);
    // The stuck step is never started again while its first run is still going.
    expect(slowStarts).toBe(1);
    stopping = true;
    releaseSlow();
    await done;
  });

  it("reports a throwing step and keeps looping it", async () => {
    let stopping = false;
    let runs = 0;
    const errors: string[] = [];
    const done = runIndependentLoops(
      [
        {
          name: "prune",
          run: async () => {
            runs += 1;
            if (runs >= 3) stopping = true;
            throw new Error("boom");
          }
        }
      ],
      { isStopping: () => stopping, onError: (name) => errors.push(name), sleep: tick }
    );
    await done;
    expect(runs).toBe(3);
    expect(errors).toEqual(["prune", "prune", "prune"]);
  });

  it("runs a step that did work again without sleeping, and sleeps after an idle one", async () => {
    let stopping = false;
    const sleeps: number[] = [];
    const outcomes = ["completed", "completed", "idle"];
    await runIndependentLoops(
      [
        {
          name: "jobs",
          run: async () => {
            const next = outcomes.shift();
            if (outcomes.length === 0) stopping = true;
            return next;
          }
        }
      ],
      { isStopping: () => stopping, onError: () => {}, idleDelayMs: 7, sleep: async (ms) => void sleeps.push(ms) }
    );
    expect(sleeps).toEqual([7]);
  });
});
