import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importBatchSchema, previewImportSchema, type ImportBatch } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type FakeResponse, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState, fixtureTimeZone } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

async function run(
  argv: readonly string[],
  routes: Record<string, FakeResponse | ((call: RecordedCall) => FakeResponse)>
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch(routes, calls)
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

const BATCH_ID = randomUUID();
const RECORD_OK_ID = randomUUID();
const RECORD_BAD_ID = randomUUID();
const STATE_ROUTE = { "/api/state": { body: { state: fixtureRawState() } } };

/** Two records, one clean and one carrying a blocking error, valid per `importBatchSchema`. */
function cannedBatch(overrides: Partial<ImportBatch> = {}): ImportBatch {
  const batch = {
    id: BATCH_ID,
    sourceType: "fixture" as const,
    inputKind: "planning_data" as const,
    timezone: fixtureTimeZone,
    templateVersion: "1" as const,
    status: "draft" as const,
    version: 3,
    records: [
      {
        id: RECORD_OK_ID,
        importKey: "row-1",
        entityType: "action" as const,
        operation: "create" as const,
        expectedVersion: null,
        matchedEntityId: null,
        fields: {
          title: {
            value: "Draft chapter 3",
            basis: "explicit" as const,
            confidence: "high" as const,
            evidence: [],
            needsReview: false
          }
        },
        relationships: {},
        errors: [],
        warnings: [],
        removed: false,
        sortOrder: 0
      },
      {
        id: RECORD_BAD_ID,
        importKey: "row-2",
        entityType: "project" as const,
        operation: "create" as const,
        expectedVersion: null,
        matchedEntityId: null,
        fields: {},
        relationships: {},
        errors: ["Missing required field: title"],
        warnings: ["No area matched; left unset"],
        removed: false,
        sortOrder: 1
      }
    ],
    source: { filename: "records.json" },
    ...overrides
  };
  expect(() => importBatchSchema.parse(batch)).not.toThrow();
  return batch as ImportBatch;
}

function tempRecordsFile(records: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "openrhen-import-"));
  const path = join(dir, "records.json");
  writeFileSync(path, JSON.stringify(records), "utf8");
  return path;
}

describe("import list", () => {
  it("renders the batches table from a canned GET", async () => {
    const summary = {
      id: BATCH_ID,
      sourceType: "fixture",
      inputKind: "planning_data",
      status: "draft",
      version: 1,
      createdAt: "2026-09-01T00:00:00+10:00",
      updatedAt: "2026-09-01T00:00:00+10:00",
      committedAt: null,
      filename: "records.json",
      recordCount: 2,
      blockingCount: 1
    };
    const result = await run(["import", "list"], { "/api/imports": { body: { batches: [summary], history: [] } } });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain(BATCH_ID);
    expect(result.stdout).toContain("draft");
  });
});

