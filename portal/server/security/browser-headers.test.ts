import { describe, expect, it } from "vitest";
import { PORTAL_CONTENT_SECURITY_POLICY, portalSecurityHeaders } from "./browser-headers";

describe("portalSecurityHeaders (C6)", () => {
  const [rule] = portalSecurityHeaders();
  const header = (name: string) => rule!.headers.find((item) => item.key === name)?.value;

  it("applies to every path", () => {
    expect(portalSecurityHeaders()).toHaveLength(1);
    expect(rule!.source).toBe("/(.*)");
  });

  it("forbids framing, plugins and a rewritten base URL", () => {
    expect(header("Content-Security-Policy")).toBe(PORTAL_CONTENT_SECURITY_POLICY);
    for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"])
      expect(PORTAL_CONTENT_SECURITY_POLICY).toContain(directive);
    expect(header("X-Frame-Options")).toBe("DENY");
  });

  it("sets no script or default source, so it cannot block the framework's own inline scripts", () => {
    expect(PORTAL_CONTENT_SECURITY_POLICY).not.toMatch(/default-src|script-src|style-src|connect-src/);
  });
});
