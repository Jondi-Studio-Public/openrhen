#!/usr/bin/env node
// Browser check for ending a recurring commitment closing its future dates instead of deleting them (archive-removals
// design section 7, PR 7b).
//
// Like the click smoke, this drives the built production portal (`pnpm build:portal` first) in a real headless Chrome
// against a scratch database of its own (never the live DATABASE_URL), which it creates, migrates and drops. It seeds a
// weekly rule with future dates (one of them with a pending step) and a past date, then walks what a person does:
//
//   1. Schedule > Recurring commitments > Edit > Status Ended > Save changes: the future dates are cancelled with the
//      reason "Recurrence ended" (not deleted), the past date is untouched, the step is cancelled with its date
//   2. Review > Closed > Cancelled lists those dates with the reason "Recurrence ended"
//   2b. Restore on one closed date brings just that date back
//   3. Edit > Status Active > Save changes: the dates and the step come back, and nothing is left closed
//
// Runs in the CI `smoke` job after the click smoke (`pnpm smoke:recurrence-end`); run it by hand to debug a failure. Screenshots go to var/recurrence-end-flow/ (untracked).
//
//   corepack pnpm build:portal
//   POSTGRES_ADMIN_URL=postgresql://... node scripts/smoke/recurrence-end-flow.mjs
//
// Env: SMOKE_PORT (default 3112) and SMOKE_BROWSER_PATH, as for the click smoke.
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

const PORT = Number(process.env.SMOKE_PORT) || 3112;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = resolve(ROOT, "var", "recurrence-end-flow");
const TITLE = "Pottery class";
const results = [];
const pass = (name) => {
  results.push(name);
  log(`ok  ${name}`);
};

function browserPath() {
  const envPath = process.env.SMOKE_BROWSER_PATH?.trim();
  if (envPath) return existsSync(envPath) ? envPath : fail(`SMOKE_BROWSER_PATH "${envPath}" does not exist.`);
  const found = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].find((candidate) => existsSync(candidate));
  return found ?? fail("No browser found; set SMOKE_BROWSER_PATH (the click smoke can install one).");
}

async function see(page, text, { timeout = 20_000 } = {}) {
  try {
    await page.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout }, text);
  } catch {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 4000));
    fail(`Expected "${text}" on ${page.url()}. The page says:\n${body}`);
  }
}

async function press(page, name, { timeout = 15_000 } = {}) {
  const handle = await page
    .waitForFunction(
      (wanted) =>
        [...document.querySelectorAll("button")].find(
          (el) =>
            !el.disabled &&
            el.offsetParent !== null &&
            (el.getAttribute("aria-label") ?? el.textContent).trim() === wanted
        ) ?? false,
      { timeout },
      name
    )
    .catch(() => fail(`No enabled button named "${name}" on ${page.url()}.`));
  await handle.asElement().click();
}

