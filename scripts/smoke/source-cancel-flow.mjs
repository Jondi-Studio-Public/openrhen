#!/usr/bin/env node
// Browser check for a calendar cancellation that cancels the commitment instead of deleting it (archive-removals
// design section 7, PR 7a).
//
// Like the click smoke, this drives the built production portal (`pnpm build:portal` first) in a real headless Chrome
// against a scratch database of its own (never the live DATABASE_URL), which it creates, migrates and drops. It seeds
// the state a Google Calendar cancellation leaves behind with SQL, then walks what a person sees:
//
//   1. an import preview holding the source's removal says that confirming it cancels the commitment (restorable),
//      and an update to a commitment the person cancelled says it is still cancelled
//   2. a commitment the import cancelled is listed in Review > Closed with the "Removed at source" reason, and Restore
//      brings it (and its step) back
//
// Runs in the CI `smoke` job after the click smoke (`pnpm smoke:source-cancel`); run it by hand to debug a failure. Screenshots go to var/source-cancel-flow/ (untracked).
//
//   corepack pnpm build:portal
//   POSTGRES_ADMIN_URL=postgresql://... node scripts/smoke/source-cancel-flow.mjs
//
// Env: SMOKE_PORT (default 3111) and SMOKE_BROWSER_PATH, as for the click smoke.
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

const PORT = Number(process.env.SMOKE_PORT) || 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = resolve(ROOT, "var", "source-cancel-flow");
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

async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

function connect(url) {
  const require = createRequire(resolve(ROOT, "portal", "package.json"));
  return require("postgres")(url, { max: 2, connect_timeout: 10, onnotice: () => {} });
}

const field = (value, evidence) => ({ value, basis: "explicit", confidence: "high", evidence, needsReview: false });

