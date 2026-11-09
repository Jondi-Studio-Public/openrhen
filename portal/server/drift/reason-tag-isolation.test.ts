import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Tags are the owner's words about why they left the plan, shown for correction and read by nothing else. They never
 * reach energy, tiredness, capacity or any other plan input, and no predictor takes them as a feature. Proved two ways,
 * by imports and not by a grep of one file: (1) walking the imports of every tag module forward reaches no planning,
 * energy, sleep, availability, preference, capacity or pulse module and names none of those ideas; (2) walking every
 * source file's imports finds that only a short list of modules imports a tag module at all. A new reader of tags has to
 * be added to that list on purpose, in view of this test.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const portal = join(repo, "portal");
const contracts = join(repo, "platform", "contracts");
const rel = (path: string) => relative(repo, path).split("\\").join("/");

const exportsMap = JSON.parse(readFileSync(join(contracts, "package.json"), "utf8")).exports as Record<string, string>;

function resolveImport(from: string, specifier: string): string | null {
  const candidates = (base: string) => [base + ".ts", base + ".tsx", join(base, "index.ts"), base];
  let base: string | null = null;
  if (specifier.startsWith(".")) base = resolve(dirname(from), specifier.replace(/\.js$/, ""));
  else if (specifier.startsWith("@/")) base = join(portal, specifier.slice(2));
  else if (specifier === "@openrhen/contracts") base = join(contracts, "src", "index");
  else if (specifier.startsWith("@openrhen/contracts/")) {
    const target = exportsMap[`./${specifier.slice("@openrhen/contracts/".length)}`];
    return target ? join(contracts, target) : null;
  }
  if (base === null) return null;
  return candidates(base).find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

const importsOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1] ?? "");

/** Shared plumbing the tag modules stand on. It is named, not descended into: none of it knows what a tag is. */
const INFRASTRUCTURE = [
  /^portal\/server\/derived\/(call-policy|model-runner)\.ts$/,
  /^portal\/server\/persistence\/postgres\/(sql-pool|ensure-user|activity-lock|activity-store|derived-settings-store)\.ts$/,
  /^portal\/server\/(logging|runtime-env)\.ts$/,
  /^portal\/shared\/client-id\.ts$/,
  /^portal\/test\//,
  /^platform\/contracts\/src\/index\.ts$/
];
const isInfrastructure = (path: string) => INFRASTRUCTURE.some((pattern) => pattern.test(rel(path)));

const TAG_MODULES = [
  "platform/contracts/src/drift/drift-reasons.ts",
  "platform/contracts/src/drift/drift-reason-tags.ts",
  "platform/contracts/src/activity-drift-reason.ts",
  "portal/server/drift/drift-reasons.ts",
  "portal/server/drift/reason-tags.ts",
  "portal/server/drift/reason-tag-runner.ts",
  "portal/server/drift/reason-tag-prompt.ts",
  "portal/server/persistence/postgres/drift-reason-store.ts",
  "portal/app/api/drift-reasons/route.ts",
  "portal/app/api/drift-reasons/[checkInId]/route.ts",
  "portal/app/api/drift-reasons/[checkInId]/tags/route.ts",
  "portal/app/api/integrations/reason-tag/tick/route.ts",
  "portal/features/check-in/reason-tag-client.ts",
  "portal/features/check-in/drift-reason-client.ts",
  "portal/features/check-in/components/reason-tags-card.tsx"
].map((path) => join(repo, path));

/** What a tag module may not import, or be about. */
const FORBIDDEN_PATH =
  /(energy|tired|sleep|availab|capacity|preferences|planning|pulse|predict|forecast|today|plan-map|drift-(rules|eval|episodes|labels)|work-label)/i;
const FORBIDDEN_IDENTIFIER = /(currentEnergy|energy|tired|exhaust|capacity|availability|sleepPlan|bedtime)/i;

