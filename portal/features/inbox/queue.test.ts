import "@/test/example-calendar-sources";
import { describe, expect, it, vi } from "vitest";
import type { AgentProposal } from "@openrhen/contracts";
import type { CaptureItem } from "@/state/portal-state";
import { registerPortalExtension, type ExtensionQueueRow } from "@/state/portal-extensions";
import { FAKE_MAIL_SOURCE_TYPE, registerFakeMailSource } from "@/test/fake-mail-source";
import type { ImportBatchSummary } from "@/features/imports/import-queue";
import { emptyCalendarReviewCount, type CalendarReviewCount } from "@/features/calendar-sync/calendar-review-count";
import { finding, link } from "@/features/plan-map/test-fixtures";
import { buildQueue, entriesFor, oldestLabel, staleEntries, type QueueSources } from "./queue";

// The core queue only: the seam is stubbed empty, as it is in the OpenRhen export, and a stand-in mail source is registered.
vi.mock("@/state/private/index", () => ({}));
registerFakeMailSource();

const NOW = new Date("2026-10-28T02:00:00.000Z");

const context = {};

let serial = 0;
const capture = (overrides: Partial<CaptureItem> = {}): CaptureItem => ({
  id: `c${++serial}`,
  text: "Buy a gift",
  status: "pending",
  proposalType: "action",
  proposedFields: {},
  sourceType: "manual_capture",
  createdAt: "2026-10-27T01:00:00.000Z",
  ...overrides
});

const emailChange = (id: string, sourceId: string, extra: Record<string, unknown> = {}): CaptureItem =>
  capture({
    id,
    text: "One visit",
    proposalType: "email_change",
    sourceType: FAKE_MAIL_SOURCE_TYPE,
    sourceId,
    proposedFields: {
      ref: id,
      title: `Title ${id}`,
      subject: `Subject ${sourceId}`,
      fromName: "Sam Site",
      newestAt: "2026-10-27T00:00:00.000Z",
      op: "action",
      fields: { title: `Title ${id}` },
      placement: { projectId: "p1" },
      ...extra
    }
  });

const agent = (id: string, overrides: Partial<AgentProposal> = {}): AgentProposal => ({
  id,
  agent: "mail_scribe",
  kind: "entity_command",
  summary: `Summary ${id}`,
  payload: {},
  basis: "stated",
  evidence: "quote",
  targetVersions: {},
  status: "pending",
  coalesceKey: null,
  revision: 1,
  createdAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
  updatedAt: NOW.toISOString(),
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  ...overrides
});

// A row as a registered extension lists it; the queue only passes it through.
registerPortalExtension({ id: "example-sender", captureSender: (fields) => fields?.senderName as string | undefined });
registerPortalExtension({ id: "example-unrestorable", notRestorableSourceTypes: ["example"] });
const thread = (id: string, unreadCount: number): ExtensionQueueRow & { extensionId: string } => ({
  extensionId: "example",
  key: `person:${id}`,
  room: "people",
  title: `Person ${id}: Hello from ${id}`,
  meta: "From people",
  tag: unreadCount > 0 ? { label: "Unread", tone: "info" } : { label: "Read", tone: "neutral" },
  waiting: unreadCount > 0,
  data: id
});

const importBatch = (id: string): ImportBatchSummary => ({
  id,
  sourceType: "csv",
  inputKind: "task_list",
  status: "ready",
  version: 1,
  createdAt: "2026-10-27T00:00:00.000Z",
  updatedAt: "2026-10-27T00:00:00.000Z",
  filename: "tasks.csv",
  recordCount: 4,
  blockingCount: 0,
  committedAt: null
});

const calendar = (
  google: [number, string | null],
  shared: [number, string | null] = [0, null]
): CalendarReviewCount => ({
  counts: { google_calendar: google[0], example_shared: shared[0] },
  batchIds: { google_calendar: google[1], example_shared: shared[1] },
  total: google[0] + shared[0]
});

const sources = (overrides: Partial<QueueSources> = {}): QueueSources => ({
  emailItems: [],
  otherPending: [],
  agentProposals: [],
  extensionRows: [],
  calendarReview: emptyCalendarReviewCount,
  importQueue: [],
  links: [],
  findings: [],
  someday: [],
  reference: [],
  emailContext: context,
  titleOf: (_type, id) => `Title of ${id}`,
  now: NOW,
  ...overrides
});

const everything = () =>
  buildQueue(
    sources({
      // Handed in out of order on purpose: the queue must order by kind, not by input.
      reference: [capture({ id: "ref1", proposalType: "reference", status: "confirmed" })],
      someday: [capture({ id: "som1", proposalType: "someday", status: "confirmed" })],
      findings: [finding({ id: "f1" })],
      links: [link({ id: "l1" })],
      importQueue: [importBatch("held1"), importBatch("cal-batch")],
      calendarReview: calendar([2, "cal-batch"]),
      otherPending: [capture({ id: "cap1" })],
      extensionRows: [thread("t-unread", 2), thread("t-read", 0)],
      emailItems: [emailChange("e1", "s1"), emailChange("e2", "s2")],
      agentProposals: [agent("a1")]
    })
  );

