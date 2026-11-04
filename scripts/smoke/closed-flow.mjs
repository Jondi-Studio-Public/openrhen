#!/usr/bin/env node
// Browser check for archive, cancel and the Closed page (archive-removals design, PR 6).
//
// Like the click smoke, this drives the built production portal (`pnpm build:portal` first) in a real headless
// Chrome against a scratch database of its own (never the live DATABASE_URL), which it creates, migrates and drops.
// It seeds a small plan with SQL, then walks the flows a person uses:
//
//   1. an action: Cancel, then Undo; the row is open again with its closed_* columns cleared
//   2. an outcome with projects: the "Close all" question, Keep open, Close all, Undo brings the batch back
//   3. a commitment: Cancel shows the toast; Review > Closed lists it as closed by "You"; Restore
//   4. an agent close: the badge on Now and Today, the row's agent and reason, the badge gone after opening Closed
//   5. an undo-of-create close is neither listed nor counted
//   6. a stale second tab: its Restore refreshes the list instead of repeating a server sentence; a row under a
//      closed parent has its Restore disabled and names the parent
//   7. recovery: with the server stopped the list says so, and Try again works once it is back
//   8. keyboard, screen-reader names and a 360px viewport (no horizontal scroll)
//
// Not part of CI (`pnpm gate` runs the production click smoke); run it by hand before a change to these screens and
// record the result in the PR. Screenshots go to var/closed-flow/ (untracked).
//
//   corepack pnpm build:portal
//   POSTGRES_ADMIN_URL=postgresql://... node scripts/smoke/closed-flow.mjs
//
// Env: SMOKE_PORT (default 3110) and SMOKE_BROWSER_PATH, as for the click smoke.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  ROOT,
  SmokeFailure,
  fail,
  installProcessHandlers,
  log,
  resolveTestDatabaseUrl,
  scratchDatabase,
  setActiveBrowser,
  sleep,
  startPortal,
  stopDetached,
  waitForReady
} from "./boot.mjs";

const PORT = Number(process.env.SMOKE_PORT) || 3110;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = resolve(ROOT, "var", "closed-flow");
const results = [];

function pass(name) {
  results.push(name);
  log(`ok  ${name}`);
}

async function browserPath() {
  const envPath = process.env.SMOKE_BROWSER_PATH?.trim();
  if (envPath) {
    if (!existsSync(envPath)) fail(`SMOKE_BROWSER_PATH is set to "${envPath}", but no file exists there.`);
    return envPath;
  }
  const found = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].find((candidate) => existsSync(candidate));
  if (found) return found;
  const cacheDir = resolve(ROOT, "node_modules", ".cache", "chrome-for-testing");
  mkdirSync(cacheDir, { recursive: true });
  const installed = spawnSync(process.execPath, [resolve(ROOT, "scripts/smoke/install-chrome.mjs"), cacheDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  const path = installed.stdout?.trim().split(/\r?\n/).pop();
  if (installed.status !== 0 || !path || !existsSync(path)) fail("No browser found; set SMOKE_BROWSER_PATH.");
  return path;
}

// ---- browser helpers ----------------------------------------------------------------------------------------

const label = (el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();

/** Waits for a visible button whose accessible name (aria-label, else text) equals or matches `name`, then clicks it. */
async function press(page, name, { timeout = 15_000 } = {}) {
  const source = name instanceof RegExp ? name.source : null;
  const exact = name instanceof RegExp ? null : name;
  const handle = await page
    .waitForFunction(
      (exactName, regexSource, labelFn) => {
        const read = new Function("el", `return (${labelFn})(el)`);
        const matcher = regexSource ? new RegExp(regexSource) : null;
        return (
          [...document.querySelectorAll("button, a[role=button], [role=tab]")].find((el) => {
            if (el.disabled || el.offsetParent === null) return false;
            const text = read(el);
            return matcher ? matcher.test(text) : text === exactName;
          }) ?? false
        );
      },
      { timeout },
      exact,
      source,
      label.toString()
    )
    .catch(async () => {
      const names = await page.evaluate((labelFn) => {
        const read = new Function("el", `return (${labelFn})(el)`);
        return [...document.querySelectorAll("button")].map(read).filter(Boolean).slice(0, 40);
      }, label.toString());
      fail(`No enabled button named ${name} on ${page.url()}. Buttons: ${names.join(" | ")}`);
    });
  await handle.asElement().click();
}

/** Waits until the page body contains `text` (string) or matches (RegExp). */
async function see(page, text, { timeout = 15_000 } = {}) {
  const source = text instanceof RegExp ? text.source : null;
  try {
    await page.waitForFunction(
      (needle, regexSource) => {
        const body = document.body.innerText;
        return regexSource ? new RegExp(regexSource).test(body) : body.includes(needle);
      },
      { timeout },
      text instanceof RegExp ? null : text,
      source
    );
  } catch {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 4000));
    fail(`Expected ${text} on ${page.url()}. The page says:\n${body}`);
  }
}