function closure(entries: readonly string[]): { followed: Set<string>; named: Set<string> } {
  const followed = new Set<string>();
  const named = new Set<string>();
  const visit = (file: string) => {
    if (followed.has(file)) return;
    followed.add(file);
    for (const specifier of importsOf(file)) {
      const target = resolveImport(file, specifier);
      if (target === null) continue;
      if (isInfrastructure(target)) named.add(target);
      else visit(target);
    }
  };
  for (const entry of entries) visit(entry);
  return { followed, named };
}

describe("tags reach nothing that plans", () => {
  const { followed, named } = closure(TAG_MODULES);

  it("follows the imports of every tag module, and finds only tag modules, the card's own page pieces and named plumbing", () => {
    expect(TAG_MODULES.every((path) => existsSync(path))).toBe(true);
    expect([...followed].map(rel).filter((path) => FORBIDDEN_PATH.test(path))).toEqual([]);
    expect([...named].map(rel).filter((path) => FORBIDDEN_PATH.test(path))).toEqual([]);
  });

  it("names no energy, tiredness, capacity, availability or sleep idea in any module it follows", () => {
    for (const file of followed) {
      const hit = readFileSync(file, "utf8").match(FORBIDDEN_IDENTIFIER)?.[0];
      expect(hit, rel(file)).toBeUndefined();
    }
  });
});

describe("nothing else reads tags", () => {
  const MENTIONS_TAGS =
    /drift\/(reasons|reason-tags)"|drift-reason|reason-tag|reason_tag|reasons?-tags|activity-drift-reason|ReasonTag|resolveReasons/;
  const ALLOWED_IMPORTERS = new Set([
    // The contracts' own pieces.
    "platform/contracts/src/activity-drift-reason.ts",
    "platform/contracts/src/drift/drift-reason-tags.ts",
    "platform/contracts/src/activity-events.ts",
    // The owner's side: store, services, runner, routes, client and the two screens that show them.
    "portal/server/persistence/postgres/drift-reason-store.ts",
    "portal/server/drift/drift-reasons.ts",
    "portal/server/drift/reason-tags.ts",
    "portal/server/drift/reason-tag-runner.ts",
    "portal/server/drift/reason-tag-prompt.ts",
    "portal/app/api/drift-reasons/route.ts",
    "portal/app/api/drift-reasons/[checkInId]/route.ts",
    "portal/app/api/drift-reasons/[checkInId]/tags/route.ts",
    "portal/app/api/integrations/reason-tag/tick/route.ts",
    "portal/features/check-in/reason-tag-client.ts",
    "portal/features/check-in/drift-reason-client.ts",
    "portal/features/check-in/components/reason-tags-card.tsx",
    "portal/features/check-in/components/check-in-banner.tsx",
    "portal/app/review/page.tsx",
    // Route tables list the routes by address.
    "portal/server/mcp-route-table.ts"
  ]);

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory())
        return ["node_modules", ".next", ".vinext", "dist", "build", "var", "coverage"].includes(entry.name)
          ? []
          : sources(path);
      return /\.(?:ts|tsx|mjs)$/.test(entry.name) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
    });
  }

  it("lets only the owner's own modules import a tag module, so no plan input, predictor or rule can", () => {
    const importers = ["engine", "integrations", "platform", "portal", "tools"]
      .map((dir) => join(repo, dir))
      .filter((dir) => existsSync(dir))
      .flatMap(sources)
      .filter((file) => importsOf(file).some((specifier) => MENTIONS_TAGS.test(`${specifier}"`)))
      .map(rel)
      .filter((path) => !ALLOWED_IMPORTERS.has(path));
    expect(importers).toEqual([]);
  });

  it("keeps the pulse state and the pulse recorder blind to every activity row, so an answer or a tag is never contact", () => {
    const pulse = ["platform/contracts/src/planning/pulse-state.ts", "portal/server/pulse/pulse-recorder.ts"];
    const { followed: reached } = closure(pulse.map((path) => join(repo, path)));
    for (const file of reached) {
      if (isInfrastructure(file)) continue;
      expect(
        readFileSync(file, "utf8").match(/activity_events|drift-reason|reason_tag/)?.[0],
        rel(file)
      ).toBeUndefined();
    }
  });
});