describe("buildQueue order", () => {
  it("lists agents, emails, people, captures, calendars, held imports, links, findings, someday, reference", () => {
    expect(everything().map((entry) => entry.key)).toEqual([
      "agent:a1",
      "email:s1",
      "email:s2",
      "person:t-unread",
      "person:t-read",
      "capture:cap1",
      "calendar:google_calendar",
      "import:held1",
      "link:l1",
      "finding:f1",
      "kept:som1",
      "kept:ref1"
    ]);
  });

  it("is empty when nothing waits", () => {
    expect(buildQueue(sources())).toEqual([]);
  });

  it("only lists agent proposals that are still pending", () => {
    const queue = buildQueue(
      sources({
        agentProposals: [agent("a1"), agent("a2", { status: "confirmed" }), agent("a3", { status: "rejected" })]
      })
    );
    expect(queue.map((entry) => entry.key)).toEqual(["agent:a1"]);
  });

  it("groups email changes into one entry per sourceId, at the position of the thread's first change", () => {
    const queue = buildQueue(
      sources({ emailItems: [emailChange("e1", "s1"), emailChange("e2", "s2"), emailChange("e3", "s1")] })
    );
    expect(queue.map((entry) => entry.key)).toEqual(["email:s1", "email:s2"]);
    const first = queue[0]!;
    expect(first.kind === "email" && first.items.map((item) => item.id)).toEqual(["e1", "e3"]);
  });

  it("keeps captures in the order they arrived in", () => {
    const queue = buildQueue(
      sources({ otherPending: [capture({ id: "x" }), capture({ id: "y" }), capture({ id: "z" })] })
    );
    expect(queue.map((entry) => entry.key)).toEqual(["capture:x", "capture:y", "capture:z"]);
  });

  it("lists an extension's rows in the order it gives, as extension entries", () => {
    const queue = buildQueue(sources({ extensionRows: [thread("u1", 1), thread("r1", 0)] }));
    expect(queue.map((entry) => [entry.key, entry.kind])).toEqual([
      ["person:u1", "extension"],
      ["person:r1", "extension"]
    ]);
  });

  it("lists only suggested links and open findings", () => {
    const queue = buildQueue(
      sources({
        links: [link({ id: "l1" }), link({ id: "l2", status: "confirmed" }), link({ id: "l3", status: "rejected" })],
        findings: [
          finding({ id: "f1" }),
          finding({ id: "f2", status: "accepted" }),
          finding({ id: "f3", status: "dismissed" })
        ]
      })
    );
    expect(queue.map((entry) => entry.key)).toEqual(["link:l1", "finding:f1"]);
  });
});

describe("calendar and held import entries", () => {
  it("lists a calendar provider only with a batch id and a positive count", () => {
    const queue = buildQueue(sources({ calendarReview: calendar([3, "g-batch"], [0, "s-batch"]) }));
    expect(queue.map((entry) => entry.key)).toEqual(["calendar:google_calendar"]);
    const none = buildQueue(sources({ calendarReview: calendar([4, null], [2, null]) }));
    expect(none).toEqual([]);
  });

  it("titles a calendar by provider and event count and opens its batch", () => {
    const [google, shared] = buildQueue(sources({ calendarReview: calendar([1, "g-batch"], [5, "s-batch"]) }));
    expect(google).toMatchObject({ kind: "calendar", batchId: "g-batch", count: 1, room: "calendar", waiting: true });
    expect(google!.title).toBe("Google Calendar: 1 event to review");
    expect(shared).toMatchObject({
      kind: "calendar",
      batchId: "s-batch",
      count: 5,
      key: "calendar:example_shared"
    });
    expect(shared!.title).toBe("Example Shared: 5 events to review");
  });

  it("does not list a held import twice when a calendar already opens it", () => {
    const queue = buildQueue(
      sources({
        calendarReview: calendar([2, "cal-batch"]),
        importQueue: [importBatch("cal-batch"), importBatch("held1")]
      })
    );
    expect(queue.map((entry) => entry.key)).toEqual(["calendar:google_calendar", "import:held1"]);
  });

  it("files a held import under Calendar but does not count it as waiting", () => {
    const [held] = buildQueue(sources({ importQueue: [importBatch("held1")] }));
    expect(held).toMatchObject({ kind: "import", room: "calendar", waiting: false, key: "import:held1" });
    expect(held!.title).toBe("CSV · tasks.csv");
    expect(held!.meta.startsWith("Held import")).toBe(true);
    expect(held!.tag).toEqual({ label: "Held import", tone: "neutral" });
  });
});

