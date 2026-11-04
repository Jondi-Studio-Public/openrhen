#!/usr/bin/env node
// Builds dist/rhen.mjs with the running build's version, commit, and timestamp baked in as
// esbuild `--define`s (read back by src/build-info.ts). Kept as a small script rather than a plain
// esbuild CLI invocation because computing the commit and timestamp needs real code.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

function shortCommit() {
  // The portal's Docker build has no .git and stamps a sentinel it replaces at serve time.
  const override = process.env.OPENRHEN_BUILD_COMMIT?.trim();
  if (override) return override;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "unknown";
  }
}

// `src/drop-ins.ts` finds command modules with a Vite glob, which esbuild does not run. Replace that module with
// a generated list of the same folders (extensions/<name>/command-module.ts), so the bundle carries every
// module that is dropped in, and none when the folder is empty or absent.
const dropInsPlugin = {
  name: "cli-drop-ins",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]drop-ins\.ts$/ }, () => {
      const directory = resolve(root, "extensions");
      const files = existsSync(directory)
        ? readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && existsSync(resolve(directory, entry.name, "command-module.ts")))
            .map((entry) => resolve(directory, entry.name, "command-module.ts"))
            .sort()
        : [];
      const imports = files.map((file, index) => `import module${index} from ${JSON.stringify(file)};`);
      const names = files.map((_, index) => `module${index}`).join(", ");
      return {
        contents: `${imports.join("\n")}\nexport function dropInModules() { return [${names}]; }\n`,
        loader: "js",
        resolveDir: root
      };
    });
  }
};

const builtAt = new Date().toISOString();
const commit = shortCommit();

await esbuild.build({
  entryPoints: [resolve(root, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  outfile: resolve(root, "dist/rhen.mjs"),
  plugins: [dropInsPlugin],
  define: {
    __OPENRHEN_VERSION__: JSON.stringify(packageJson.version),
    __OPENRHEN_COMMIT__: JSON.stringify(commit),
    __OPENRHEN_BUILT_AT__: JSON.stringify(builtAt)
  }
});

console.log(`Built @openrhen/cli ${packageJson.version} (${commit}) at ${builtAt}`);
