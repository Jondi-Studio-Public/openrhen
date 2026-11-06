import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portal = resolve(__dirname, "..");
/**
 * Where a client can build a command. `app/api` is excluded: it runs only on the server, and its one
 * `commandId:` user (`app/api/device/action/route.ts`) is a different domain entirely — a physical
 * device's own correlation id, not a `PlanningEntityCommand` dispatched through `runCommand` — so it
 * never matches `ENVELOPE_ID` below regardless.
 */
const scanRoots = ["app", "features", "components"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "api" && dir === join(portal, "app") ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Every envelope in the codebase assigns its id with `commandId: createClientId()` (the design note's
 * "ids come from `createClientId()`" fact). Matching that literal, rather than the bare `commandId:`
 * key, is what keeps this off a type's own field declaration (`interface … { commandId: string }`,
 * `reconciliation-panel.tsx`) and off the device route's differently-sourced id.
 */
const ENVELOPE_ID = /commandId:\s*createClientId\(\)/g;

function inlineEnvelopeCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const root of scanRoots) {
    for (const file of sourceFiles(join(portal, root))) {
      const matches = readFileSync(file, "utf8").match(ENVELOPE_ID);
      if (matches?.length) counts.set(relative(portal, file).replaceAll("\\", "/"), matches.length);
    }
  }
  return counts;
}

/**
 * Exempt: the authoring modules themselves. Recognised by plan decision 2's naming rule —
 * `<entity>Command(…)` returns an envelope the caller dispatches and lives in `*-command.ts` /
 * `*-commands.ts`; `save<Entity>Draft(…)` returns `Promise<string>` and has already dispatched, and
 * lives in `*-save.ts` — plus `features/locations/create-place.ts` and
 * `components/situation-panel.tsx`, which are authoring modules under other names.
 */
const EXEMPT_AUTHORING_MODULES: Record<string, number> = {
  "components/situation-panel.tsx": 1,
  "features/capture/capture-commands.ts": 7,
  "features/check-in/check-in-command.ts": 3,
  "features/commitments/commitment-commands.ts": 3,
  "features/deliverables/deliverable-commands.ts": 5,
  "features/disruptions/disruption-commands.ts": 2,
  "features/disruptions/disruption-save.ts": 2,
  "features/locations/create-place.ts": 1,
  "features/now/can-do-now-commands.ts": 1,
  "features/now/free-commitment.ts": 1,
  "features/now/need-commands.ts": 1,
  "features/now/recovery-commands.ts": 1,
  "features/now/wake-commands.ts": 3,
  "features/plan/plan-commands.ts": 8,
  "features/pulse/disruption-client.ts": 1,
  "features/pulse/reentry-client.ts": 1,
  "features/review/review-commands.ts": 8,
  "features/routines/routine-commands.ts": 1,
  "features/sleep-log/sleep-log-command.ts": 1,
  "features/today/commitment-save.ts": 4,
  "features/today/today-commands.ts": 4
};

/**
 * Correct by design, and permanent — later tasks must not shrink this list. `versionIn` reads the
 * live version out of a state collection, which is right only when the body is composed from that
 * same read. A page holding a draft is not: `useServerDraft` freezes `seededVersion` at draft time
 * *inside the hook*, and these pages send that, so routing one of them through `versionIn` would
 * reintroduce the lost-update bug the hook prevents. An authoring module is not automatically the
 * live-version case either — `deliverablePersistCommand` and `reviewProposalCommand` take the
 * seeded version as a parameter, which is the fix. The rule is that the version must name
 * the snapshot the body was composed from, whichever of the two that is.
 * `catalogues/conditions` has no draft window to protect and deliberately reads live. `app/setup` has
 * its own bug, filed as an issue rather than fixed here, because its `ready` gate sits
 * below the initializers it would need to protect.
 */
