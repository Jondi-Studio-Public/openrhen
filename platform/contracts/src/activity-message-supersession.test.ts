import { describe, expect, it } from "vitest";
import {
  findThinReplacements,
  matchedMessageId,
  type HeldMessageRef,
  type ThinReplacementProbe
} from "./activity-message-dedupe.js";

const T = Date.parse("2026-11-09T10:00:00Z");
const at = (seconds: number) => new Date(T + seconds * 1000);
const ID = "abc@mail.example.com";

const incoming = (
  index: number,
  source: string,
  key: string,
  role: ThinReplacementProbe["role"],
  seconds: number,
  attrs: Record<string, unknown>
): ThinReplacementProbe => ({ index, source, key, role, tsStart: at(seconds), attrs });

/** A held row; `thin` and `viaImport` default to the plain gate-on live copy. */
const held = (
  id: string,
  source: string,
  key: string,
  seconds: number,
  extra: Partial<HeldMessageRef> = {}
): HeldMessageRef => ({
  id,
  source,
  key,
  tsStart: at(seconds),
  fp: null,
  thin: false,
  viaImport: false,
  family: true,
  messageId: null,
  ...extra
});

describe("matchedMessageId", () => {
  it("normalises an unnormalised raw id and refuses ids that are not globally unique", () => {
    expect(matchedMessageId({ key: "k", attrs: { message_id: " <Abc@Mail.EXAMPLE.com> " } })).toBe(
      "Abc@mail.example.com"
    );
    expect(matchedMessageId({ key: "mid:abc@host.example", attrs: {} })).toBe("abc@host.example");
    expect(matchedMessageId({ key: "k", attrs: { message_id: "12" } })).toBeUndefined();
    expect(matchedMessageId({ key: "mid:@alice-17", attrs: { message_id: "@alice-17" } })).toBeUndefined();
    expect(matchedMessageId({ key: "k", attrs: {} })).toBeUndefined();
  });
});

describe("findThinReplacements, an import replacing a thin copy", () => {
  const thinHeld = held("t1", "inbox", "sha-1", 0, { thin: true, messageId: ID, family: false });

  it("links an import row to a thin row of another source with the same message id", () => {
    const out = findThinReplacements(
      [incoming(2, "archive", `mid:${ID}`, "superseder", 5, { message_id: ID })],
      [thinHeld]
    );
    expect(out).toEqual([
      {
        index: 2,
        source: "archive",
        key: `mid:${ID}`,
        role: "replaces",
        other: { source: "inbox", key: "sha-1", id: "t1" },
        by: "message_id"
      }
    ]);
  });

  it("matches a raw, bracketed, mixed-case id held in the mail source against a canonical mid: key", () => {
    const out = findThinReplacements(
      [incoming(0, "archive", `mid:${ID}`, "superseder", 0, { message_id: ID })],
      [held("t1", "inbox", "sha-1", 0, { thin: true, family: false, messageId: ID })]
    );
    expect(out).toHaveLength(1);
    // The same id arriving in a held ref that only has the key still matches.
    const viaKey = findThinReplacements(
      [incoming(0, "archive", "fp:x", "superseder", 0, { message_id: "<abc@Mail.Example.Com>" })],
      [held("t2", "inbox", `mid:${ID}`, 0, { thin: true, family: true })]
    );
    expect(viaKey).toHaveLength(1);
  });

  it("matches by fingerprint within 60 seconds, not beyond, and only against a family row", () => {
    const fpThin = held("t3", "paste", "fp:1", 0, { thin: true, fp: "f1" });
    const near = findThinReplacements([incoming(0, "archive", "fp:2", "superseder", 60, { fp: "f1" })], [fpThin]);
    expect(near).toMatchObject([{ by: "fingerprint", other: { id: "t3" } }]);
    expect(findThinReplacements([incoming(0, "archive", "fp:2", "superseder", 61, { fp: "f1" })], [fpThin])).toEqual(
      []
    );
    expect(findThinReplacements([incoming(0, "archive", "fp:2", "superseder", 0, { fp: "f2" })], [fpThin])).toEqual([]);
  });

  it("prefers the message id over the fingerprint when both match", () => {
    const both = held("t4", "inbox", "sha-4", 0, { thin: true, fp: "f1", messageId: ID });
    const out = findThinReplacements(
      [incoming(0, "archive", `mid:${ID}`, "superseder", 0, { message_id: ID, fp: "f1" })],
      [both]
    );
    expect(out[0]!.by).toBe("message_id");
  });

  it("never matches a row of the same source, a bare chat id, or a row that is not thin", () => {
    const probe = incoming(0, "archive", `mid:${ID}`, "superseder", 0, { message_id: ID });
    expect(findThinReplacements([probe], [held("t5", "archive", "sha-5", 0, { thin: true, messageId: ID })])).toEqual(
      []
    );
    expect(
      findThinReplacements(
        [incoming(0, "archive", "mid:12", "superseder", 0, { message_id: "12" })],
        [held("t6", "inbox", "mid:12", 0, { thin: true, messageId: "12" })]
      )
    ).toEqual([]);
  });

  it("leaves B2 in charge when a visible non-thin family copy also matches, even if a thin one does too", () => {
    const probe = incoming(0, "archive", `mid:${ID}`, "superseder", 0, { message_id: ID });
    const text = held("v1", "paste", `mid:${ID}`, 0, { messageId: ID });
    expect(findThinReplacements([probe], [thinHeld, text])).toEqual([]);
  });

  it("ignores a non-thin row outside the family (a gate-on mail row is never compared) and still links the thin one", () => {
    const probe = incoming(0, "archive", `mid:${ID}`, "superseder", 0, { message_id: ID });
    const gateOn = held("v2", "inbox2", "sha-9", 0, { messageId: ID, family: false });
    expect(findThinReplacements([probe], [gateOn, thinHeld]).map((r) => r.other.id)).toEqual(["t1"]);
    expect(findThinReplacements([probe], [gateOn])).toEqual([]);
  });

  it("links every thin match of one import row, oldest first", () => {
    const probe = incoming(0, "archive", `mid:${ID}`, "superseder", 0, { message_id: ID });
    const later = held("t8", "other-inbox", "sha-8", 30, { thin: true, messageId: ID, family: false });
    const out = findThinReplacements([probe], [later, thinHeld]);
    expect(out.map((r) => r.other.id)).toEqual(["t1", "t8"]);
    expect(out.every((r) => r.index === 0 && r.role === "replaces")).toBe(true);
  });

  it("answers per event in batch order, and lets two import events of one source both link the same thin row", () => {
    const out = findThinReplacements(
      [
        incoming(4, "archive", `mid:${ID}`, "superseder", 0, { message_id: ID }),
        incoming(5, "archive", "fp:other", "superseder", 1, { message_id: ID })
      ],
      [thinHeld]
    );
    expect(out.map((r) => [r.index, r.other.id])).toEqual([
      [4, "t1"],
      [5, "t1"]
    ]);
  });
});

