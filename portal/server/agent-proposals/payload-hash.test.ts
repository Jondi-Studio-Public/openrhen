import { describe, expect, it } from "vitest";
import { canonicalJson, payloadHash } from "./payload-hash";

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}'
    );
  });
  it("keeps array order and null", () => {
    expect(canonicalJson([2, null, 1])).toBe("[2,null,1]");
  });
});

describe("payloadHash", () => {
  it("is a sha256 hex that ignores key order but not values", () => {
    const one = payloadHash({ command: "save_project", body: { a: 1, b: 2 } });
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash({ body: { b: 2, a: 1 }, command: "save_project" })).toBe(one);
    expect(payloadHash({ command: "save_project", body: { a: 1, b: 3 } })).not.toBe(one);
  });
});