async function gone(page, text, { timeout = 15_000 } = {}) {
  try {
    await page.waitForFunction((needle) => !document.body.innerText.includes(needle), { timeout }, text);
  } catch {
    fail(`"${text}" never left ${page.url()}.`);
  }
}

async function open(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0", timeout: 30_000 });
}

/** Opens every project's "Actions (n)" disclosure, which starts collapsed. */
async function expandActions(page) {
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) {
      if ((details.querySelector("summary")?.textContent ?? "").startsWith("Actions (")) details.open = true;
    }
  });
}

/** Clicks the "Edit" button inside the nearest card/row that contains `title`. */
async function editRow(page, title) {
  await see(page, title);
  const clicked = await page.evaluate((needle) => {
    const hits = [...document.querySelectorAll("strong, span, p, h2, h3")].filter(
      (el) => el.textContent.trim() === needle
    );
    for (const hit of hits) {
      let node = hit;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        const edit = [...node.querySelectorAll("button")].find((button) => button.textContent.trim() === "Edit");
        if (edit) {
          edit.click();
          return true;
        }
      }
    }
    return false;
  }, title);
  if (!clicked) fail(`No Edit button found beside "${title}" on ${page.url()}.`);
}

async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

// ---- database helpers ---------------------------------------------------------------------------------------

function connect(url) {
  const require = createRequire(resolve(ROOT, "portal", "package.json"));
  const postgres = require("postgres");
  return postgres(url, { max: 2, connect_timeout: 10, onnotice: () => {} });
}

async function seed(sql) {
  const [{ id: userId }] = await sql`SELECT id FROM users ORDER BY created_at LIMIT 1`;
  const one = async (query) => (await query)[0].id;
  const area = await one(
    sql`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Smoke area','active',0) RETURNING id`
  );
  const outcome = (title) =>
    one(
      sql`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area},${title},'Done','active') RETURNING id`
    );
  const project = (outcomeId, title) =>
    one(sql`INSERT INTO projects (outcome_id,title,status) VALUES (${outcomeId},${title},'active') RETURNING id`);
  const action = (projectId, title) =>
    one(sql`
      INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
      VALUES (${projectId},${title},'one_off','planned',30,60,90,60,'medium',15,90) RETURNING id`);
  const solo = await outcome("Solo outcome");
  const soloProject = await project(solo, "Solo project");
  const soloAction = await action(soloProject, "Solo action");
  const big = await outcome("Garden rebuild");
  const bigProject = await project(big, "Beds");
  const bigProject2 = await project(big, "Paths");
  await action(bigProject, "Dig the beds");
  const commitment = await one(sql`
    INSERT INTO commitments (user_id,title,starts_at,ends_at,status)
    VALUES (${userId},'Dentist visit',now() + interval '3 days',now() + interval '3 days 1 hour','confirmed') RETURNING id`);
  // Closed by an agent an hour ago (the badge counts it), and one that took back a create (neither listed nor counted).
  const agentClosed = await action(soloProject, "Agent closed action");
  await sql`UPDATE actions SET status='cancelled', closed_by='agent:claude', closed_at=now() - interval '1 hour',
    closed_reason='Duplicate of Solo action', closed_from_status='planned' WHERE id=${agentClosed}`;
  const undone = await action(soloProject, "Undone create");
  await sql`UPDATE actions SET status='cancelled', closed_by='agent:claude:undo', closed_at=now() - interval '2 hours' WHERE id=${undone}`;
  // A closed project with a closed action under it, for the blocked Restore.
  const oldOutcome = await outcome("Old outcome");
  const oldProject = await project(oldOutcome, "Retired project");
  const underClosed = await action(oldProject, "Action under a retired project");
  await sql`UPDATE actions SET status='cancelled', closed_by='person', closed_at=now() - interval '3 days', closed_from_status='planned' WHERE id=${underClosed}`;
  await sql`UPDATE projects SET status='cancelled', closed_by='person', closed_at=now() - interval '3 days', closed_from_status='active' WHERE id=${oldProject}`;
  return { area, soloAction, big, bigProject, bigProject2, commitment, solo, userId };
}

const statusOf = async (sql, table, id) =>
  (await sql.unsafe(`SELECT status, closed_at, closed_by, closed_batch FROM ${table} WHERE id = $1`, [id]))[0];

