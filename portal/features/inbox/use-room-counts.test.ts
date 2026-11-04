import { describe, expect, it, vi } from "vitest";
import type { CaptureItem } from "@/state/portal-state";
import { FAKE_MAIL_SOURCE_TYPE, registerFakeMailSource } from "@/test/fake-mail-source";
import { countRooms } from "./use-room-counts";

// The core Inbox only: the seam is stubbed empty, as it is in the OpenRhen export, and a stand-in mail source is registered.
vi.mock("@/state/private/index", () => ({}));
registerFakeMailSource();

let serial = 0;
const capture = (overrides: Partial<CaptureItem> = {}): CaptureItem => ({
  id: `c${++serial}`,
  text: "A thought",
  status: "pending",
  proposalType: "action",
  proposedFields: {},
  sourceType: "manual",
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides
});

const change = (sourceId: string, overrides: Partial<CaptureItem> = {}) =>
  capture({ proposalType: "email_change", sourceType: FAKE_MAIL_SOURCE_TYPE, sourceId, ...overrides });

const none = { peopleUnread: 0, agentPending: 0, calendar: 0, map: 0 };

describe("countRooms", () => {
  it.each([
    ["nothing at all", [], {}, { emails: 0, captured: 0, kept: 0 }],
    ["two changes in one thread are one email", [change("t1"), change("t1")], {}, { emails: 1, captured: 0, kept: 0 }],
    ["each thread is an email", [change("t1"), change("t1"), change("t2")], {}, { emails: 2, captured: 0, kept: 0 }],
    ["other pending items are captured", [capture(), capture()], {}, { emails: 0, captured: 2, kept: 0 }],
    ["agent proposals add to captured", [capture()], { agentPending: 3 }, { emails: 0, captured: 4, kept: 0 }],
    [
      "an email change from a source the mail source does not claim is not a thread card",
      [capture({ proposalType: "email_change", sourceType: "other", sourceId: "g1" })],
      {},
      { emails: 0, captured: 1, kept: 0 }
    ],
    [
      "superseded, ignored and confirmed items are not counted",
      [
        change("t1", { status: "superseded" }),
        change("t1", { status: "confirmed" }),
        capture({ status: "ignored" }),
        capture({ status: "superseded" }),
        capture({ status: "confirmed", proposalType: "action" })
      ],
      {},
      { emails: 0, captured: 0, kept: 0 }
    ],
    [
      "confirmed Someday and Reference items are kept, not waiting",
      [
        capture({ status: "confirmed", proposalType: "someday" }),
        capture({ status: "confirmed", proposalType: "reference" }),
        capture({ status: "pending", proposalType: "someday" })
      ],
      {},
      { emails: 0, captured: 1, kept: 2 }
    ]
  ] as const)("%s", (_name, captures, extra, expected) => {
    expect(countRooms({ ...none, ...extra, captures })).toMatchObject(expected);
  });

  it("passes people, calendar and map through", () => {
    expect(countRooms({ captures: [], peopleUnread: 4, agentPending: 0, calendar: 5, map: 6 })).toEqual({
      emails: 0,
      people: 4,
      captured: 0,
      calendar: 5,
      map: 6,
      kept: 0
    });
  });
});
