import { describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../client.js";
import type { CommandContext } from "../command.js";
import { EXIT } from "../errors.js";
import type { JournalEntry } from "../undo-journal.js";
import { recordCommandModule } from "../command-modules.js";
import { inboxActCommand } from "./inbox-act.js";

// The mail add-on's Emails room is what makes inbox-act point at `email-act`; this file stands one in. The build
// without it is covered by inbox-mail-hints.test.ts.
recordCommandModule({
  id: "mail-room-stand-in",
  commands: [],
  inboxRooms: [{ id: "emails", label: "Emails", about: "Emails (threads)", load: async () => [] }]
});

const AREA = "area-1";
const PROJECT = "project-1";

function capture(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    version: 2,
    status: "pending",
    proposalType: "unclassified",
    text: "Fix the gate",
    sourceType: "manual_capture",
    proposedFields: { text: "Fix the gate" },
    ...extra
  };
}

function context(captures: unknown[], opts: { post?: ReturnType<typeof vi.fn>; get?: ReturnType<typeof vi.fn> } = {}) {
  const stdout: string[] = [];
  const post = (opts.post ?? vi.fn().mockResolvedValue({ state: {} })) as unknown as PortalClient["post"];
  const get = (opts.get ?? vi.fn()) as unknown as PortalClient["get"];
  const client: PortalClient = {
    baseUrl: "http://localhost:8787",
    getState: vi.fn().mockResolvedValue({
      captures,
      areas: [{ id: AREA, name: "Home" }],
      outcomes: [],
      projects: [{ id: PROJECT, title: "Garden" }]
    }),
    get,
    post
  };
  const ctx: CommandContext = {
    client,
    mode: "json",
    now: () => new Date("2026-10-05T00:00:00Z"),
    stdout: (text) => stdout.push(text),
    stderr: () => {},
    setExitCode: () => {}
  };
  return { ctx, stdout, post: post as unknown as ReturnType<typeof vi.fn>, get };
}

const run = (ctx: CommandContext, positionals: string[], values: Record<string, unknown> = {}) =>
  inboxActCommand.run(ctx, { positionals, values: values as never });

