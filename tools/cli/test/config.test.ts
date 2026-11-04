import { describe, expect, it } from "vitest";
import {
  assertPrivateAddresses,
  DEFAULT_PORTAL_URL,
  DEFAULT_TIMEOUT_MS,
  isPrivateHost,
  resolveConfig,
  type ConfigSources
} from "../src/config.js";
import { CliError } from "../src/errors.js";

function sources(overrides: Partial<ConfigSources> = {}): ConfigSources {
  return { env: {}, readConfigFile: () => null, ...overrides };
}

describe("resolveConfig: url precedence", () => {
  it("uses the default when nothing else is set", () => {
    expect(resolveConfig({}, sources()).url).toBe(DEFAULT_PORTAL_URL);
  });

  it("marks the result fromDefault only when no url was given", () => {
    expect(resolveConfig({}, sources()).fromDefault).toBe(true);
    expect(
      resolveConfig({}, sources({ readConfigFile: () => ({ url: "http://10.1.2.3:8787" }) })).fromDefault
    ).toBeUndefined();
    expect(resolveConfig({}, sources({ env: { OPENRHEN_URL: "http://10.1.2.4:8787" } })).fromDefault).toBeUndefined();
    expect(resolveConfig({ url: "http://10.1.2.5:8787" }, sources()).fromDefault).toBeUndefined();
  });

  it("file url overrides the default", () => {
    const config = resolveConfig({}, sources({ readConfigFile: () => ({ url: "http://10.1.2.3:8787" }) }));
    expect(config.url).toBe("http://10.1.2.3:8787");
  });

  it("env url overrides the file", () => {
    const config = resolveConfig(
      {},
      sources({
        env: { OPENRHEN_URL: "http://10.1.2.4:8787" },
        readConfigFile: () => ({ url: "http://10.1.2.3:8787" })
      })
    );
    expect(config.url).toBe("http://10.1.2.4:8787");
  });

  it("flag url overrides env and file", () => {
    const config = resolveConfig(
      { url: "http://10.1.2.5:8787" },
      sources({
        env: { OPENRHEN_URL: "http://10.1.2.4:8787" },
        readConfigFile: () => ({ url: "http://10.1.2.3:8787" })
      })
    );
    expect(config.url).toBe("http://10.1.2.5:8787");
  });
});

