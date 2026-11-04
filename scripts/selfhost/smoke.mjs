#!/usr/bin/env node
// Self-host smoke test: proves the stranger path (README quick start) end to end on any Docker host.
//
//   node scripts/selfhost/smoke.mjs [--keep] [--skip-build] [--timeout-minutes <n>]
//
// It copies the committed tree (`git archive HEAD`, so no .env and no var/ cross over) into a temp
// directory, runs `docker compose run --rm setup`, starts the `app,bundled-db` stack under a unique
// project name, drives it with the CLI the portal serves, restarts it, backs it up, checks that no
// port is published beyond loopback, scans the logs and tears everything down. Every docker call gets
// a scrubbed environment (scripts/selfhost/smoke-lib.mjs) and the script refuses to run under a Docker
// context that looks like a live server (see `assertSafeContext`), so it cannot touch a real deployment.
//
// Flags: --keep leaves the stack running; --skip-build uses images already pulled (set IMAGE_PREFIX
// and IMAGE_TAG in the caller's environment; they are written to the temp .env, nothing else is
// inherited); --timeout-minutes bounds the wait for the stack to come up (default 10).
//
// Steps and their pure helpers: smoke-lib.mjs (unit tested). This file is the Docker plumbing and
// needs a Docker daemon, so it is run by the acceptance test, not by `test:scripts`.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fail,
  findFreePort,
  installProcessHandlers,
  log,
  registerCleanup,
  ROOT,
  sleep,
  SmokeFailure
} from "../smoke/boot.mjs";
import { readEnvText, setValue, writeEnvText } from "../setup/env-file.mjs";
import {
  assertLocalDocker,
  commitmentFields,
  exposedPorts,
  findUnexpectedErrors,
  formatTable,
  LOG_SERVICES,
  newCommitmentId,
  newResults,
  ownImageRefs,
  parseArgs,
  parsePsJson,
  planIncludesCommitment,
  projectName,
  scrubEnv,
  serviceProblems,
  smokeEnvValues
} from "./smoke-lib.mjs";

const DOCKER = "docker";
// 1x1 transparent PNG: a real photo, so the route's type sniffing and blob write are exercised.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const FETCH_TIMEOUT_MS = 10_000;
const CAPTURE_TEXT = "Selfhost smoke: call the dentist";