describe("waiting", () => {
  it("marks read extension rows, held imports and kept items as not waiting, and the rest as waiting", () => {
    const waiting = Object.fromEntries(everything().map((entry) => [entry.key, entry.waiting]));
    expect(waiting).toEqual({
      "agent:a1": true,
      "email:s1": true,
      "email:s2": true,
      "person:t-unread": true,
      "person:t-read": false,
      "capture:cap1": true,
      "calendar:google_calendar": true,
      "import:held1": false,
      "link:l1": true,
      "finding:f1": true,
      "kept:som1": false,
      "kept:ref1": false
    });
  });
});

describe("entriesFor", () => {
  it("returns only the waiting entries for all, in queue order", () => {
    const keys = entriesFor(everything(), "all").map((entry) => entry.key);
    expect(keys).toEqual([
      "agent:a1",
      "email:s1",
      "email:s2",
      "person:t-unread",
      "capture:cap1",
      "calendar:google_calendar",
      "link:l1",
      "finding:f1"
    ]);
  });

  it("returns all of one room's entries, including those that are not waiting", () => {
    const queue = everything();
    expect(entriesFor(queue, "people").map((entry) => entry.key)).toEqual(["person:t-unread", "person:t-read"]);
    expect(entriesFor(queue, "calendar").map((entry) => entry.key)).toEqual([
      "calendar:google_calendar",
      "import:held1"
    ]);
    expect(entriesFor(queue, "kept").map((entry) => entry.key)).toEqual(["kept:som1", "kept:ref1"]);
    expect(entriesFor(queue, "emails").map((entry) => entry.key)).toEqual(["email:s1", "email:s2"]);
    expect(entriesFor(queue, "map").map((entry) => entry.key)).toEqual(["link:l1", "finding:f1"]);
  });

  it("files agent proposals and captures under Captured", () => {
    expect(entriesFor(everything(), "captured").map((entry) => entry.key)).toEqual(["agent:a1", "capture:cap1"]);
  });

  it("is empty for a room with nothing in it", () => {
    expect(entriesFor(buildQueue(sources()), "all")).toEqual([]);
    expect(entriesFor(buildQueue(sources()), "kept")).toEqual([]);
  });
});

describe("entry rows", () => {
  it("describes an agent proposal", () => {
    const [entry] = buildQueue(sources({ agentProposals: [agent("a1")] }));
    expect(entry).toMatchObject({
      kind: "agent",
      room: "captured",
      title: "Summary a1",
      tag: { label: "From an agent", tone: "info" }
    });
    expect(entry!.meta).toBe("From Mail scribe · 3 h ago");
  });

  it("titles an email by the registered mail source's row, in the Emails room", () => {
    const [one] = buildQueue(sources({ emailItems: [emailChange("e1", "s1")] }));
    expect(one!.title).toBe("Title e1");
    expect(one!.room).toBe("emails");
    const [several] = buildQueue(sources({ emailItems: [emailChange("e1", "s1"), emailChange("e2", "s1")] }));
    expect(several!.title).toBe("Subject s1");
  });

  it("tags a capture by what it would become, or as a question while one is open", () => {
    const [plain, asking] = buildQueue(
      sources({
        otherPending: [
          capture({ id: "p", proposalType: "fixed_commitment" }),
          capture({ id: "q", questions: [{ field: "title", question: "What is it called?" }] })
        ]
      })
    );
    expect(plain!.tag).toEqual({ label: "Fixed commitment", tone: "neutral" });
    expect(asking!.tag).toEqual({ label: "Question", tone: "warn" });
  });

  it("titles a capture by its proposed title, else its text, and names who it is from", () => {
    const [titled, bare, fromPerson] = buildQueue(
      sources({
        otherPending: [
          capture({ id: "a", proposedFields: { title: "Book the venue" } }),
          capture({ id: "b" }),
          capture({ id: "c", proposedFields: { senderName: "Nan" } })
        ]
      })
    );
    expect(titled!.title).toBe("Book the venue");
    expect(bare!.title).toBe("Buy a gift");
    expect(bare!.meta.startsWith("Manual capture · ")).toBe(true);
    expect(fromPerson!.meta.startsWith("From Nan · ")).toBe(true);
  });

  it("reads a capture's and a kept item's time in the plan's zone, not the browser's", () => {
    // 13:37 UTC is 9:37 am in New York (EDT), whatever zone the browser is in.
    const createdAt = "2026-10-27T13:37:00.000Z";
    const queue = buildQueue(
      sources({
        timezone: "America/New_York",
        otherPending: [capture({ id: "zoned", createdAt })],
        someday: [
          capture({ id: "kept", proposalType: "someday", status: "confirmed", createdAt: "2026-10-28T03:30:00.000Z" })
        ]
      })
    );
    expect(queue.find((entry) => entry.key === "capture:zoned")!.meta).toBe("Manual capture · 27 Oct, 9:37 am");
    // 03:30 UTC on the 28th is still the evening of the 27th in New York.
    expect(queue.find((entry) => entry.key === "kept:kept")!.meta).toBe("Manual capture · filed 27 Oct");
  });

  it("titles a suggested link by both ends and the proposer", () => {
    const [entry] = buildQueue(
      sources({ links: [link({ id: "l1", fromId: "a1", toId: "maths", proposer: "rule:keywords" })] })
    );
    expect(entry).toMatchObject({ room: "map", tag: { label: "Suggested link", tone: "neutral" } });
    expect(entry!.title).toContain("Title of a1");
    expect(entry!.title).toContain("Title of maths");
    expect(entry!.meta).toBe("Links · suggested by Rule:keywords");
  });

  it("tags a finding as a question when it asks one and as worth a look otherwise", () => {
    const [plain, asking] = buildQueue(
      sources({
        findings: [
          finding({ id: "f1" }),
          finding({ id: "f2", questions: [{ field: "subject", question: "Which subject?" }] })
        ]
      })
    );
    expect(plain!.tag).toEqual({ label: "Worth a look", tone: "neutral" });
    expect(plain!.title).toBe("Nothing prepares the exam.");
    expect(plain!.meta.startsWith("Links · ")).toBe(true);
    expect(asking!.tag).toEqual({ label: "Question", tone: "warn" });
  });

  it("tags kept items by their shelf", () => {
    const [someday, reference] = buildQueue(
      sources({
        someday: [
          capture({ id: "s", proposalType: "someday", status: "confirmed", proposedFields: { title: "Learn to sail" } })
        ],
        reference: [capture({ id: "r", proposalType: "reference", status: "confirmed" })]
      })
    );
    expect(someday).toMatchObject({ kind: "kept", shelf: "someday", title: "Learn to sail", room: "kept" });
    expect(someday!.tag).toEqual({ label: "Someday", tone: "neutral" });
    expect(reference).toMatchObject({ shelf: "reference", tag: { label: "Reference", tone: "neutral" } });
  });
});