describe("resolveConfig: timeout precedence", () => {
  it("uses the default when nothing else is set", () => {
    expect(resolveConfig({}, sources()).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("file timeoutMs overrides the default", () => {
    const config = resolveConfig({}, sources({ readConfigFile: () => ({ timeoutMs: 5000 }) }));
    expect(config.timeoutMs).toBe(5000);
  });

  it("env timeout overrides the file", () => {
    const config = resolveConfig(
      {},
      sources({ env: { OPENRHEN_TIMEOUT_MS: "6000" }, readConfigFile: () => ({ timeoutMs: 5000 }) })
    );
    expect(config.timeoutMs).toBe(6000);
  });

  it("flag timeout overrides env and file", () => {
    const config = resolveConfig(
      { timeout: "7000" },
      sources({ env: { OPENRHEN_TIMEOUT_MS: "6000" }, readConfigFile: () => ({ timeoutMs: 5000 }) })
    );
    expect(config.timeoutMs).toBe(7000);
  });

  it("rejects a non-numeric timeout", () => {
    expect(() => resolveConfig({ timeout: "soon" }, sources())).toThrow(CliError);
    try {
      resolveConfig({ timeout: "soon" }, sources());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(1);
    }
  });

  it("rejects a zero timeout", () => {
    expect(() => resolveConfig({ timeout: "0" }, sources())).toThrow(CliError);
  });

  it("rejects a negative timeout", () => {
    expect(() => resolveConfig({ timeout: "-5" }, sources())).toThrow(CliError);
  });
});

describe("resolveConfig: origin normalisation", () => {
  it("strips a path and trailing slash down to the origin", () => {
    expect(resolveConfig({ url: "http://localhost:8787/api/" }, sources()).url).toBe("http://localhost:8787");
  });
});

describe("resolveConfig: malformed input", () => {
  it("rejects an unparsable URL", () => {
    try {
      resolveConfig({ url: "not a url" }, sources());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(1);
    }
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => resolveConfig({ url: "ftp://localhost" }, sources())).toThrow(CliError);
  });

  it("ignores a config file that is not an object", () => {
    const config = resolveConfig({}, sources({ readConfigFile: () => null }));
    expect(config.url).toBe(DEFAULT_PORTAL_URL);
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("resolveConfig: public host refusal and allowPublic", () => {
  it("refuses a public host by default", () => {
    try {
      resolveConfig({ url: "http://example.com" }, sources());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(1);
    }
  });

  it("permits a public host with allowPublic input", () => {
    const config = resolveConfig({ url: "http://example.com", allowPublic: true }, sources());
    expect(config.url).toBe("http://example.com");
    expect(config.allowPublic).toBe(true);
  });

  it("permits a public host with OPENRHEN_ALLOW_PUBLIC=1", () => {
    const config = resolveConfig({ url: "http://example.com" }, sources({ env: { OPENRHEN_ALLOW_PUBLIC: "1" } }));
    expect(config.url).toBe("http://example.com");
  });
});

describe("isPrivateHost: accepted", () => {
  const accepted = [
    "localhost",
    "127.0.0.1",
    "10.1.2.3",
    "10.20.30.41",
    "172.16.0.1",
    "172.31.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "box.ts.net",
    "nas.local",
    "plainname",
    "[::1]",
    "fd00::1",
    "fc12::7",
    "fe80::1",
    "[::ffff:c0a8:1]",
    "::ffff:10.0.0.1"
  ];
  for (const host of accepted) it(`accepts ${host}`, () => expect(isPrivateHost(host)).toBe(true));
});

describe("isPrivateHost: refused", () => {
  const refused = [
    "example.com",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "11.0.0.1",
    // Names that merely start like a private IPv6 prefix are public names.
    "fdic.gov",
    "fd-leak.collector.example",
    "fcc.gov",
    "fe80.example.com",
    "2001:db8::1",
    "[::ffff:808:808]"
  ];
  for (const host of refused) it(`refuses ${host}`, () => expect(isPrivateHost(host)).toBe(false));
});

describe("resolveConfig: HTTPS names checked by address", () => {
  it("defers an HTTPS name under a public domain to the address check instead of refusing it", () => {
    const config = resolveConfig({ url: "https://openrhen.example.com" }, sources());
    expect(config.url).toBe("https://openrhen.example.com");
    expect(config.checkAddresses).toBe(true);
  });

  it("still refuses the same name over plain http", () => {
    expect(() => resolveConfig({ url: "http://openrhen.example.com" }, sources())).toThrow(CliError);
  });

  it("still refuses a public address literal over https", () => {
    expect(() => resolveConfig({ url: "https://8.8.8.8" }, sources())).toThrow(CliError);
  });

  it("needs no address check for a private host", () => {
    expect(resolveConfig({ url: "https://10.20.30.12" }, sources()).checkAddresses).toBeUndefined();
  });
});

describe("assertPrivateAddresses", () => {
  const lookupOf =
    (...addresses: string[]) =>
    async () =>
      addresses.map((address) => ({ address }));

  it("accepts a name whose every address is private", async () => {
    await expect(assertPrivateAddresses("openrhen.example.com", lookupOf("10.20.30.12"))).resolves.toBeUndefined();
  });

  it("refuses a name with any public address", async () => {
    await expect(
      assertPrivateAddresses("openrhen.example.com", lookupOf("10.20.30.12", "203.0.113.9"))
    ).rejects.toThrow(/203\.0\.113\.9/);
  });

  it("refuses a name that resolves to nothing or fails to resolve", async () => {
    await expect(assertPrivateAddresses("x.example", lookupOf())).rejects.toThrow(CliError);
    await expect(
      assertPrivateAddresses("x.example", async () => {
        throw new Error("ENOTFOUND");
      })
    ).rejects.toThrow(/Cannot resolve/);
  });
});