/** Runs a command and returns { code, stdout, stderr }; never rejects on a non-zero exit. */
function exec(cmd, args, { cwd, env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function tail(text, lines = 15) {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const results = newResults();
  const byId = Object.fromEntries(results.map((result) => [result.id, result]));
  const env = scrubEnv(process.env);
  const project = projectName();
  let dir = null;
  let teardownNeeded = false;
  // A built run names its images after the unique project, so removing them can never touch the owner's own
  // `openrhen-*` images; --skip-build uses the caller's IMAGE_PREFIX and IMAGE_TAG and removes nothing.
  const imagePrefix = options.skipBuild ? process.env.IMAGE_PREFIX : project;

  const compose = (args, extra = {}) => exec(DOCKER, ["compose", "-p", project, ...args], { cwd: dir, env, ...extra });
  const composeOk = async (args, extra) => {
    const result = await compose(args, extra);
    if (result.code !== 0)
      fail(`docker compose ${args.join(" ")} exited ${result.code}\n${tail(result.stderr || result.stdout)}`);
    return result;
  };
  const psRows = async () => parsePsJson((await composeOk(["ps", "-a", "--format", "json"])).stdout);

  const cleanupSync = registerCleanup(() => {
    if (!teardownNeeded || options.keep || dir === null) return;
    spawnSync(DOCKER, ["compose", "-p", project, "down", "-v", "--rmi", "local", "--remove-orphans"], {
      cwd: dir,
      env,
      stdio: "ignore"
    });
  });
  installProcessHandlers();

  let current = null;
  const step = async (id, body) => {
    current = byId[id];
    log(`step: ${current.name}`);
    const detail = await body();
    current.status = "pass";
    current.detail = detail ?? "";
    current = null;
  };

  try {
    // 1. Isolate.
    await step("isolate", async () => {
      // `context show` ignores DOCKER_HOST, which wins over the context, so check the endpoint too.
      const contextName = (await exec(DOCKER, ["context", "show"], { env })).stdout || process.env.DOCKER_CONTEXT || "";
      const contextHost = (
        await exec(
          DOCKER,
          ["context", "inspect", contextName.trim() || "default", "--format", "{{.Endpoints.docker.Host}}"],
          {
            env
          }
        )
      ).stdout;
      const { name: context } = assertLocalDocker({
        contextName,
        contextHost,
        dockerHost: env.DOCKER_HOST,
        env: process.env
      });
      dir = mkdtempSync(join(tmpdir(), `${project}-`));
      // A clean checkout of HEAD with git alone (no tar: Windows PATH can resolve Git for Windows' GNU tar,
      // which reads "C:\..." as a remote host). `--shared` borrows ROOT's objects, so it is quick and
      // deleting the copy can never touch ROOT; the .git folder is removed so only the tree remains.
      const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) fail("git rev-parse HEAD failed");
      for (const args of [
        ["clone", "--quiet", "--no-checkout", "--shared", ROOT, dir],
        ["-C", dir, "checkout", "--quiet", "--detach", sha]
      ]) {
        const result = spawnSync("git", args, { encoding: "utf8" });
        if (result.status !== 0) fail(`git ${args[0] === "-C" ? args[2] : args[0]} failed: ${result.stderr}`);
      }
      rmSync(join(dir, ".git"), { recursive: true, force: true });
      // This smokes the committed tree, not the working tree: uncommitted edits are untested.
      const head = sha.slice(0, 9);
      log(`testing committed tree ${head} (uncommitted edits are not included)`);
      return `project ${project}, context ${context}, commit ${head}`;
    });

    // 2. Set up with the stranger's own command, then give the stack free host ports.
    await step("setup", async () => {
      // `run setup` can already create the project network, so a failure here must still be torn down.
      teardownNeeded = true;
      await composeOk(["run", "--rm", "setup"], { timeoutMs: 5 * 60_000 });
      const portalPort = await findFreePort();
      let postgresPort = await findFreePort();
      while (postgresPort === portalPort) postgresPort = await findFreePort();
      const values = smokeEnvValues({
        portalPort,
        postgresPort,
        imagePrefix,
        imageTag: options.skipBuild ? process.env.IMAGE_TAG : undefined
      });
      const envPath = join(dir, ".env");
      let text = readEnvText(envPath);
      if (text === "") fail("setup did not write .env");
      for (const [key, value] of Object.entries(values)) text = setValue(text, key, value);
      writeEnvText(envPath, text);
      state.portalUrl = `http://127.0.0.1:${portalPort}`;
      return `portal ${portalPort}, postgres ${postgresPort}`;
    });

    // 3. Start and wait.
    await step("start", async () => {
      await composeOk(["up", "-d", ...(options.skipBuild ? [] : ["--build"])], {
        timeoutMs: options.timeoutMinutes * 60_000
      });
      await waitForStack();
      return `${state.portalUrl}`;
    });

    // 4. Use it through the CLI the portal serves.
    await step("use", async () => {
      const bundle = await fetch(`${state.portalUrl}/api/cli/bundle`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!bundle.ok) fail(`/api/cli/bundle answered ${bundle.status}`);
      const home = join(dir, ".smoke-home");
      mkdirSync(home, { recursive: true });
      state.cli = join(home, "rhen.mjs");
      writeFileSync(state.cli, await bundle.text());
      // An empty HOME so ~/.openrhen/config.json (the owner's real portal) can never be read.
      state.cliEnv = { ...env, HOME: home, USERPROFILE: home, OPENRHEN_URL: state.portalUrl };

      await cli(["capture", CAPTURE_TEXT]);
      // The core claim: a commitment gets planned. `save commitment` needs a title, startsAt and endsAt;
      // a unique id (--create) lets the plan result be searched for it.
      // A v4 UUID: the portal hashes any other id to a different UUID (save.ts stableUuid), so a
      // readable id would be stored under an id the plan result never names.
      const commitmentId = newCommitmentId();
      const fields = commitmentFields({ id: commitmentId, title: `Selfhost smoke ${project.slice(-8)}` });
      await cli(["save", "commitment", "--create", "--id", commitmentId, "--fields", JSON.stringify(fields)]);
      await cli(["recalculate"]);
      await waitFor("a current plan run that includes the commitment", 180_000, async () =>
        planIncludesCommitment(await planning(), commitmentId)
      );
      await assertCaptureStored();

      const form = new FormData();
      form.set("photo", new Blob([TINY_PNG], { type: "image/png" }), "smoke.png");
      form.set("takenAt", new Date().toISOString());
      form.set("transcript", "selfhost smoke photo");
      const upload = await fetch(`${state.portalUrl}/api/photo-checkins`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (upload.status !== 201) fail(`photo upload answered ${upload.status}: ${(await upload.text()).slice(0, 200)}`);
      return "capture, commitment planned, photo 201";
    });

    // 5. Persist.
    await step("persist", async () => {
      await composeOk(["restart"], { timeoutMs: 5 * 60_000 });
      await waitForStack();
      await assertCaptureStored();
      await composeOk(["down"], { timeoutMs: 5 * 60_000 });
      await composeOk(["up", "-d"], { timeoutMs: 5 * 60_000 });
      await waitForStack();
      await assertCaptureStored();
      return "survives restart and down/up";
    });

    // 6. Back up and verify the restore.
    await step("backup", async () => {
      await composeOk(["run", "--rm", "-T", "backup", "corepack", "pnpm", "db:backup"], { timeoutMs: 5 * 60_000 });
      await composeOk(["run", "--rm", "-T", "backup", "corepack", "pnpm", "db:restore:verify"], {
        timeoutMs: 5 * 60_000
      });
      return "db:backup and db:restore:verify exit 0";
    });

    // 7. Nothing published beyond loopback.
    await step("exposure", async () => {
      const exposed = exposedPorts(await psRows());
      if (exposed.length > 0)
        fail(`published beyond loopback: ${exposed.map((p) => `${p.service} ${p.address}:${p.published}`).join(", ")}`);
      return "every published port is loopback";
    });

    // 8. Logs.
    await step("logs", async () => {
      const unexpected = [];
      for (const service of LOG_SERVICES) {
        const logs = await compose(["logs", "--no-color", "--no-log-prefix", service]);
        unexpected.push(...findUnexpectedErrors(service, `${logs.stdout}\n${logs.stderr}`));
      }
      if (unexpected.length > 0)
        fail(
          `${unexpected.length} error line(s):\n${unexpected
            .slice(0, 10)
            .map((e) => `  [${e.service}] ${e.line}`)
            .join("\n")}`
        );
      return "no unexpected error lines";
    });
  } catch (error) {
    if (current) {
      current.status = "fail";
      current.detail = error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : String(error);
    }
    console.error(`[smoke] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    // 9. Tear down, scoped to this project, unless --keep.
    const teardown = byId.teardown;
    try {
      if (options.keep) {
        teardown.status = "skipped";
        teardown.detail = `--keep: project ${project} left running in ${dir}`;
      } else if (teardownNeeded && dir) {
        await compose(["down", "-v", "--rmi", "local", "--remove-orphans"], { timeoutMs: 5 * 60_000 });
        if (!options.skipBuild) await removeBuiltImages(project, env);
        teardownNeeded = false;
        teardown.status = "pass";
      } else {
        teardown.status = "pass";
        teardown.detail = "nothing started";
      }
      if (!options.keep && dir) {
        try {
          // Root-owned bind-mount folders (var/photos) can refuse removal on Linux; that is not a failure.
          rmSync(dir, { recursive: true, force: true });
        } catch {
          teardown.detail = `${teardown.detail} (temp dir ${dir} not fully removed)`.trim();
        }
      }
    } catch (error) {
      teardown.status = "fail";
      teardown.detail = error instanceof Error ? error.message.slice(0, 160) : String(error);
      process.exitCode = 1;
    }
    cleanupSync();
    console.log(`\n${formatTable(results)}`);
    if (process.exitCode === 1 || results.some((result) => result.status === "fail")) process.exitCode = 1;
  }

  // ---- helpers that need `dir`, `state` and `compose` ----
  async function waitFor(what, timeoutMs, check) {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      try {
        if (await check()) return;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await sleep(3000);
    }
    fail(`timed out waiting for ${what}${last ? ` (${last})` : ""}`);
  }

  async function waitForStack() {
    let problems = [];
    await waitFor("the stack to be healthy", options.timeoutMinutes * 60_000, async () => {
      problems = serviceProblems(await psRows());
      if (problems.length > 0) return false;
      for (const path of ["/api/health/database", "/api/health/engine"]) {
        const response = await fetch(`${state.portalUrl}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (response.status !== 200) throw new Error(`${path} answered ${response.status}`);
      }
      return true;
    }).catch((error) => {
      throw new SmokeFailure(`${error.message}${problems.length ? `; not ready: ${problems.join(", ")}` : ""}`);
    });
  }

  async function cli(args) {
    const result = await exec(process.execPath, [state.cli, ...args, "--json"], { cwd: dir, env: state.cliEnv });
    if (result.code !== 0) fail(`rhen ${args[0]} exited ${result.code}: ${tail(result.stderr || result.stdout, 5)}`);
    return result.stdout;
  }

  async function planning() {
    return JSON.parse(await cli(["state", "--key", "planning"])) ?? {};
  }

  async function assertCaptureStored() {
    const captures = JSON.parse(await cli(["state", "--key", "captures"]));
    if (!Array.isArray(captures) || !captures.some((capture) => capture.text === CAPTURE_TEXT))
      fail("the captured commitment is not in the portal state");
  }
}

const state = { portalUrl: "", cli: "", cliEnv: {} };

/** `down --rmi local` skips images compose names explicitly (all of ours), so remove `<project>-*` here. */
async function removeBuiltImages(project, env) {
  const listed = await exec(
    DOCKER,
    ["images", "--filter", `reference=${project}-*`, "--format", "{{.Repository}}:{{.Tag}}"],
    {
      env
    }
  );
  // By name:tag and without -f: untagging a name leaves other tags on the same image alone.
  const refs = ownImageRefs(listed.stdout, project);
  if (refs.length > 0) await exec(DOCKER, ["image", "rm", ...refs], { env });
}

main().catch((error) => {
  console.error(`[smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