describe("import preview", () => {
  it("posts a payload that parses with previewImportSchema, wraps bare fields, uses the state timezone, and prints the record error", async () => {
    const path = tempRecordsFile([
      { importKey: "row-1", entityType: "action", fields: { title: "Draft chapter 3" } },
      { importKey: "row-2", entityType: "project", fields: {} }
    ]);
    const batch = cannedBatch();
    const result = await run(["import", "preview", "--from", path], {
      ...STATE_ROUTE,
      "/api/imports/preview": (call) => {
        const parsed = previewImportSchema.safeParse(call.body);
        expect(parsed.success).toBe(true);
        return { body: { batch, reopened: false } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("Missing required field: title");

    const posted = result.calls.find((call) => call.path === "/api/imports/preview");
    expect(posted).toBeDefined();
    const body = posted?.body as { timezone: string; records: { fields: Record<string, unknown> }[] };
    expect(body.timezone).toBe(fixtureTimeZone);
    expect(body.records[0]?.fields.title).toMatchObject({
      value: "Draft chapter 3",
      basis: "explicit",
      confidence: "high"
    });
  });

  it("--dry-run makes no POST", async () => {
    const path = tempRecordsFile([{ importKey: "row-1", entityType: "action", fields: { title: "X" } }]);
    const result = await run(["import", "preview", "--from", path, "--timezone", fixtureTimeZone, "--dry-run"], {
      ...STATE_ROUTE,
      "/api/imports/preview": { body: { batch: cannedBatch(), reopened: false } }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.some((call) => call.path === "/api/imports/preview")).toBe(false);
    const doc = JSON.parse(result.stdout) as { dryRun: boolean; path: string };
    expect(doc.dryRun).toBe(true);
    expect(doc.path).toBe("/api/imports/preview");
  });

  it("maps a 413 from the portal to exit 5", async () => {
    const path = tempRecordsFile([{ importKey: "row-1", entityType: "action", fields: { title: "X" } }]);
    const result = await run(["import", "preview", "--from", path, "--timezone", fixtureTimeZone], {
      "/api/imports/preview": { status: 413, body: { error: "Import preview payload is too large." } }
    });
    expect(result.exitCode).toBe(EXIT.unavailable);
  });
});

describe("import show", () => {
  it("renders the batch and its record errors", async () => {
    const result = await run(["import", "show", BATCH_ID], {
      [`/api/imports/${BATCH_ID}`]: { body: { batch: cannedBatch() } }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("row-2");
    expect(result.stdout).toContain("Missing required field: title");
    expect(result.stdout).toContain("No area matched; left unset");
  });
});

describe("import update", () => {
  it("PUTs the fetched batch's version as expectedVersion", async () => {
    const path = tempRecordsFile({ records: [{ importKey: "row-1", entityType: "action", fields: { title: "Y" } }] });
    const batch = cannedBatch({ version: 7 });
    const result = await run(["import", "update", BATCH_ID, "--from", path], {
      [`/api/imports/${BATCH_ID}`]: (call) =>
        call.method === "GET" ? { body: { batch } } : { body: { batch: cannedBatch({ version: 8 }) } }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    const put = result.calls.find((call) => call.method === "PUT" && call.path === `/api/imports/${BATCH_ID}`);
    expect(put).toBeDefined();
    expect((put!.body as { expectedVersion: number }).expectedVersion).toBe(7);
  });
});

describe("import commit", () => {
  it("without --yes refuses, exit 1, no POST", async () => {
    const result = await run(["import", "commit", BATCH_ID], {
      [`/api/imports/${BATCH_ID}`]: { body: { batch: cannedBatch() } }
    });
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("--yes");
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("--yes posts {expectedVersion} and prints the committed status", async () => {
    const batch = cannedBatch({ version: 3 });
    const committed = cannedBatch({ status: "committed", version: 4 });
    const result = await run(["import", "commit", BATCH_ID, "--yes"], {
      [`/api/imports/${BATCH_ID}`]: { body: { batch } },
      [`/api/imports/${BATCH_ID}/commit`]: (call) => {
        expect(call.body).toEqual({ expectedVersion: 3 });
        return { body: { batch: committed, state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("committed");
  });

  it("--ready-only hits /commit-ready and prints the deferred batch id", async () => {
    const deferredId = randomUUID();
    const batch = cannedBatch({ version: 3 });
    const deferred = cannedBatch({ id: deferredId, status: "blocked", version: 1 });
    const result = await run(["import", "commit", BATCH_ID, "--ready-only", "--yes"], {
      [`/api/imports/${BATCH_ID}`]: { body: { batch } },
      [`/api/imports/${BATCH_ID}/commit-ready`]: (call) => {
        expect(call.body).toEqual({ expectedVersion: 3 });
        return { body: { batch: cannedBatch({ status: "committed" }), deferred, state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain(deferredId);
    expect(result.calls.some((call) => call.path === `/api/imports/${BATCH_ID}/commit-ready`)).toBe(true);
  });

  it("a 409 from commit maps to exit 3", async () => {
    const batch = cannedBatch({ version: 3 });
    const result = await run(["import", "commit", BATCH_ID, "--yes"], {
      [`/api/imports/${BATCH_ID}`]: { body: { batch } },
      [`/api/imports/${BATCH_ID}/commit`]: { status: 409, body: { error: "Import batch changed since it was read." } }
    });
    expect(result.exitCode).toBe(EXIT.conflict);
  });
});

describe("import delete", () => {
  it("without --yes refuses", async () => {
    const result = await run(["import", "delete", BATCH_ID], {});
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("--yes");
    expect(result.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("--yes sends DELETE", async () => {
    const result = await run(["import", "delete", BATCH_ID, "--yes"], {
      [`/api/imports/${BATCH_ID}`]: { body: { deleted: true } }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    const del = result.calls.find((call) => call.method === "DELETE" && call.path === `/api/imports/${BATCH_ID}`);
    expect(del).toBeDefined();
    expect(result.stdout).toContain(BATCH_ID);
  });
});
