import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describeMessageProblem } from "@openrhen/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { fakeFetch, type FakeResponse, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow } from "./fixture-state.js";

const dir = mkdtempSync(join(tmpdir(), "cli-mail-import-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Route = FakeResponse | ((call: RecordedCall) => FakeResponse);
const SRC = "demo-mail-import";

async function run(argv: readonly string[], routes: Record<string, Route>) {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch(routes, calls)
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** A portal stand-in that holds keys per source and judges every message with the contracts' own validator. */
function portal() {
  const seen = new Set<string>();
  const problems: string[] = [];
  const sent: {
    id: string;
    source: string;
    kind?: string;
    start: string;
    content?: string;
    attrs: Record<string, unknown>;
  }[] = [];
  const runs: Record<string, unknown>[] = [];
  const routes: Record<string, Route> = {
    "/api/activity-imports/runs": (call) => {
      runs.push(call.body as Record<string, unknown>);
      return { body: { recorded: true } };
    },
    "/api/activity-imports": () => ({ body: { held: false } }),
    "/api/activity-events": (call) => {
      const body = call.body as { events: typeof sent; importId?: string; import?: unknown };
      let added = 0;
      let alreadyHeld = 0;
      for (const event of body.events) {
        sent.push(event);
        const verdict = describeMessageProblem({
          id: event.id,
          kind: event.kind ?? "message",
          tsStart: new Date(event.start),
          tsEnd: null,
          content: event.content ?? null,
          attrs: event.attrs
        });
        if (!verdict.ok) problems.push(verdict.reason);
        if (seen.has(`${event.source}/${event.id}`)) alreadyHeld += 1;
        else {
          seen.add(`${event.source}/${event.id}`);
          added += 1;
        }
      }
      return {
        body: {
          added,
          alreadyHeld,
          contentDropped: 0,
          rejected: [],
          importId: body.importId ?? "33333333-3333-4333-8333-333333333333"
        }
      };
    }
  };
  return { routes, sent, problems, runs, seen };
}

const ENV = "From a@example.test Mon Jan  5 10:00:00 2026\n";
const m = (id: string | null, text: string, extra = "") =>
  `${ENV}From: Alex <alex@example.test>\nTo: me@example.test\n${id ? `Message-ID: <${id}>\n` : ""}Date: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: S ${text}\n${extra}\n${text}\n\n`;

describe("rhen import mail", () => {
  const inbox = write(
    join(dir, "mail", "Inbox.mbox"),
    m("one@mail.example.test", "first") + m(null, "no id here") + m("two@mail.example.test", ">From escaped")
  );
  write(
    join(dir, "mail", "Starred.mbox"),
    m("one@mail.example.test", "first again") + m("three@mail.example.test", "third")
  );
  const folder = dirname(inbox);

  it("posts valid message@1 events as one import, dedupes by Message-ID across files, and is idempotent", async () => {
    const p = portal();
    const first = await run(["import", "mail", folder, "--source", SRC], p.routes);
    expect(first.exitCode).toBe(0);
    expect(p.problems).toEqual([]);
    expect(p.sent.map((e) => e.id)).toEqual([
      "mid:one@mail.example.test",
      expect.stringMatching(/^fp:[0-9a-f]{40}$/),
      "mid:two@mail.example.test",
      "mid:three@mail.example.test"
    ]);
    expect(new Set(p.sent.map((e) => e.source))).toEqual(new Set([SRC]));
    expect(first.stdout).toContain("added 4");
    expect(first.stdout).toContain("1: duplicate Message-ID in this import (first copy kept)");
    const second = await run(["import", "mail", folder, "--source", SRC, "--yes"], p.routes);
    expect(second.stdout).toContain("added 0, already held 4");
  });

  it("records the batch under an import whose hash depends on the source name", async () => {
    const a = portal();
    const b = portal();
    const ra = await run(["import", "mail", inbox, "--source", SRC], a.routes);
    const rb = await run(["import", "mail", inbox, "--source", "other-mail"], b.routes);
    const sha = (r: typeof ra) => new URL(r.calls[0]!.url).searchParams.get("sha256");
    expect(sha(ra)).not.toBe(sha(rb));
  });

  it("sends nothing on a dry run", async () => {
    const p = portal();
    const result = await run(["import", "mail", folder, "--source", SRC, "--dry-run"], p.routes);
    expect(result.exitCode).toBe(0);
    expect(p.sent).toHaveLength(0);
    expect(result.stdout).toContain("dry run");
  });

  it("needs --source", async () => {
    const result = await run(["import", "mail", inbox], portal().routes);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--source");
  });

  it("fails loudly on a file that is not an mbox, naming it, and records a failed run", async () => {
    const bad = write(join(dir, "bad", "notes.mbox"), "this is not mail\n");
    const p = portal();
    const result = await run(["import", "mail", bad, "--source", SRC], p.routes);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("notes.mbox: not an mbox file: byte 0");
    expect(p.runs[0]).toMatchObject({ status: "failed" });
  });

  it("stops with the cap and the next step for an over-size message", async () => {
    const big = write(join(dir, "huge", "big.mbox"), m("big@mail.example.test", "x".repeat(2 * 1024 * 1024)));
    const result = await run(["import", "mail", big, "--source", SRC, "--max-message-mib", "1"], portal().routes);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("per-message cap of 1048576 bytes");
    expect(result.stderr).toContain("--max-message-mib");
  });

  it("with --skip-unreadable skips and names each unreadable message, and exits 0; strict is the default", async () => {
    const mixed = write(
      join(dir, "skip", "Mixed.mbox"),
      m("g1@mail.example.test", "good one") +
        m("bad@mail.example.test", "bad one", "Content-Type: text/plain; charset=x-no-such\n") +
        m("g2@mail.example.test", "good two")
    );
    const strict = await run(["import", "mail", mixed, "--source", SRC], portal().routes);
    expect(strict.exitCode).not.toBe(0);
    expect(strict.stderr).toContain("--skip-unreadable");
    const p = portal();
    const result = await run(["import", "mail", mixed, "--source", SRC, "--skip-unreadable"], p.routes);
    expect(result.exitCode).toBe(0);
    expect(p.problems).toEqual([]);
    expect(p.sent.map((e) => e.id)).toEqual(["mid:g1@mail.example.test", "mid:g2@mail.example.test"]);
    expect(result.stdout).toContain("skipped 1: unreadable message skipped (--skip-unreadable): unknown charset");
    expect(result.stdout).toMatch(/Mixed\.mbox message 2 \(byte \d+\): unknown charset "x-no-such"/);
    expect(p.runs[0]).toMatchObject({ status: "needs_review" });
  });

  it("refuses a core source that is not message@1, with the next step", async () => {
    const result = await run(["import", "mail", inbox, "--source", "rhen-watch"], portal().routes);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('"rhen-watch" is not a message@1 source');
    expect(result.stderr).toContain("Register a source");
  });

  it("warns when it cannot check that the source is message@1", async () => {
    const result = await run(["import", "mail", inbox, "--source", SRC, "--dry-run"], portal().routes);
    expect(result.stderr).toContain(`cannot check that "${SRC}" is a message@1 source`);
  });

  it("warns that --source, --self and --max-message-mib mean nothing outside the mail import", async () => {
    const result = await run(
      ["import", "fit", join(dir, "nope.json"), "--source", "x", "--self", "a@b.test"],
      portal().routes
    );
    expect(result.stderr).toContain("--source and --self are only used by 'import mail'; ignored");
  });
});