describe("keys", () => {
  it("are stable: the same sources give the same keys, whatever else is in the queue", () => {
    const alone = buildQueue(sources({ otherPending: [capture({ id: "cap1" })] }));
    const crowded = buildQueue(
      sources({ otherPending: [capture({ id: "cap1" })], agentProposals: [agent("a1")], links: [link({ id: "l1" })] })
    );
    expect(alone[0]!.key).toBe("capture:cap1");
    expect(crowded.find((entry) => entry.kind === "capture")!.key).toBe("capture:cap1");
  });

  it("are unique across the whole queue", () => {
    const keys = everything().map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the backlog", () => {
  const old = "2026-09-10T00:00:00.000Z";
  const sourcesOf = sources;
  const build = (over: Partial<QueueSources>) => buildQueue(sourcesOf(over));

  it("sweeps emails and captures that arrived over two weeks ago, never newer ones or ones that cannot be put back", () => {
    const queue = build({
      otherPending: [
        capture({ id: "old", createdAt: old }),
        capture({ id: "new", createdAt: "2026-10-20T00:00:00.000Z" }),
        capture({ id: "person", createdAt: old, sourceType: "example" })
      ],
      emailItems: [emailChange("e1", "t1", {}), { ...emailChange("e2", "t2", { newestAt: old }), createdAt: old }]
    });
    const keys = staleEntries(queue, NOW).map((entry) => entry.key);
    expect(keys).toEqual(["email:t2", "capture:old"]);
  });

  it("ages an email thread by its newest message, not by when it was first imported", () => {
    const refreshed = { ...emailChange("e3", "t3", { newestAt: "2026-10-27T00:00:00.000Z" }), createdAt: old };
    const stale = { ...emailChange("e4", "t4", { newestAt: old }), createdAt: old };
    const queue = build({ emailItems: [refreshed, stale] });
    expect(staleEntries(queue, NOW).map((entry) => entry.key)).toEqual(["email:t4"]);
    expect(
      oldestLabel(
        queue.filter((entry) => entry.key === "email:t3"),
        NOW
      )
    ).toBeNull();
  });

  it("names the oldest wait in weeks, and says nothing under a week", () => {
    const queue = build({
      otherPending: [capture({ createdAt: old }), capture({ createdAt: "2026-10-27T00:00:00Z" })]
    });
    expect(oldestLabel(queue, NOW)).toBe("oldest: 6 weeks");
    expect(oldestLabel(build({ otherPending: [capture()] }), NOW)).toBeNull();
    expect(oldestLabel([], NOW)).toBeNull();
  });
});