// ---- the flows ----------------------------------------------------------------------------------------------

async function flows(browser, sql, ids, server, restartServer) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/events") void request.abort();
    else void request.continue();
  });
  await page.setViewport({ width: 1200, height: 900 });

  // 4 (first half): the badge, before anything opens the Closed page.
  await open(page, "/");
  await see(page, "1 item closed by an agent in the last 24 hours.");
  await shot(page, "badge-now");
  pass("Now shows the agent-close badge, counting 1 (the undo-of-create close is not counted)");
  await open(page, "/today");
  await see(page, "1 item closed by an agent in the last 24 hours.");
  pass("Today shows the same badge");

  // 1: an action, Cancel then Undo.
  await open(page, `/plan/${ids.area}`);
  await expandActions(page);
  await editRow(page, "Solo action");
  await press(page, 'Cancel action "Solo action"');
  await see(page, "Solo action cancelled.");
  let row = await statusOf(sql, "actions", ids.soloAction);
  if (row.status !== "cancelled" || row.closed_by !== "person") fail(`Cancel left ${JSON.stringify(row)}`);
  await shot(page, "action-cancelled-toast");
  await press(page, "Undo");
  await see(page, "Restored Solo action");
  row = await statusOf(sql, "actions", ids.soloAction);
  if (row.status === "cancelled" || row.closed_at !== null || row.closed_by !== null)
    fail(`Undo left the action closed: ${JSON.stringify(row)}`);
  pass("Action: Cancel is stamped as the person; Undo reopens it and clears closed_at and closed_by");

  // 2: an outcome with projects.
  await open(page, `/plan/${ids.area}`);
  await editRow(page, "Garden rebuild");
  await press(page, 'Close outcome "Garden rebuild"');
  await press(page, /^Cancel \(abandoned\)/);
  await see(page, /Close all|open/i);
  await press(page, "Keep open");
  row = await statusOf(sql, "outcomes", ids.big);
  if (row.status === "cancelled") fail("Keep open still closed the outcome.");
  await press(page, 'Close outcome "Garden rebuild"');
  await press(page, /^Cancel \(abandoned\)/);
  await press(page, "Close all");
  await see(page, "Garden rebuild cancelled and ");
  const projects = await sql`SELECT status FROM projects WHERE outcome_id = ${ids.big}`;
  if (projects.some((p) => p.status !== "cancelled")) fail("Close all left a project open.");
  await shot(page, "outcome-close-all");
  await press(page, "Undo");
  await see(page, "Restored Garden rebuild");
  const after = await sql`SELECT status FROM projects WHERE outcome_id = ${ids.big}`;
  if (after.some((p) => p.status === "cancelled")) fail("Undo did not bring the batch back.");
  pass("Outcome: the children question, Keep open leaves it, Close all cascades, Undo restores the batch");

  // 3: a commitment, from its own page, then the Closed page.
  await open(page, `/commitments/${ids.commitment}`);
  await press(page, "Edit");
  await press(page, 'Cancel commitment "Dentist visit"');
  await see(page, "Dentist visit cancelled");
  await shot(page, "commitment-cancelled");
  await open(page, "/review/closed?tab=cancelled");
  await see(page, "Dentist visit");
  await see(page, /You, /);
  await shot(page, "closed-page");
  pass("Commitment: Cancel shows the toast; Review > Closed lists it as closed by You");

  // 4 (second half): who and why for the agent's close, and the badge is gone now.
  await see(page, "Agent claude");
  await see(page, "Reason: Duplicate of Solo action");
  if ((await page.evaluate(() => document.body.innerText)).includes("Undone create"))
    fail("The undo-of-create close is listed.");
  pass("Closed page names the agent and the reason, and does not list the undo-of-create close");
  await open(page, "/");
  await sleep(1500);
  if ((await page.evaluate(() => document.body.innerText)).includes("closed by an agent"))
    fail("The badge stayed after the Closed page was opened.");
  await open(page, "/today");
  await sleep(1000);
  if ((await page.evaluate(() => document.body.innerText)).includes("closed by an agent"))
    fail("The badge stayed on Today.");
  pass("Opening Review > Closed on this device clears the badge on Now and Today");

  // 6: blocked restore, then the stale second tab.
  await open(page, "/review/closed?tab=cancelled");
  await see(page, "Action under a retired project");
  await see(page, "Restore Retired project first");
  const blocked = await page.evaluate(() => {
    const el = [...document.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") ?? "").includes("Action under a retired project")
    );
    return el ? el.disabled : null;
  });
  if (blocked !== true) fail("Restore under a closed parent is not disabled.");
  pass("A row under a closed parent has Restore disabled and names the parent");

  const second = await browser.newPage();
  await second.setRequestInterception(true);
  second.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/events") void request.abort();
    else void request.continue();
  });
  await second.setViewport({ width: 1200, height: 900 });
  await open(second, "/review/closed?tab=cancelled");
  await see(second, "Dentist visit");
  await page.bringToFront();
  await press(page, 'Restore commitment "Dentist visit"');
  await see(page, "Restored Dentist visit");
  await second.bringToFront();
  await press(second, 'Restore commitment "Dentist visit"');
  await see(second, "the list was refreshed");
  await gone(second, "Dentist visit").catch(() => {});
  if ((await second.evaluate(() => document.body.innerText)).includes("version"))
    fail("A server sentence about versions was shown.");
  await second.close();
  await page.bringToFront();
  pass("Stale second tab: Restore refreshes the list and shows no server sentence");

  // 7: recovery after the server stops.
  await open(page, "/review/closed?tab=cancelled");
  await see(page, "Action under a retired project");
  stopDetached(server);
  await sleep(500);
  await press(page, "Cancelled", { timeout: 5_000 }).catch(() => {});
  await press(page, /^Archived/);
  await see(page, "The closed list could not be read.");
  await shot(page, "closed-offline");
  await restartServer();
  await press(page, "Try again");
  await gone(page, "The closed list could not be read.");
  pass("Recovery: the list says it cannot be read while the server is down and Try again works after");

  // 8: keyboard, names, phone width.
  await open(page, "/review/closed?tab=cancelled");
  await see(page, "Action under a retired project");
  const tablist = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll("[role=tablist][aria-label] [role=tab]")];
    return tabs.map((tab) => ({ name: tab.textContent.trim(), selected: tab.getAttribute("aria-selected") }));
  });
  if (tablist.length !== 2) fail(`Expected two tabs, saw ${JSON.stringify(tablist)}`);
  await page.keyboard.press("Tab");
  const focusVisible = await page.evaluate(() => document.activeElement && document.activeElement !== document.body);
  if (!focusVisible) fail("Tab moved focus nowhere.");
  const unnamed = await page.evaluate(
    () =>
      [...document.querySelectorAll("main button")].filter(
        (b) => !(b.getAttribute("aria-label") || b.textContent).trim()
      ).length
  );
  if (unnamed > 0) fail(`${unnamed} buttons on the Closed page have no accessible name.`);
  await page.setViewport({ width: 360, height: 740 });
  await open(page, "/review/closed?tab=cancelled");
  await see(page, "Action under a retired project");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  if (overflow > 0) fail(`The Closed page scrolls sideways by ${overflow}px at 360px.`);
  const small = await page.evaluate(
    () => [...document.querySelectorAll("main li button")].filter((b) => b.getBoundingClientRect().height < 44).length
  );
  if (small > 0) fail(`${small} row buttons are under 44px tall at 360px.`);
  await shot(page, "closed-360");
  pass("Keyboard focus, accessible names, and a 360px viewport with no sideways scroll and 44px buttons");

  if (pageErrors.length) fail(`The page threw:\n${pageErrors.join("\n")}`);
  await page.close();
}

