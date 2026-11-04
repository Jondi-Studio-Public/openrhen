#!/usr/bin/env node
// Production smoke test, in two phases.
//
// Phase 1, the click smoke (this file):
//
// Unit tests, typecheck and `pnpm dev` all pass on code that breaks the moment it runs through the
// real production bundle: commit 47e833a shipped client-side navigation that worked fine in dev but
// threw `TypeError: ee is not a function` (vinext's next/link shim, prod-only) as soon as it went
// through `vinext build`, silently breaking every click. Nothing else in the deploy gate ever
// executes the built output, so this does: it starts the actual production server (`vinext start`,
// the same command `pnpm --filter @openrhen/portal start` runs) against the database the portal's
// own integration tests use — never the live DATABASE_URL — loads the app in a real, locally
// installed browser, and clicks a nav link the way a person would.
//
// Requires a production build first:
//   pnpm build:portal
//   node scripts/smoke/production-click.mjs
//
// Env:
//   SMOKE_PORT           port for the production server under test (default 3100). Phase 2 takes
//                        its ports from the operating system instead.
//   SMOKE_BROWSER_PATH   path to a Chrome/Edge executable. When set it is used exclusively — no
//                        fallback to the auto-detected list — so a bad path fails loudly rather than
//                        silently testing a different browser than the one asked for. When it is unset
//                        and no browser is found at the usual paths (a cloud or agent session has
//                        none), scripts/smoke/install-chrome.mjs fetches the Chrome for Testing build
//                        puppeteer-core is pinned to into node_modules/.cache and that is used.
//
// Also seeds the test database (`@openrhen/database`'s `smoke:seed-late-commitment` script) with a
// running-late commitment and an unrelated running session before starting the server, then asserts
// the loaded page shows "Running late for" — the one method here that drives the real production
// bundle end to end and can catch a page-composition regression of that kind. No cleanup step: the
// database this points at is the disposable test database,
// and the seed is idempotent under its own fixed ids, so the next run simply overwrites it.
//
// Phase 2, the demo seed (scripts/smoke/seed-phase.mjs): once the click phase has passed, the demo seed
// (`pnpm seed:demo`) runs against a database, engine service, engine worker and portal of its own, and
// the phase passes only when the seed exits 0 and the plan it asked for was calculated and has a Now
// directive. The boot helpers both phases use (database create/migrate/drop, starting and stopping
// servers, cleanup on every exit) are in scripts/smoke/boot.mjs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  PNPM,
  PNPM_OPTS,
  ROOT,
  SmokeFailure,
  createDatabase,
  fail,
  installProcessHandlers,
  log,
  migrateDatabase,
  resolveTestDatabaseUrl,
  run,
  setActiveBrowser,
  sleep,
  startPortal,
  stopDetached,
  waitForReady
} from "./boot.mjs";
import { runSeedPhase } from "./seed-phase.mjs";

const PORTAL_DIR = resolve(ROOT, "portal");
const PORT = Number(process.env.SMOKE_PORT) || 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// The literal headline each app-router error boundary renders (portal/app/error.tsx,
// portal/app/global-error.tsx) — distinctive enough that finding either on the page means the
// boundary caught something, whether or not a pageerror event also fired for it.
const ERROR_BOUNDARY_STRINGS = ["This page hit a snag.", "OpenRhen hit a snag.", "SOMETHING WENT WRONG"];

