import "@/test/example-calendar-sources";
import { describe, expect, it } from "vitest";
import {
  agentChangesSince,
  agentChangesUnseen,
  awayMs,
  awaySince,
  showWelcomeBack,
  welcomeBackRows
} from "./welcome-back";

const none = { catchUp: 0, needs: 0, agentChanges: 0, inbox: 0 };

describe("welcomeBackRows", () => {
  it("is empty when nothing is waiting", () => {
    expect(welcomeBackRows(none)).toEqual([]);
  });

  it("words each row with its count and links to where it lives", () => {
    expect(welcomeBackRows({ catchUp: 3, needs: 0, agentChanges: 2, inbox: 5 })).toEqual([
      { key: "catch-up", count: 3, label: "3 things to settle", href: "/catch-up" },
      {
        key: "agent-changes",
        count: 2,
        label: "2 changes by agents while you were away",
        href: "/review#agent-changes"
      },
      { key: "inbox", count: 5, label: "5 waiting in Inbox", href: "/inbox" }
    ]);
  });

  it("puts a lapsed connection first and links to Connections", () => {
    expect(
      welcomeBackRows({ ...none, inbox: 2, lapsedConnections: ["Example Daily roster hasn't synced since 19 Oct"] })
    ).toEqual([
      { key: "connections", count: 1, label: "Example Daily roster hasn't synced since 19 Oct", href: "/connections" },
      { key: "inbox", count: 2, label: "2 waiting in Inbox", href: "/inbox" }
    ]);
    expect(welcomeBackRows({ ...none, lapsedConnections: ["a", "b"] })[0]?.label).toBe("2 connections need attention");
  });

  it("uses the singular for one", () => {
    const labels = welcomeBackRows({ catchUp: 1, needs: 1, agentChanges: 1, inbox: 1 }).map((row) => row.label);
    expect(labels).toEqual([
      "1 thing to settle",
      "1 thing the plan needs to know",
      "1 change by an agent while you were away",
      "1 waiting in Inbox"
    ]);
  });

  it("leaves the needs row out while there are none", () => {
    expect(welcomeBackRows({ ...none, inbox: 2 }).map((row) => row.key)).toEqual(["inbox"]);
  });
});

describe("agentChangesSince", () => {
  const changes = [
    { at: "2026-10-20T00:00:00.000Z", status: "applied" as const },
    { at: "2026-10-26T00:00:00.000Z", status: "applied" as const },
    { at: "2026-10-27T00:00:00.000Z", status: "undone" as const },
    { at: "2026-10-27T12:00:00.000Z", status: "applied" as const }
  ];

  it("counts applied writes after the last seen time", () => {
    expect(agentChangesSince(changes, "2026-10-25T00:00:00.000Z")).toBe(2);
  });

  it("counts nothing without a usable last seen time", () => {
    expect(agentChangesSince(changes, null)).toBe(0);
    expect(agentChangesSince(changes, "not a date")).toBe(0);
  });

  it("counts every applied write as unseen when the list was never looked at", () => {
    expect(agentChangesUnseen(changes, "2026-10-25T00:00:00.000Z")).toBe(2);
    expect(agentChangesUnseen(changes, null)).toBe(3);
  });
});

describe("awayMs", () => {
  const now = new Date("2026-10-28T00:00:00.000Z");
  it("is the time since, or null when unknown", () => {
    expect(awayMs("2026-10-27T00:00:00.000Z", now)).toBe(86_400_000);
    expect(awayMs(null, now)).toBeNull();
    expect(awayMs("nope", now)).toBeNull();
  });
});

describe("showWelcomeBack", () => {
  const now = new Date("2026-10-28T00:00:00.000Z");
  const rows = welcomeBackRows({ ...none, inbox: 4 });
  const base = {
    catchUpDue: false,
    catchUpSince: null,
    rows,
    lastSeenAt: "2026-10-25T00:00:00.000Z",
    now,
    afterHours: 36
  };

  it("shows whenever a catch-up is due", () => {
    expect(showWelcomeBack({ ...base, catchUpDue: true, rows: [], lastSeenAt: null })).toBe(true);
  });

  it("shows for waiting things after a long enough absence", () => {
    expect(showWelcomeBack(base)).toBe(true);
  });

  it("stays hidden after a short absence", () => {
    expect(showWelcomeBack({ ...base, lastSeenAt: "2026-10-27T00:00:00.000Z" })).toBe(false);
  });

  it("stays hidden when nothing is waiting", () => {
    expect(showWelcomeBack({ ...base, rows: [] })).toBe(false);
  });

  it("stays hidden on a first visit with nothing due", () => {
    expect(showWelcomeBack({ ...base, lastSeenAt: null })).toBe(false);
  });

  it("hides a due catch-up once Not now marks it seen after the window opened", () => {
    const due = { ...base, catchUpDue: true, catchUpSince: "2026-10-25T12:00:00.000Z" };
    expect(showWelcomeBack({ ...due, lastSeenAt: "2026-10-24T00:00:00.000Z" })).toBe(true);
    expect(showWelcomeBack({ ...due, lastSeenAt: now.toISOString() })).toBe(false);
  });

  it("shows a due catch-up again after another long absence", () => {
    const due = { ...base, catchUpDue: true, catchUpSince: "2026-10-20T00:00:00.000Z" };
    expect(showWelcomeBack({ ...due, rows: welcomeBackRows({ ...none, catchUp: 2 }) })).toBe(true);
  });
});

describe("awaySince", () => {
  it("takes the later of last seen and the last recorded time", () => {
    expect(awaySince("2026-10-20T00:00:00.000Z", "2026-10-25T00:00:00.000Z")).toBe("2026-10-25T00:00:00.000Z");
    expect(awaySince("2026-10-26T00:00:00.000Z", "2026-10-25T00:00:00.000Z")).toBe("2026-10-26T00:00:00.000Z");
  });

  it("falls back to whichever is known", () => {
    expect(awaySince(null, "2026-10-25T00:00:00.000Z")).toBe("2026-10-25T00:00:00.000Z");
    expect(awaySince(null, null)).toBeNull();
  });
});
