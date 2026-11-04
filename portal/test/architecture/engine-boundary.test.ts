import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Every module under the persistence tree, so splitting the store cannot shrink what is checked. */
async function persistenceModules(): Promise<string[]> {
  const root = `${webRoot}/server/persistence`;
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${entry.parentPath}/${entry.name}`);
}

describe("Plan and Forecast Engine product boundary", () => {
  it("keeps the website and worker independent from the engine package", async () => {
    const files = [
      `${webRoot}/package.json`,
      ...(await persistenceModules()),
      `${webRoot}/state/portal-state.ts`,
      `${repositoryRoot}/engine/worker/package.json`,
      `${repositoryRoot}/engine/worker/src/main.ts`
    ];
    expect(files.some((file) => file.endsWith("state-store.ts"))).toBe(true);
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toContain("@openrhen/engine-core");
  });
});
