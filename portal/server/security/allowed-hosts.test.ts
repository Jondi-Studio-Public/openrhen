import { afterEach, describe, expect, it, vi } from "vitest";
import { portalHostAllowed } from "./allowed-hosts";

describe("portalHostAllowed", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("by default admits only loopback on any port, the service name and the public URL host", () => {
    vi.stubEnv("PORTAL_ALLOWED_HOSTS", "");
    vi.stubEnv("PORTAL_PUBLIC_URL", "https://p.example.com");
    for (const host of ["localhost", "localhost:1", "127.0.0.1:8787", "[::1]:8787", "portal:8787", "p.example.com"])
      expect(portalHostAllowed(host), host).toBe(true);
    for (const host of [
      "evil.example",
      "localhost.evil.example",
      "127.0.0.1.nip.io",
      "portal:80",
      "10.0.0.5:8787",
      "[::2]"
    ])
      expect(portalHostAllowed(host), host).toBe(false);
  });

  it("without a public URL, a malformed one admits nothing extra", () => {
    vi.stubEnv("PORTAL_ALLOWED_HOSTS", "");
    vi.stubEnv("PORTAL_PUBLIC_URL", "not a url");
    expect(portalHostAllowed("evil.example")).toBe(false);
  });

  it("a configured list replaces the defaults, and a missing Host then fails", () => {
    vi.stubEnv("PORTAL_ALLOWED_HOSTS", "only.example");
    expect(portalHostAllowed("only.example")).toBe(true);
    expect(portalHostAllowed("localhost:8787")).toBe(false);
    expect(portalHostAllowed(null)).toBe(false);
  });
});
