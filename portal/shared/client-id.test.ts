import { describe, expect, it } from "vitest";
import { createClientId } from "./client-id";

/** A plain-http origin is not a secure context, so `crypto.randomUUID` is simply absent there. */
function withoutRandomUUID<T>(body: () => T): T {
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    return body();
  } finally {
    delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("client ids", () => {
  it("returns a v4 uuid whether or not the origin is a secure context", () => {
    expect(createClientId()).toMatch(UUID_V4);
    expect(withoutRandomUUID(createClientId)).toMatch(UUID_V4);
    expect(withoutRandomUUID(createClientId)).not.toBe(withoutRandomUUID(createClientId));
  });
});