describe("inbox-act captured", () => {
  it("confirms a capture as an action with draft fields and an answered question", async () => {
    const { ctx, post } = context([capture("c1", { questions: [{ field: "projectId", question: "Which project?" }] })]);
    await run(ctx, ["captured", "confirm", "c1"], {
      type: "action",
      set: ["title=Fix the gate", "expectedMinutes=20", "pessimisticMinutes=40"],
      answer: ["projectId=Garden"]
    });
    const [path, payload] = post.mock.calls[0]!;
    expect(path).toBe("/api/commands/entity");
    expect(payload).toMatchObject({
      expectedVersion: 2,
      entityType: "capture_review",
      entity: {
        id: "c1",
        proposalType: "action",
        draft: { proposalType: "action", title: "Fix the gate", projectId: PROJECT, expectedMinutes: 20 },
        answers: { projectId: PROJECT }
      }
    });
  });

  it("journals a confirm the portal snapshotted, so undo can revert it, and journals nothing for an ignore", async () => {
    const post = vi.fn().mockResolvedValue({ state: {}, revertible: "cmd-confirm-1" });
    const { ctx } = context([capture("c1"), capture("c2")], { post });
    const entries: JournalEntry[] = [];
    ctx.journal = { read: () => entries, write: (next) => entries.splice(0, entries.length, ...next) };
    await run(ctx, ["captured", "confirm", "c1"], { type: "someday" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      serverChecked: true,
      status: "applied",
      undo: { path: "/api/commands/revert", payload: { direction: "undo", target: "cmd-confirm-1" } },
      redo: { path: "/api/commands/revert", payload: { direction: "redo", target: "cmd-confirm-1" } }
    });
    // An answer that names nothing revertible (the portal kept no rows) is not journaled.
    post.mockResolvedValueOnce({ state: {} });
    await run(ctx, ["captured", "ignore", "c2"]);
    expect(entries).toHaveLength(1);
  });

  it("records nothing when the portal did not snapshot the confirm (the answer names nothing revertible)", async () => {
    const { ctx } = context([capture("c1")]);
    const entries: JournalEntry[] = [];
    ctx.journal = { read: () => entries, write: (next) => entries.splice(0, entries.length, ...next) };
    await run(ctx, ["captured", "confirm", "c1"], { type: "someday" });
    expect(entries).toHaveLength(0);
  });

  it("confirms a commitment as tentative with instants", async () => {
    const { ctx, post } = context([capture("c1")]);
    await run(ctx, ["captured", "confirm", "c1"], {
      type: "fixed_commitment",
      tentative: true,
      set: ["startsAt=2026-10-09T15:00:00+10:00", "endsAt=2026-10-09T16:00:00+10:00"]
    });
    expect(post.mock.calls[0]![1]).toMatchObject({
      entity: {
        proposalType: "fixed_commitment",
        commitmentStatus: "tentative",
        draft: { startsAt: "2026-10-09T05:00:00.000Z", endsAt: "2026-10-09T06:00:00.000Z" }
      }
    });
  });

  it("files a capture as someday without answering its placement question", async () => {
    const { ctx, post } = context([capture("c1", { questions: [{ field: "projectId", question: "Which project?" }] })]);
    await run(ctx, ["captured", "confirm", "c1"], { type: "someday" });
    expect(post.mock.calls[0]![1]).toMatchObject({ entity: { proposalType: "someday" } });
  });

  it("ignores a capture", async () => {
    const { ctx, post } = context([capture("c1")]);
    await run(ctx, ["captured", "ignore", "c1"]);
    expect(post.mock.calls[0]![1]).toMatchObject({
      expectedVersion: 2,
      entityType: "capture",
      entity: { id: "c1", status: "ignored", proposalType: "unclassified", reviewedAt: "2026-10-05T00:00:00.000Z" }
    });
  });

  it("previews with --dry-run and sends nothing", async () => {
    const { ctx, post, stdout } = context([capture("c1")]);
    await run(ctx, ["captured", "ignore", "c1"], { "dry-run": true });
    expect(post).not.toHaveBeenCalled();
    expect(JSON.parse(stdout[0]!)).toMatchObject({ dryRun: true, path: "/api/commands/entity" });
  });

  it("refuses an unanswered question, an unknown id, a missing type and an email change", async () => {
    const withQuestion = capture("c1", { questions: [{ field: "projectId", question: "Which project?" }] });
    const { ctx, post } = context([withQuestion, capture("c2"), capture("c3", { proposalType: "email_change" })]);
    await expect(run(ctx, ["captured", "confirm", "c1"], { type: "action" })).rejects.toMatchObject({
      exitCode: EXIT.validation,
      message: expect.stringMatching(/open question/)
    });
    await expect(run(ctx, ["captured", "confirm", "nope"], { type: "action" })).rejects.toMatchObject({
      exitCode: EXIT.notFound
    });
    await expect(run(ctx, ["captured", "confirm", "c2"])).rejects.toMatchObject({
      exitCode: EXIT.usage,
      message: expect.stringMatching(/--type/)
    });
    await expect(run(ctx, ["captured", "ignore", "c3"])).rejects.toThrow(/email-act/);
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses a capture that is no longer pending", async () => {
    const { ctx } = context([capture("c1", { status: "ignored" })]);
    await expect(run(ctx, ["captured", "ignore", "c1"])).rejects.toMatchObject({ exitCode: EXIT.validation });
  });
});

