import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readWorkspace } from "./affected.mjs";

/**
 * The matrix legs the unit and integration jobs run, from what `affected.mjs` selected.
 *
 * The slow suites are split across runners with vitest's `--shard i/n` (it splits the file list, so a
 * leg needs no knowledge of which files exist). Each leg is a separate job on its own two-core
 * runner and its own Postgres, so shards never share a database. Shard counts sit here, next to the
 * numbers they come from: the portal and the database package each have a few dozen seconds of
 * longest file and thousands of seconds of total, so even shards are within a few percent of ideal.
 * Raise a count when a leg becomes the slowest job again; there is nothing else to change.
 *
 * `unitFilter` / `integrationFilter` are `affected.mjs`'s pnpm filter strings: empty means every
 * package runs, otherwise it lists `--filter=./<dir>` for the ones that do.
 */
export const SHARDS = {
  unit: { portal: 3 },
  integration: { portal: 4, "platform/database": 2 }
};

const selected = (filter) => {
  if (filter.trim() === "") return () => true;
  const dirs = new Set([...filter.matchAll(/--filter=\.\/(\S+)/g)].map((match) => match[1]));
  return (dir) => dirs.has(dir);
};

const legs = (shards, runs, withRest) => {
  const out = [];
  for (const [dir, count] of Object.entries(shards)) {
    if (!runs(dir)) continue;
    for (let shard = 1; shard <= count; shard += 1)
      out.push({ name: `${dir} ${shard}/${count}`, dir, shard: `${shard}/${count}` });
  }
  // Everything that is not sharded runs in one leg, so a package added later is still tested.
  if (withRest()) out.push({ name: "other packages", dir: "", shard: "" });
  return out;
};

/** `{ unit, integration }`: arrays of `{ name, dir, shard }`; a leg with no `dir` is "every other package". */
export function buildMatrix({
  unitFilter = "",
  integrationFilter = "",
  unit = true,
  integration = true,
  packages = readWorkspace()
}) {
  const unitRuns = selected(unitFilter);
  const integrationRuns = selected(integrationFilter);
  const unitSharded = Object.keys(SHARDS.unit);
  const integrationSharded = Object.keys(SHARDS.integration);
  return {
    unit: unit
      ? legs(SHARDS.unit, unitRuns, () =>
          packages.some((pkg) => pkg.scripts.test && !unitSharded.includes(pkg.dir) && unitRuns(pkg.dir))
        )
      : [],
    integration: integration
      ? legs(SHARDS.integration, integrationRuns, () =>
          packages.some(
            (pkg) =>
              pkg.scripts["test:integration"] && !integrationSharded.includes(pkg.dir) && integrationRuns(pkg.dir)
          )
        )
      : [],
    unitSharded,
    integrationSharded
  };
}

function main() {
  const env = process.env;
  const matrix = buildMatrix({
    unitFilter: env.UNIT_FILTER ?? "",
    integrationFilter: env.INTEGRATION_FILTER ?? "",
    unit: env.UNIT === "true",
    integration: env.INTEGRATION === "true"
  });
  const outputs = {
    "unit-matrix": JSON.stringify({ include: matrix.unit }),
    "integration-matrix": JSON.stringify({ include: matrix.integration }),
    "unit-sharded": matrix.unitSharded.map((dir) => `--filter=!./${dir}`).join(" ")
  };
  console.log(outputs);
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join("")
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
