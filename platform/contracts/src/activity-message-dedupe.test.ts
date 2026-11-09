import { describe, expect, it } from "vitest";
import {
  findMessageDuplicates,
  isMessageCopyCandidate,
  type HeldMessageRef,
  type MessageCopyProbe
} from "./activity-message-dedupe.js";

const T = Date.parse("2026-11-09T10:00:00Z");
const at = (seconds: number) => new Date(T + seconds * 1000);
const probe = (
  index: number,
  source: string,
  key: string,
  seconds: number,
  attrs: Record<string, unknown>
): MessageCopyProbe => ({ index, source, key, tsStart: at(seconds), attrs });
const held = (source: string, key: string, seconds: number, fp: string | null): HeldMessageRef => ({
  source,
  key,
  tsStart: at(seconds),
  fp
});

describe("findMessageDuplicates", () => {
  it("matches the same fp from another source within 60 s, inclusive of the boundary", () => {
    for (const offset of [0, 30, -60, 60]) {
      const out = findMessageDuplicates([probe(0, "b", "fp:x", offset, { fp: "f1" })], [held("a", "mid:1@h", 0, "f1")]);
      expect(out).toEqual([
        {
          index: 0,
          source: "b",
          key: "fp:x",
          of: { source: "a", key: "mid:1@h" },
          by: "fingerprint",
          endState: "duplicate"
        }
      ]);
    }
  });

  it("keeps both when the times differ by more than 60 s, whatever the fp", () => {
    for (const offset of [60.001, -61, 3600, 7 * 86_400]) {
      expect(findMessageDuplicates([probe(0, "b", "fp:x", offset, { fp: "f1" })], [held("a", "k", 0, "f1")])).toEqual(
        []
      );
    }
  });

  it("keeps both when the fp differs", () => {
    expect(findMessageDuplicates([probe(0, "b", "fp:x", 1, { fp: "f2" })], [held("a", "k", 0, "f1")])).toEqual([]);
  });

  it("never compares two rows of one source", () => {
    expect(findMessageDuplicates([probe(0, "a", "mid:2@h", 1, { fp: "f1" })], [held("a", "mid:1@h", 0, "f1")])).toEqual(
      []
    );
    expect(
      findMessageDuplicates(
        [probe(0, "a", "mid:1@h", 0, { fp: "f1", message_id: "1@h" }), probe(1, "a", "mid:2@h", 1, { fp: "f1" })],
        []
      )
    ).toEqual([]);
  });

  it("matches a canonical mid: key across sources only when the id has an @", () => {
    const withAt = probe(0, "b", "mid:abc@host", 500, { message_id: "abc@host" });
    expect(findMessageDuplicates([withAt], [held("a", "mid:abc@host", 0, null)])).toMatchObject([
      { by: "message_id", of: { source: "a", key: "mid:abc@host" } }
    ]);
    // A bare chat id is only unique inside its own source.
    const bare = probe(0, "b", "mid:12", 0, { message_id: "12" });
    expect(isMessageCopyCandidate(bare)).toBe(false);
    expect(findMessageDuplicates([bare], [held("a", "mid:12", 0, null)])).toEqual([]);
  });

  it("prefers the message id over the fingerprint", () => {
    const out = findMessageDuplicates(
      [probe(0, "b", "mid:abc@host", 0, { message_id: "abc@host", fp: "f1" })],
      [held("c", "x", 0, "f1"), held("a", "mid:abc@host", 0, "f1")]
    );
    expect(out[0]).toMatchObject({ by: "message_id", of: { source: "a" } });
  });

  it("points at the oldest held match, deterministically", () => {
    const out = findMessageDuplicates(
      [probe(0, "z", "fp:x", 0, { fp: "f1" })],
      [held("c", "k3", 20, "f1"), held("b", "k2", -10, "f1"), held("a", "k1", -10, "f1")]
    );
    expect(out[0]!.of).toEqual({ source: "a", key: "k1" });
  });

  it("drops the second of two copies inside one batch and names the kept index", () => {
    const out = findMessageDuplicates(
      [
        probe(3, "a", "fp:1", 0, { fp: "f1" }),
        probe(7, "b", "fp:2", 20, { fp: "f1" }),
        probe(9, "c", "fp:3", 40, { fp: "f1" })
      ],
      []
    );
    expect(out.map((d) => [d.index, d.of])).toEqual([
      [7, { source: "a", key: "fp:1", index: 3 }],
      [9, { source: "a", key: "fp:1", index: 3 }]
    ]);
  });

  it("does not chain through a copy: a third message 61 s from the kept one stays", () => {
    const out = findMessageDuplicates(
      [
        probe(0, "a", "k1", 0, { fp: "f1" }),
        probe(1, "b", "k2", 50, { fp: "f1" }),
        probe(2, "c", "k3", 100, { fp: "f1" })
      ],
      []
    );
    expect(out.map((d) => d.index)).toEqual([1]);
  });

  it("ignores an event with neither a fingerprint nor a shareable id", () => {
    expect(isMessageCopyCandidate({ key: "fp:abc", attrs: { from: "x" } })).toBe(false);
  });
});
