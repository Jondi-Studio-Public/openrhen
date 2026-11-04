import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState, type StoredCommitment } from "@/state/portal-state";
import { activeDisruption } from "./disruption-summary";

const now = new Date("2026-08-18T10:00:00.000Z"); // 2026-08-18 20:00 Australia/Sydney
const iso = (minutesFromNow: number) => new Date(now.getTime() + minutesFromNow * 60_000).toISOString();

const disruption = (overrides: Partial<StoredCommitment> = {}): StoredCommitment => ({
  id: "disruption-1",
  title: "Drive Mum to the shops",
  startsAt: iso(-30),
  endsAt: iso(90),
  status: "confirmed",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  origin: "disruption",
  disruptionSource: "family",
  landedAt: iso(-30),
  ...overrides
});

describe("activeDisruption", () => {
  it("returns null when nothing landed today", () => {
    const state: PortalState = { ...createSeedState(now), commitments: [] };
    expect(activeDisruption(state, now)).toBeNull();
  });

  it("ignores a commitment that never carries the disruption origin", () => {
    const state: PortalState = {
      ...createSeedState(now),
      commitments: [disruption({ origin: undefined, landedAt: undefined })]
    };
    expect(activeDisruption(state, now)).toBeNull();
  });

  it("ignores a disruption that landed on an earlier local day", () => {
    const state: PortalState = {
      ...createSeedState(now),
      commitments: [disruption({ landedAt: new Date(now.getTime() - 26 * 60 * 60_000).toISOString() })]
    };
    expect(activeDisruption(state, now)).toBeNull();
  });

  it("ignores a cancelled disruption even when it landed today", () => {
    const state: PortalState = {
      ...createSeedState(now),
      commitments: [disruption({ status: "cancelled" })]
    };
    expect(activeDisruption(state, now)).toBeNull();
  });

  it("picks the disruption whose window currently contains now, over one landed more recently", () => {
    const live = disruption({ id: "live", startsAt: iso(-10), endsAt: iso(60), landedAt: iso(-40) });
    const laterLanded = disruption({ id: "later-landed", startsAt: iso(-200), endsAt: iso(-150), landedAt: iso(-5) });
    const state: PortalState = { ...createSeedState(now), commitments: [laterLanded, live] };
    expect(activeDisruption(state, now)?.id).toBe("live");
  });

  it("falls back to the most recently landed disruption when none is currently live", () => {
    const earlier = disruption({ id: "earlier", startsAt: iso(-300), endsAt: iso(-240), landedAt: iso(-260) });
    const laterLanded = disruption({ id: "later-landed", startsAt: iso(-120), endsAt: iso(-60), landedAt: iso(-70) });
    const state: PortalState = { ...createSeedState(now), commitments: [earlier, laterLanded] };
    expect(activeDisruption(state, now)?.id).toBe("later-landed");
  });

  it("agrees with itself regardless of the caller — Now and Today read the same selection", () => {
    const state: PortalState = { ...createSeedState(now), commitments: [disruption()] };
    const forNow = activeDisruption(state, now);
    const forToday = activeDisruption(state, now);
    expect(forNow?.id).toBe(forToday?.id);
    expect(forNow?.id).toBe("disruption-1");
  });
});