/** Picks an option of the editor's Status select (the one that offers Active and Ended). */
async function chooseRuleStatus(page, value) {
  await page.waitForFunction(
    () => [...document.querySelectorAll("select")].some((el) => [...el.options].some((o) => o.value === "ended")),
    { timeout: 15_000 }
  );
  await page.evaluate((wanted) => {
    const select = [...document.querySelectorAll("select")].find((el) =>
      [...el.options].some((o) => o.value === "ended")
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, wanted);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

function connect(url) {
  const require = createRequire(resolve(ROOT, "portal", "package.json"));
  return require("postgres")(url, { max: 2, connect_timeout: 10, onnotice: () => {} });
}

async function seed(sql) {
  const [{ id: userId }] = await sql`SELECT id FROM users ORDER BY created_at LIMIT 1`;
  const [{ id: ruleId }] = await sql`
    INSERT INTO commitment_recurrence_rules (user_id,title,timezone,start_date,interval_days,local_start_time,local_end_time,presence,share_to_calendar)
    VALUES (${userId},${TITLE},'Australia/Sydney',current_date - 30,7,'18:00','19:30','blocking',false) RETURNING id`;
  const occurrence = async (days) =>
    (
      await sql`
      INSERT INTO commitments (user_id,title,starts_at,ends_at,status,recurrence_rule_id,local_date)
      VALUES (${userId},${TITLE},now() + ${days} * interval '1 day',now() + ${days} * interval '1 day' + interval '90 minutes','confirmed',${ruleId},(current_date + ${days}::int))
      RETURNING id`
    )[0].id;
  const past = await occurrence(-4);
  const future = [await occurrence(3), await occurrence(10), await occurrence(17)];
  const [{ id: step }] = await sql`
    INSERT INTO routine_steps (user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,max_lead_minutes,status)
    VALUES (${userId},${future[0]},'commitment',${future[0]},'Pack the apron',10,1,'flexible',60,'pending') RETURNING id`;
  return { ruleId, past, future, step };
}

const states = async (sql, ids) =>
  sql`SELECT id, status::text AS status, closed_by, closed_reason, closed_batch FROM commitments WHERE id IN ${sql([ids.past, ...ids.future])} ORDER BY starts_at`;

async function flows(browser, sql, ids) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/events") void request.abort();
    else void request.continue();
  });
  await page.setViewport({ width: 1200, height: 1000 });

  // 1: end the rule.
  await page.goto(`${BASE}/schedule`, { waitUntil: "networkidle0", timeout: 30_000 });
  await see(page, TITLE);
  await press(page, `Edit ${TITLE}`);
  await chooseRuleStatus(page, "ended");
  await shot(page, "editor-ended");
  await press(page, "Save changes");
  await page.waitForFunction(() => document.body.innerText.includes("Ended ·"), { timeout: 20_000 });
  const ended = await states(sql, ids);
  if (ended.length !== 4) fail(`Ending the rule deleted rows: ${ended.length} of 4 left.`);
  const [past, ...future] = ended;
  if (past.status !== "confirmed") fail(`The past date was closed: ${JSON.stringify(past)}`);
  for (const row of future)
    if (row.status !== "cancelled" || row.closed_reason !== "Recurrence ended" || row.closed_by !== "person")
      fail(`A future date was not closed as expected: ${JSON.stringify(row)}`);
  if (new Set(future.map((row) => row.closed_batch)).size !== 1) fail("The closed dates do not share one batch.");
  const [step] = await sql`SELECT status FROM routine_steps WHERE id=${ids.step}`;
  if (step.status !== "cancelled") fail(`The step was left ${step.status}.`);
  pass(
    "Ending the rule in Schedule cancels its future dates (reason Recurrence ended, closed by the person) and their steps, and deletes nothing"
  );

  // 2: the Closed page.
  await page.goto(`${BASE}/review/closed?tab=cancelled`, { waitUntil: "networkidle0", timeout: 30_000 });
  await see(page, TITLE);
  await see(page, "Recurrence ended");
  const shown = await page.evaluate(
    (title) => (document.body.innerText.match(new RegExp(title, "g")) ?? []).length,
    TITLE
  );
  if (shown < 3) fail(`Review > Closed lists ${shown} rows of the ended rule, expected the 3 future dates.`);
  await shot(page, "closed-page");
  pass("Review > Closed > Cancelled lists the three future dates with the reason Recurrence ended");

  // 2b: restore one date on its own while the rule is still ended.
  await press(page, `Restore commitment "${TITLE}"`);
  await see(page, `Restored ${TITLE}`);
  const afterOne = await states(sql, ids);
  const open = afterOne.filter((row) => row.status === "confirmed");
  if (open.length !== 2 || afterOne.filter((row) => row.status === "cancelled").length !== 2)
    fail(`Restoring one date left ${JSON.stringify(afterOne)}`);
  const [kept] =
    await sql`SELECT schedule_source FROM commitments WHERE id=${open.find((row) => row.id !== ids.past).id}`;
  if (kept.schedule_source !== "custom")
    fail(`The restored date is ${kept.schedule_source}, so the planner would prune it.`);
  pass(
    "Restore on Review > Closed brings one date back (kept as the person's, so a replan leaves it), the others stay closed"
  );

  // 3: set the rule active again.
  await page.goto(`${BASE}/schedule`, { waitUntil: "networkidle0", timeout: 30_000 });
  await press(page, `Edit ${TITLE}`);
  await chooseRuleStatus(page, "active");
  await press(page, "Save changes");
  await page.waitForFunction(() => !document.body.innerText.includes("Ended ·"), { timeout: 20_000 });
  const back = await states(sql, ids);
  for (const row of back)
    if (row.status !== "confirmed" || row.closed_by !== null || row.closed_reason !== null)
      fail(`A date is still closed after re-activation: ${JSON.stringify(row)}`);
  const [revived] = await sql`SELECT status, version FROM routine_steps WHERE id=${ids.step}`;
  if (revived.status !== "pending" || revived.version !== 3) fail(`The step came back as ${JSON.stringify(revived)}.`);
  await page.goto(`${BASE}/review/closed?tab=cancelled`, { waitUntil: "networkidle0", timeout: 30_000 });
  if ((await page.evaluate(() => document.body.innerText)).includes("Recurrence ended"))
    fail("Review > Closed still lists the restored dates.");
  await shot(page, "closed-page-after");
  pass("Setting the rule active again brings all four dates and the step back, and Review > Closed is empty of them");

  if (pageErrors.length) fail(`The page threw:\n${pageErrors.join("\n")}`);
  await page.close();
}

async function main() {
  if (!existsSync(resolve(ROOT, "portal", "dist", "server", "BUILD_ID")))
    fail("No production build found at portal/dist; run `pnpm build:portal` first.");
  const { adminUrl } = resolveTestDatabaseUrl();
  const db = scratchDatabase(adminUrl, `recurend${process.pid}x${Date.now().toString(36)}_test`);
  await db.prepare();
  const executablePath = browserPath();
  const server = startPortal({ databaseUrl: db.url, port: PORT });
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
      await flows(browser, sql, ids);
    } finally {
      await browser.close();
      setActiveBrowser(null);
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
    stopDetached(server);
    db.drop();
    await sleep(0);
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