async function resolveBrowserPath() {
  const envPath = process.env.SMOKE_BROWSER_PATH?.trim();
  if (envPath) {
    if (!existsSync(envPath)) fail(`SMOKE_BROWSER_PATH is set to "${envPath}", but no file exists there.`);
    return envPath;
  }
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium"
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  // Nothing installed (cloud and agent sessions have no browser): fetch the Chrome for Testing build
  // puppeteer-core is pinned to, the same way CI does. The cache survives between runs.
  log("No Chrome or Edge in the usual locations; installing Chrome for Testing...");
  const cacheDir = resolve(ROOT, "node_modules", ".cache", "chrome-for-testing");
  mkdirSync(cacheDir, { recursive: true });
  const installed = spawnSync(process.execPath, [resolve(ROOT, "scripts/smoke/install-chrome.mjs"), cacheDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  const installedPath = installed.stdout?.trim().split(/\r?\n/).pop();
  if (installed.status !== 0 || !installedPath || !existsSync(installedPath)) {
    fail(
      "No Chrome or Edge executable found in the usual locations:\n" +
        candidates.map((candidate) => `  - ${candidate}`).join("\n") +
        "\nInstalling Chrome for Testing with scripts/smoke/install-chrome.mjs failed too (see above)." +
        "\nSet SMOKE_BROWSER_PATH to the executable to use."
    );
  }
  return installedPath;
}

function assertNoPageErrors(pageErrors, when) {
  if (pageErrors.length > 0) fail(`Page threw an uncaught error ${when}:\n${pageErrors.join("\n")}`);
}

async function assertNoErrorBoundary(page, where) {
  // One retry: called right after a navigation settles, so an execution-context-destroyed straggler
  // is possible even though waitForPathname already confirmed the new page is live.
  const text = await page
    .evaluate(() => document.body.innerText)
    .catch(async () => {
      await sleep(200);
      return page.evaluate(() => document.body.innerText);
    });
  const hit = ERROR_BOUNDARY_STRINGS.find((needle) => text.includes(needle));
  if (hit) fail(`The error boundary is showing ${where} (found "${hit}").`);
}

/**
 * Polls for the URL to settle on `pathname`. A real page navigation (which this click turns out to
 * trigger — this app renders plain `<a href>` tags, not a client router) tears down and recreates the
 * page's execution context mid-flight, so `page.evaluate` throws "Execution context was destroyed"
 * for the instant the navigation is in progress; that is expected, not a failure, so it is swallowed
 * and polling continues rather than the whole smoke test crashing on a race it should tolerate.
 */
async function waitForPathname(page, pathname, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await page.evaluate(() => location.pathname).catch(() => null);
    if (current === pathname) return;
    await sleep(200);
  }
  const current = await page.evaluate(() => location.pathname).catch(() => "<unknown>");
  fail(`Clicking the Day link never navigated to ${pathname} (stuck at ${current}).`);
}

async function driveBrowser(executablePath) {
  const { default: puppeteer } = await import("puppeteer-core");
  log(`Launching ${executablePath} (headless)...`);
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  setActiveBrowser(browser);
  let page;
  try {
    page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") console.error(`[smoke] browser console error: ${message.text()}`);
    });

    // The live-updates stream (GET /api/events) is a response that never ends, so "networkidle0" would
    // never fire with it open. Abort it here: the portal treats a failed stream as "no EventSource" and
    // falls back to its polling path, which is exactly the behaviour this smoke has always exercised.
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/events") void request.abort();
      else void request.continue();
    });

    log("Loading / ...");
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle0", timeout: 30_000 });
    assertNoPageErrors(pageErrors, "loading /");
    await assertNoErrorBoundary(page, "on /");
    log("/ loaded with no page errors.");

    // The running-late compact banner used to be structurally unreachable
    // whenever any session was running, however true the underlying fact was. `smoke-seed-late-
    // commitment.ts` seeded a confirmed, located commitment whose start has passed with a pending
    // before-phase routine step, and an unrelated running session — this is the one method in the repo
    // that drives the actual production bundle end to end and would catch a regression in *page
    // composition*, as opposed to the model or scheduler logic other tests already cover.
    log('Checking for "Running late for" on the seeded Now page...');
    const bodyText = await page.evaluate(() => document.body.innerText);
    if (!bodyText.includes("Running late for"))
      fail('Expected the Now page to show "Running late for" for the seeded late commitment, but it did not.');
    log('Found "Running late for" on the seeded Now page.');

    // The default 800px viewport is under the 1024px desk breakpoint, so the phone tab bar is the visible copy.
    log('Clicking the "Day" nav link...');
    const link = await page.$('nav[data-variant="tabs"] a[data-tab="day"]');
    if (!link) fail('Could not find the Day nav link (nav[data-variant="tabs"] a[data-tab="day"]) on the page.');
    await link.click();
    await waitForPathname(page, "/today", 15_000);
    assertNoPageErrors(pageErrors, "clicking Today");
    await assertNoErrorBoundary(page, "on /today");
    log("Click landed on /today with no page errors.");

    // The full-page navigation above tears down and remounts the app, which fires its own background
    // fetches on load (portal-provider's immediate plan-freshness/check-in checks). Closing the
    // browser while one is still in flight aborts the connection mid-response, and the production
    // server logs `[vinext] Server error: Error [ERR_STREAM_UNABLE_TO_PIPE] ...` for the write that
    // lands on a socket the client already tore down. Giving the new page's network a moment to settle
    // — then closing the page itself before the browser process — lets those requests finish normally
    // instead of being cut off.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close();
    setActiveBrowser(null);
  }
}

async function main() {
  log("Checking for a production build...");
  const buildMarker = resolve(PORTAL_DIR, "dist", "server", "BUILD_ID");
  if (!existsSync(buildMarker)) {
    fail(
      "No production build found at portal/dist — run `pnpm build:portal` (or `pnpm --filter @openrhen/portal build`) first."
    );
  }

  log("Resolving the test database (never the live DATABASE_URL)...");
  const { testDatabaseUrl, testDatabaseName } = resolveTestDatabaseUrl();
  log(`Using database "${testDatabaseName}".`);

  const browserPath = await resolveBrowserPath();
  log(`Using browser at ${browserPath}`);

  log("Ensuring the test database exists...");
  await createDatabase(testDatabaseName);

  log("Migrating the test database...");
  await migrateDatabase(testDatabaseUrl);

  log("Seeding a running-late commitment and an unrelated running session...");
  await run(PNPM, ["--filter", "@openrhen/database", "run", "smoke:seed-late-commitment"], {
    ...PNPM_OPTS,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl }
  });

  log(`Starting the production server on ${BASE_URL}...`);
  const server = startPortal({ databaseUrl: testDatabaseUrl, port: PORT });

  try {
    await waitForReady(server, `${BASE_URL}/`);
    await driveBrowser(browserPath);
  } finally {
    log("Stopping the production server...");
    stopDetached(server);
  }
}

installProcessHandlers();

const startedAt = Date.now();
log("Phase 1 of 2: click through the production bundle");
main()
  .then(() => {
    log(`Click phase passed in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
    return runSeedPhase();
  })
  .then(() => {
    log("PASSED");
    process.exit(0);
  })
  .catch((error) => {
    if (error instanceof SmokeFailure) console.error(`\n[smoke] FAILED: ${error.message}`);
    else console.error(error);
    process.exit(1);
  });
