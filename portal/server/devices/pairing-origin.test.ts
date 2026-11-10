import { afterEach, describe, expect, it, vi } from "vitest";
import { normaliseUserCode, newUserCode } from "@/server/owner-credential-store";
import { pairingOrigin } from "./pairing-origin";

afterEach(() => vi.unstubAllEnvs());

describe("pairingOrigin", () => {
  it("uses PORTAL_PUBLIC_URL when set, ignoring anything typed", () => {
    vi.stubEnv("PORTAL_PUBLIC_URL", "https://portal.example.com/");
    expect(pairingOrigin("https://evil.example")).toEqual({
      ok: true,
      origin: "https://portal.example.com",
      host: "portal.example.com"
    });
  });

  it("uses a typed https address for one QR when PORTAL_PUBLIC_URL is unset, if its host passes the host check", () => {
    vi.stubEnv("PORTAL_PUBLIC_URL", "");
    vi.stubEnv("PORTAL_ALLOWED_HOSTS", "phone.example.com:8443");
    expect(pairingOrigin("https://phone.example.com:8443")).toMatchObject({
      ok: true,
      origin: "https://phone.example.com:8443"
    });
    expect(pairingOrigin("https://phone.example.com")).toMatchObject({ ok: false, status: 422 });
    expect(pairingOrigin(undefined)).toMatchObject({ ok: false, needsOrigin: true });
  });

  it("refuses an address a phone cannot use over https, and says why", () => {
    vi.stubEnv("PORTAL_PUBLIC_URL", "");
    vi.stubEnv("PORTAL_ALLOWED_HOSTS", "localhost:8787,127.0.0.1:8787,portal:8787,192.168.1.5");
    for (const typed of [
      "http://phone.example.com",
      "https://localhost:8787",
      "https://localhost.:8787",
      "https://app.localhost.",
      "https://127.0.0.1:8787",
      "https://192.168.1.5",
      "https://[::1]",
      "https://portal:8787",
      "https://user:pw@phone.example.com",
      "https://phone.example.com/?x=1",
      "ftp://phone.example.com"
    ]) {
      const result = pairingOrigin(typed);
      expect(result.ok, typed).toBe(false);
    }
  });
});

describe("device codes", () => {
  it("are eight consonants shown as two groups of four, and typing normalises case, spaces and the dash", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = newUserCode();
      expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
      expect(normaliseUserCode(code.toLowerCase().replace("-", "  "))).toBe(code.replace("-", ""));
    }
    expect(normaliseUserCode("BCDF-GHJ")).toBeNull();
    expect(normaliseUserCode("AEIO-AEIO")).toBeNull();
    expect(normaliseUserCode("")).toBeNull();
  });
});
