import { describe, expect, it } from "vitest";
import { CHANGE_FEED_DEFAULT_LIMIT, parseChangeFeedQuery } from "./change-feed";

const parse = (query: string) => parseChangeFeedQuery(new URLSearchParams(query));

describe("parseChangeFeedQuery", () => {
  it("defaults to a small page without evidence", () => {
    const result = parse("");
    expect(result).toMatchObject({ ok: true, query: { limit: CHANGE_FEED_DEFAULT_LIMIT, evidence: false } });
  });
  it("accepts filters and a cursor", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const result = parse(
      `agent=scribe&entity=project&limit=5&since=2026-10-01T00:00:00Z&before=2026-10-02T00:00:00.000Z~${id}`
    );
    expect(result.ok && result.query.before?.id).toBe(id);
    expect(result.ok && result.query.limit).toBe(5);
  });
  it("accepts an entity id, plain or a composite key, and rejects junk", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const composite = JSON.stringify([id, "home"]);
    expect(parse(`entityId=${id}`)).toMatchObject({ ok: true, query: { entityId: id } });
    expect(parse(`entityId=${encodeURIComponent(composite)}`)).toMatchObject({
      ok: true,
      query: { entityId: composite }
    });
    for (const q of ["entityId=", "entityId=a%20b", `entityId=${"x".repeat(201)}`, "entityId=%27%3B--"])
      expect(parse(q).ok).toBe(false);
  });
  it("asks for image facts only with images=1", () => {
    expect(parse("")).toMatchObject({ ok: true, query: { images: false } });
    expect(parse("images=1")).toMatchObject({ ok: true, query: { images: true } });
    expect(parse("images=0")).toMatchObject({ ok: true, query: { images: false } });
  });
  it("rejects bad input", () => {
    for (const q of ["limit=0", "limit=201", "since=nope", "agent=Bad%20Name", "before=garbage"])
      expect(parse(q).ok).toBe(false);
  });
});