describe("inbox-act kept", () => {
  const keptRow = capture("k1", { status: "confirmed", proposalType: "someday" });

  it("reopens and drops a kept item", async () => {
    const { ctx, post } = context([keptRow]);
    await run(ctx, ["kept", "reopen", "k1"]);
    await run(ctx, ["kept", "drop", "k1"]);
    expect(post.mock.calls[0]![1]).toMatchObject({
      entityType: "capture",
      entity: { id: "k1", status: "pending", proposalType: "someday" }
    });
    expect(post.mock.calls[1]![1]).toMatchObject({ entity: { id: "k1", status: "ignored" } });
  });

  it("refuses an item that is not kept for later", async () => {
    const { ctx, post } = context([capture("c1", { status: "confirmed", proposalType: "action" })]);
    await expect(run(ctx, ["kept", "reopen", "c1"])).rejects.toMatchObject({ exitCode: EXIT.validation });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("inbox-act map", () => {
  const map = {
    links: [
      { id: "l1", status: "suggested", kind: "about", proposer: "tga" },
      { id: "l2", status: "confirmed", kind: "about", proposer: "owner" }
    ],
    findings: [
      { id: "f1", status: "open", questions: [{ field: "why", question: "Why?" }] },
      { id: "f2", status: "dismissed" }
    ]
  };
  const get = () => vi.fn().mockResolvedValue(map);

  it("decides a link, bulk-confirms and decides a finding", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, confirmed: 1 });
    const { ctx } = context([], { post, get: get() });
    await run(ctx, ["map", "link", "l1", "confirm"]);
    await run(ctx, ["map", "link", "l2", "remove"]);
    await run(ctx, ["map", "links-bulk"], { proposer: "tga", kind: "about" });
    await run(ctx, ["map", "finding", "f1", "accept"], { answer: ["why=Because"] });
    expect(post.mock.calls).toEqual([
      ["/api/plan-map/links/l1", { action: "confirm" }],
      ["/api/plan-map/links/l2", { action: "remove" }],
      ["/api/plan-map/links/bulk", { proposer: "tga", kind: "about" }],
      ["/api/plan-map/findings/f1", { action: "accept", answers: { why: "Because" } }]
    ]);
  });

  it("refuses a decided link, nothing to bulk confirm, an unanswered finding and a closed finding", async () => {
    const { ctx, post } = context([], { get: get() });
    await expect(run(ctx, ["map", "link", "l2", "confirm"])).rejects.toMatchObject({ exitCode: EXIT.validation });
    await expect(run(ctx, ["map", "link", "nope", "confirm"])).rejects.toMatchObject({ exitCode: EXIT.notFound });
    await expect(run(ctx, ["map", "links-bulk"], { proposer: "owner", kind: "about" })).rejects.toMatchObject({
      exitCode: EXIT.notFound
    });
    await expect(run(ctx, ["map", "finding", "f1", "accept"])).rejects.toMatchObject({
      exitCode: EXIT.validation,
      message: expect.stringMatching(/open question/)
    });
    await expect(run(ctx, ["map", "finding", "f2", "dismiss"])).rejects.toMatchObject({ exitCode: EXIT.validation });
    expect(post).not.toHaveBeenCalled();
  });

  it("dismisses a finding without answers", async () => {
    const post = vi.fn().mockResolvedValue({ finding: {} });
    const { ctx } = context([], { post, get: get() });
    await run(ctx, ["map", "finding", "f1", "dismiss"]);
    expect(post.mock.calls[0]).toEqual(["/api/plan-map/findings/f1", { action: "dismiss" }]);
  });
});

describe("inbox-act rooms without actions", () => {
  it("points calendar at import and emails at email-act", async () => {
    const { ctx } = context([]);
    await expect(run(ctx, ["calendar", "x"])).rejects.toThrow(/import show/);
    await expect(run(ctx, ["emails", "confirm"])).rejects.toThrow(/email-act/);
    await expect(run(ctx, ["nowhere", "x"])).rejects.toMatchObject({ exitCode: EXIT.usage });
  });
});
