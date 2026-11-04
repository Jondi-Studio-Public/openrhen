// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type ActiveSession, type PortalState } from "@/state/portal-state";
import { heroIdentity, NOW_HERO_ATTRIBUTE, swapHero } from "./hero-transition";

const now = new Date("2026-08-18T10:00:00.000Z");
const base = createSeedState(now);
const session: ActiveSession = {
  id: "session-1",
  actionId: base.actions[0]!.id,
  status: "running",
  startedAt: now.toISOString(),
  plannedEndAt: new Date(now.getTime() + 1_800_000).toISOString(),
  plannedMinutes: 30,
  remainingBeforeMinutes: 90,
  activeElapsedSeconds: 0
};
const running: PortalState = { ...base, activeSession: session };

let reduce = false;
let hero: HTMLElement | null = null;
const startViewTransition = vi.fn((update: () => void) => update());
beforeEach(() => {
  reduce = false;
  window.matchMedia = ((query: string) => ({ matches: reduce, media: query })) as unknown as typeof window.matchMedia;
  (document as unknown as { startViewTransition: typeof startViewTransition }).startViewTransition =
    startViewTransition;
  hero = document.createElement("section");
  hero.setAttribute(NOW_HERO_ATTRIBUTE, "");
  document.body.append(hero);
});
afterEach(() => {
  hero?.remove();
  startViewTransition.mockClear();
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

describe("heroIdentity", () => {
  it("changes when a session starts or ends, but not when it pauses", () => {
    expect(heroIdentity(base)).not.toBe(heroIdentity(running));
    expect(heroIdentity(running)).toBe(heroIdentity({ ...running, activeSession: { ...session, status: "paused" } }));
  });

  it("changes when a routine step is skipped", () => {
    const step = { id: "wake-1", title: "Glass of water", status: "pending" } as PortalState["routineSteps"][number];
    const pending = { ...base, routineSteps: [step] };
    const skipped = { ...base, routineSteps: [{ ...step, status: "skipped" as const }] };
    expect(heroIdentity(pending)).not.toBe(heroIdentity(skipped));
  });
});

describe("swapHero", () => {
  it("runs a change of hero through a view transition", () => {
    const apply = vi.fn();
    swapHero(base, running, apply);
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("applies directly when the hero is unchanged, off screen, or motion is reduced", () => {
    const apply = vi.fn();
    swapHero(running, { ...running }, apply);
    reduce = true;
    swapHero(base, running, apply);
    reduce = false;
    hero!.remove();
    swapHero(base, running, apply);
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(3);
  });
});