describe("findThinReplacements, a thin row arriving after the import", () => {
  const importHeld = held("i1", "archive", `mid:${ID}`, 0, { viaImport: true, messageId: ID });
  const thinIn = incoming(1, "inbox", "sha-1", "thin", 0, { message_id: "<abc@Mail.EXAMPLE.com>" });

  it("links the new thin row to the import copy that holds the text", () => {
    expect(findThinReplacements([thinIn], [importHeld])).toEqual([
      {
        index: 1,
        source: "inbox",
        key: "sha-1",
        role: "replaced_by",
        other: { source: "archive", key: `mid:${ID}`, id: "i1" },
        by: "message_id"
      }
    ]);
  });

  it("ignores a live text copy, a thin row, a same-source row, a non-shareable id and a fingerprint", () => {
    expect(findThinReplacements([thinIn], [held("l1", "paste", `mid:${ID}`, 0, { messageId: ID })])).toEqual([]);
    expect(
      findThinReplacements([thinIn], [held("l2", "archive", "k", 0, { viaImport: true, thin: true, messageId: ID })])
    ).toEqual([]);
    expect(findThinReplacements([thinIn], [held("l3", "inbox", "k", 0, { viaImport: true, messageId: ID })])).toEqual(
      []
    );
    expect(
      findThinReplacements(
        [incoming(1, "inbox", "sha-2", "thin", 0, { message_id: "12" })],
        [held("l4", "archive", "mid:12", 0, { viaImport: true, messageId: "12" })]
      )
    ).toEqual([]);
    expect(
      findThinReplacements(
        [incoming(1, "inbox", "sha-3", "thin", 0, { fp: "f1" })],
        [held("l5", "archive", "fp:1", 0, { viaImport: true, fp: "f1" })]
      )
    ).toEqual([]);
  });

  it("links to exactly one import copy, the oldest, so a row has one superseder", () => {
    const newer = held("i0", "archive-2", "mid:x", 50, { viaImport: true, messageId: ID });
    expect(findThinReplacements([thinIn], [newer, importHeld]).map((r) => r.other.id)).toEqual(["i1"]);
  });
});

describe("findThinReplacements, two identical short messages", () => {
  const first = held("t1", "inbox", "fp:a", -20, { thin: true, fp: "ok", family: true });
  const second = held("t2", "inbox", "fp:b", 40, { thin: true, fp: "ok", family: true });
  const probe = (index: number, key: string, seconds: number) =>
    incoming(index, "archive", key, "superseder", seconds, { fp: "ok" });

  it("covers only the thin row nearest in time to the import row, not every row with the fingerprint", () => {
    const out = findThinReplacements([probe(0, "fp:i", 5)], [second, first]);
    expect(out.map((r) => [r.other.id, r.by])).toEqual([["t1", "fingerprint"]]);
    expect(findThinReplacements([probe(0, "fp:i", 30)], [first, second]).map((r) => r.other.id)).toEqual(["t2"]);
  });

  it("breaks a tie by the older row, then the key", () => {
    const a = held("t3", "inbox", "fp:c", -10, { thin: true, fp: "ok" });
    const b = held("t4", "inbox", "fp:d", 10, { thin: true, fp: "ok" });
    expect(findThinReplacements([probe(0, "fp:i", 0)], [b, a]).map((r) => r.other.id)).toEqual(["t3"]);
  });

  it("covers one thin row per import row when the import holds both messages", () => {
    const out = findThinReplacements([probe(0, "fp:i", -19), probe(1, "fp:j", 41)], [first, second]);
    expect(out.map((r) => [r.index, r.other.id])).toEqual([
      [0, "t1"],
      [1, "t2"]
    ]);
  });

  it("still covers every thin row of one message id", () => {
    const a = held("m1", "inbox", "x", 0, { thin: true, messageId: ID, family: false });
    const b = held("m2", "inbox-2", "y", 0, { thin: true, messageId: ID, family: false });
    const out = findThinReplacements(
      [incoming(0, "archive", `mid:${ID}`, "superseder", 0, { message_id: ID })],
      [a, b]
    );
    expect(out.map((r) => r.other.id).sort()).toEqual(["m1", "m2"]);
  });
});