const CORRECT_BY_DESIGN: Record<string, { count: number; reason: string }> = {
  "app/settings/ai/page.tsx": {
    count: 1,
    reason: "useServerDraft seeds the version at draft time; versionIn would read the live one."
  },
  "app/settings/catalogues/conditions/page.tsx": {
    count: 2,
    reason: "Saves on change with no draft window to protect; the live version is deliberately what it sends."
  },
  "app/settings/catalogues/energy/page.tsx": {
    count: 1,
    reason: "useServerDraft seeds the version at draft time; versionIn would read the live one."
  },
  "app/settings/disruptions/page.tsx": {
    count: 1,
    reason: "useServerDraft seeds the version at draft time; versionIn would read the live one."
  },
  "app/settings/family-calendar/page.tsx": {
    count: 1,
    reason: "useServerDraft seeds the version at draft time; versionIn would read the live one."
  },
  "features/plan-map/components/code-pattern-card.tsx": {
    count: 1,
    reason: "One field saved on its own button with no long draft window; the live version is what it sends."
  },
  "features/settings/components/notifications-section.tsx": {
    count: 1,
    reason: "Saves on change with no draft window to protect; the live version is deliberately what it sends."
  },
  "features/settings/components/pulse-publish-section.tsx": {
    count: 1,
    reason: "Saves on change with no draft window to protect; the live version is deliberately what it sends."
  },
  "features/settings/components/pulse-thresholds-section.tsx": {
    count: 1,
    reason: "Three numbers saved together on one Save, with no long draft window; the live version is what it sends."
  },
  "features/settings/components/estimate-calibration-section.tsx": {
    count: 1,
    reason: "Saves on change with no draft window to protect; the live version is deliberately what it sends."
  },
  "app/settings/planning/buffers/page.tsx": {
    count: 1,
    reason: "useServerDraft seeds the version at draft time; versionIn would read the live one."
  },
  "app/settings/planning/estimates/page.tsx": {
    count: 1,
    reason: "useServerDraft seeds the version at draft time; versionIn would read the live one."
  },
  "app/settings/planning/page.tsx": {
    count: 1,
    reason: "useServerDraft seeds the version at draft time; versionIn would read the live one."
  },
  "app/settings/sleep/page.tsx": {
    count: 1,
    reason: "useServerDraft seeds the version at draft time; versionIn would read the live one."
  },
  "features/settings/components/time-bands-section.tsx": {
    count: 1,
    reason: "useServerDraft seeds the version at draft time; versionIn would read the live one."
  },
  "app/setup/page.tsx": {
    count: 1,
    reason: "First-run wizard's stale-version bug is a restructure, not an expression change; filed as an issue."
  }
};

/**
 * The shrinking allowlist: every inline site not yet moved behind an authoring module, keyed by file
 * path and count so a second inline site in an already-listed file still fails. The
 * `command-authoring` rework emptied it of everything but the sites under `features/now/components/`,
 * which wait on the Now-page precedence work: not one of them resolves its own version — every one
 * arrives as a prop computed upstream in `now-model.ts` or `now-activity.ts` through a precedence
 * chain, so lifting them into a `now-commands.ts` means either freezing those chains into a new
 * module's interface or resolving the precedence first. So this is the checklist for that work, and
 * it only ever shrinks except when a new Now-page feature adds its own precedence-fed site (as
 * `sleep-placement` did, taking the total from 25 to 27): a new entry outside `features/now/` means
 * someone wrote an inline envelope where an authoring module belongs. The second test below pins
 * the current total, and it is the assertion that closes the rework once the total stops moving.
 */
const SHRINKING_ALLOWLIST: Record<string, number> = {
  "features/now/components/activity-session-panel.tsx": 5,
  "features/now/components/availability-panel.tsx": 1,
  "features/now/components/bedtime-step-card.tsx": 2,
  "features/now/components/bedtime-step-session-card.tsx": 4,
  "features/now/components/boundary-panel.tsx": 1,
  "features/now/components/deliverable-session-panel.tsx": 2,
  "features/now/components/engagement-strip.tsx": 1,
  "features/now/components/protected-commitment-panel.tsx": 1,
  "features/now/components/reconciliation-panel.tsx": 3,
  "features/now/components/recommendation-panel.tsx": 1,
  "features/now/components/routine-step-panel.tsx": 2,
  "features/now/components/sleep-panel.tsx": 3,
  "features/now/components/stay-up-offer.tsx": 1
};

describe("command authoring", () => {
  it("accounts for every inline command envelope under app, features and components", () => {
    const found = inlineEnvelopeCounts();
    const known = new Map<string, number>();
    for (const [file, count] of Object.entries(EXEMPT_AUTHORING_MODULES)) known.set(file, count);
    for (const [file, { count }] of Object.entries(CORRECT_BY_DESIGN)) known.set(file, count);
    for (const [file, count] of Object.entries(SHRINKING_ALLOWLIST)) known.set(file, count);

    const errors: string[] = [];
    for (const [file, expectedCount] of known) {
      const foundCount = found.get(file) ?? 0;
      if (foundCount === 0) errors.push(`${file}: listed with ${expectedCount}, but is now clean — remove its entry.`);
      else if (foundCount !== expectedCount)
        errors.push(`${file}: expected ${expectedCount} inline envelope(s), found ${foundCount}.`);
    }
    for (const [file, foundCount] of found) {
      if (!known.has(file)) errors.push(`${file}: ${foundCount} inline envelope(s) not accounted for in any category.`);
    }
    expect(errors).toEqual([]);
  });

  /**
   * What the `command-authoring` rework finished at, held so a regression is loud rather than quiet.
   * A new inline envelope anywhere else fails the test above; this one refuses a new entry *here*,
   * which is the tempting way to make that failure go away.
   */
  it("has nothing left on the shrinking allowlist but the Now page's precedence-fed sites", () => {
    const files = Object.keys(SHRINKING_ALLOWLIST);
    expect(files.filter((file) => !file.startsWith("features/now/components/"))).toEqual([]);
    expect(Object.values(SHRINKING_ALLOWLIST).reduce((total, count) => total + count, 0)).toBe(27);
  });
});