async function seed(sql) {
  const [{ id: userId }] = await sql`SELECT id FROM users ORDER BY created_at LIMIT 1`;
  const one = async (query) => (await query)[0].id;
  const commitment = (title) =>
    one(sql`
      INSERT INTO commitments (user_id,title,starts_at,ends_at,status)
      VALUES (${userId},${title},now() + interval '3 days',now() + interval '3 days 1 hour','confirmed') RETURNING id`);
  // What a Google cancellation committed earlier leaves: cancelled by the system, with the source's reason, one step with it.
  const removed = await commitment("Dentist (cancelled in Google)");
  const step = await one(sql`
    INSERT INTO routine_steps (user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,max_lead_minutes,status)
    VALUES (${userId},${removed},'commitment',${removed},'Pack bag',10,1,'flexible',60,'cancelled') RETURNING id`);
  const batch = crypto.randomUUID();
  await sql`UPDATE commitments SET status='cancelled', closed_by='system', closed_at=now() - interval '1 hour',
    closed_from_status='confirmed', closed_batch=${batch}, closed_reason='Removed at source: Cancelled in Google Calendar' WHERE id=${removed}`;
  await sql`INSERT INTO write_rows (write_id, user_id, entity_type, entity_id, operation, evidence)
    SELECT w.id, ${userId}, 'commitment', ${removed}, 'close', ${sql.json({ do: "close", verb: "cancel", batch, cascade: [{ type: "routine_step", id: step, from: "pending", version: 2 }], skipped: [], closed: 2, counted: false, via: "import" })}
    FROM (SELECT ${sql`gen_random_uuid()`}::uuid AS id) w`.catch(async () => {
    const writeId = crypto.randomUUID();
    await sql`INSERT INTO writes (id,user_id,command_type,actor) VALUES (${writeId},${userId},'import_commit','system')`;
    await sql`INSERT INTO write_rows (write_id, user_id, entity_type, entity_id, operation, evidence)
      VALUES (${writeId}, ${userId}, 'commitment', ${removed}, 'close', ${sql.json({ do: "close", verb: "cancel", batch, cascade: [{ type: "routine_step", id: step, from: "pending", version: 2 }], skipped: [], closed: 2, counted: false, via: "import" })})`;
  });
  await sql`UPDATE routine_steps SET version=2 WHERE id=${step}`;

  // A commitment the person cancelled, and an open calendar batch proposing the source's removal of one commitment and a change to the other.
  const mine = await commitment("Physio (cancelled by me)");
  await sql`UPDATE commitments SET status='cancelled', closed_by='person', closed_at=now() - interval '2 hours', closed_from_status='confirmed' WHERE id=${mine}`;
  const pending = await commitment("Haircut (to be cancelled)");
  const batchId = await one(sql`
    INSERT INTO import_batches (user_id, source_type, input_kind, timezone, template_version, status)
    VALUES (${userId}, 'google_calendar', 'calendar_updates', 'Australia/Sydney', '1', 'ready') RETURNING id`);
  const record = (importKey, operation, matched, fields, warnings, sortOrder) =>
    sql`INSERT INTO import_records (id,batch_id,import_key,entity_type,operation,expected_version,matched_entity_id,fields,relationships,validation_errors,warnings,removed,sort_order)
      VALUES (${crypto.randomUUID()},${batchId},${importKey},'fixed_commitment',${operation},1,${matched},${sql.json(fields)},${sql.json({})},${sql.json([])},${sql.json(warnings)},false,${sortOrder})`;
  const startsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const endsAt = new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString();
  await record(
    "google_calendar:event:smoke:haircut",
    "delete",
    pending,
    {
      title: field("Haircut (to be cancelled)", ["Cancelled in Google Calendar"]),
      startsAt: field(startsAt, ["Cancelled in Google Calendar"]),
      endsAt: field(endsAt, ["Cancelled in Google Calendar"])
    },
    ["Confirming this row cancels the commitment. You can restore it from Review > Closed."],
    0
  );
  await record(
    "google_calendar:event:smoke:physio",
    "update",
    mine,
    {
      title: field("Physio (moved in Google)", ["Updated in Google Calendar · Jon"]),
      startsAt: field(startsAt, ["Kept from OpenRhen"]),
      endsAt: field(endsAt, ["Kept from OpenRhen"]),
      status: field("cancelled", ["Kept from OpenRhen"])
    },
    ["Still cancelled by you. Restore it from Review > Closed."],
    1
  );
  return { removed, step, pending, mine };
}

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

  // 1: the preview.
  await page.goto(`${BASE}/inbox/calendar`, { waitUntil: "networkidle0", timeout: 30_000 });
  await see(page, "Haircut (to be cancelled)");
  await press(page, "Change first");
  await see(page, "Confirming this row cancels the commitment. You can restore it from Review > Closed.");
  if ((await page.evaluate(() => document.body.innerText)).includes("permanently deletes"))
    fail("The preview still says a calendar removal permanently deletes the commitment.");
  await see(page, "Still cancelled by you. Restore it from Review > Closed.");
  await shot(page, "import-preview");
  pass(
    "The import preview says a calendar removal cancels (restorably), and an update to a cancelled one says it is still cancelled"
  );

  // 2: the Closed page and Restore.
  await page.goto(`${BASE}/review/closed?tab=cancelled`, { waitUntil: "networkidle0", timeout: 30_000 });
  await see(page, "Dentist (cancelled in Google)");
  await see(page, "Removed at source: Cancelled in Google Calendar");
  await shot(page, "closed-page");
  await press(page, 'Restore commitment "Dentist (cancelled in Google)"');
  await see(page, "Restored Dentist (cancelled in Google)");
  const [row] =
    await sql`SELECT status, closed_at, closed_by, closed_batch, closed_reason FROM commitments WHERE id=${ids.removed}`;
  if (row.status === "cancelled" || row.closed_at !== null || row.closed_by !== null || row.closed_reason !== null)
    fail(`Restore left the commitment closed: ${JSON.stringify(row)}`);
  const [step] = await sql`SELECT status FROM routine_steps WHERE id=${ids.step}`;
  if (step.status !== "pending") fail(`Restore left the step ${step.status}.`);
  pass(
    "Review > Closed lists the import's cancel with its source reason, and Restore reopens the commitment and its step"
  );

  if (pageErrors.length) fail(`The page threw:\n${pageErrors.join("\n")}`);
  await page.close();
}

async function main() {
  if (!existsSync(resolve(ROOT, "portal", "dist", "server", "BUILD_ID")))
    fail("No production build found at portal/dist; run `pnpm build:portal` first.");
  const { adminUrl } = resolveTestDatabaseUrl();
  const db = scratchDatabase(adminUrl, `srccancel${process.pid}x${Date.now().toString(36)}_test`);
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