async function main() {
  if (!existsSync(resolve(ROOT, "portal", "dist", "server", "BUILD_ID")))
    fail("No production build found at portal/dist; run `pnpm build:portal` first.");
  const { adminUrl } = resolveTestDatabaseUrl();
  const db = scratchDatabase(adminUrl, `closedflow${process.pid}x${Date.now().toString(36)}_test`);
  await db.prepare();
  const executablePath = await browserPath();

  let server = startPortal({ databaseUrl: db.url, port: PORT });
  const sql = connect(db.url);
  try {
    await waitForReady(server, `${BASE}/`);
    // The first read creates the owner and the starting records.
    await fetch(`${BASE}/api/state`).catch(() => {});
    const ids = await seed(sql);
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
    setActiveBrowser(browser);
    try {
      await flows(browser, sql, ids, server, async () => {
        server = startPortal({ databaseUrl: db.url, port: PORT });
        await waitForReady(server, `${BASE}/`);
      });
    } finally {
      await browser.close();
      setActiveBrowser(null);
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
    stopDetached(server);
    db.drop();
  }
}

installProcessHandlers();
main()
  .then(() => {
    log(`PASSED (${results.length} checks)`);
    for (const name of results) console.log(` - ${name}`);
    process.exit(0);
  })
  .catch((error) => {
    if (error instanceof SmokeFailure) console.error(`\n[smoke] FAILED: ${error.message}`);
    else console.error(error);
    process.exit(1);
  });
