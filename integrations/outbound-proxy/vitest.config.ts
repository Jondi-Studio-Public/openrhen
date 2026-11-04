import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// A drop-in folder may carry a `setup.ts` that clears the environment it reads, like clear-provider-env.ts.
const dropIns = fileURLToPath(new URL("./src/drop-ins/", import.meta.url));
const dropInSetups = (existsSync(dropIns) ? readdirSync(dropIns) : [])
  .map((name) => join(dropIns, name, "setup.ts"))
  .filter((path) => existsSync(path));

export default defineConfig({
  test: {
    setupFiles: ["./clear-provider-env.ts", ...dropInSetups]
  }
});
