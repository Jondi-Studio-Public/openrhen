import { describe, expect, it, vi } from "vitest";
import { classifyAddress, parseOllamaBaseUrl, parseOwnNetworks, resolveOllamaTarget } from "./guard.js";

const own = parseOwnNetworks([{ cidr: "172.18.0.5/16" }, { cidr: "fd12:3456::5/64" }, { cidr: "127.0.0.1/8" }]);

describe("parseOllamaBaseUrl: what is accepted as typed", () => {
  it.each([
    ["http://192.168.1.20:11434", "192.168.1.20", 11434],
    ["http://192.168.1.20:11434/", "192.168.1.20", 11434],
    ["http://192.168.1.20", "192.168.1.20", 11434],
    ["http://10.0.0.5:8000", "10.0.0.5", 8000],
    ["http://100.101.5.5:11434", "100.101.5.5", 11434],
    ["http://[fd7a:115c:a1e0::1]:11434", "fd7a:115c:a1e0::1", 11434],
    ["http://PC.tail1234.ts.net:11434", "pc.tail1234.ts.net", 11434]
  ])("%s", (raw, host, port) => {
    const parsed = parseOllamaBaseUrl(raw);
    expect(parsed).toMatchObject({ ok: true, host, port });
  });
});

describe("parseOllamaBaseUrl: SSRF table", () => {
  it.each([
    ["decimal IPv4", "http://2130706433:11434"],
    ["decimal IPv4, private", "http://3232235796:11434"],
    ["hex IPv4", "http://0x7f000001:11434"],
    ["dotted hex", "http://0x7f.0.0.1:11434"],
    ["octal IPv4", "http://0177.0.0.1:11434"],
    ["leading zero octet", "http://010.0.0.5:11434"],
    ["short form", "http://10.1:11434"],
    ["short form 127.1", "http://127.1:11434"],
    ["five parts", "http://1.2.3.4.5:11434"],
    ["octet over 255", "http://10.0.0.256:11434"],
    ["userinfo", "http://user:pw@192.168.1.20:11434"],
    ["userinfo trick", "http://192.168.1.20:11434@169.254.169.254"],
    ["userinfo trick 2", "http://169.254.169.254@192.168.1.20:11434"],
    ["backslash", "http://192.168.1.20\\@169.254.169.254:11434"],
    ["https", "https://192.168.1.20:11434"],
    ["file scheme", "file:///etc/passwd"],
    ["gopher scheme", "gopher://192.168.1.20:11434"],
    ["other path", "http://192.168.1.20:11434/api/tags"],
    ["query", "http://192.168.1.20:11434/?x=1"],
    ["fragment", "http://192.168.1.20:11434/#x"],
    ["empty", ""],
    ["whitespace", " http://192.168.1.20:11434"],
    ["trailing space", "http://192.168.1.20:11434 "],
    ["newline", "http://192.168.1.20:11434\n"],
    ["trailing dot", "http://pc.tail.ts.net.:11434"],
    ["empty label", "http://pc..ts.net:11434"],
    ["single label (compose name)", "http://postgres:11434"],
    ["single label engine-service", "http://engine-service:11434"],
    ["single label outbound-proxy", "http://outbound-proxy:11434"],
    ["localhost", "http://localhost:11434"],
    ["sub localhost", "http://foo.localhost:11434"],
    ["internal", "http://metadata.google.internal:11434"],
    ["docker suffix", "http://db.docker:11434"],
    ["IPv6 without brackets", "http://fd7a::1:11434"],
    ["IPv6 bad literal", "http://[not-an-ip]:11434"],
    ["IPv6 zone id", "http://[fe80::1%25eth0]:11434"],
    ["port 0", "http://192.168.1.20:0"],
    ["port too big", "http://192.168.1.20:65536"],
    ["port 80", "http://192.168.1.20:80"],
    ["port 22", "http://192.168.1.20:22"],
    ["port 443", "http://192.168.1.20:443"],
    ["postgres port", "http://192.168.1.20:5432"],
    ["host-published postgres port", "http://192.168.1.20:55432"],
    ["engine port", "http://192.168.1.20:4100"],
    ["proxy port", "http://192.168.1.20:4200"],
    ["portal port", "http://192.168.1.20:8787"],
    ["redis", "http://192.168.1.20:6379"],
    ["docker api", "http://192.168.1.20:2375"],
    ["huge host", `http://${"a".repeat(64)}.example.net:11434`]
  ])("refuses %s", (_name, raw) => {
    const parsed = parseOllamaBaseUrl(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message.length).toBeGreaterThan(30);
  });

  it("refuses a non-string", () => {
    expect(parseOllamaBaseUrl(undefined).ok).toBe(false);
    expect(parseOllamaBaseUrl(1234).ok).toBe(false);
    expect(parseOllamaBaseUrl({}).ok).toBe(false);
  });
});

describe("classifyAddress", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["0.0.0.0", "not_private"],
    ["::", "not_private"],
    ["169.254.169.254", "metadata"],
    ["100.100.100.200", "metadata"],
    ["fd00:ec2::254", "metadata"],
    ["::ffff:169.254.169.254", "metadata"],
    ["169.254.1.1", "link_local"],
    ["fe80::1", "link_local"],
    ["8.8.8.8", "not_private"],
    ["::ffff:8.8.8.8", "not_private"],
    ["64:ff9b::7f00:1", "not_private"],
    ["64:ff9b::a00:5", "not_private"],
    ["2001:db8::1", "not_private"],
    ["2606:4700::1111", "not_private"],
    ["172.15.255.255", "not_private"],
    ["172.32.0.1", "not_private"],
    ["192.169.0.1", "not_private"],
    ["100.63.255.255", "not_private"],
    ["100.128.0.1", "not_private"],
    ["224.0.0.1", "not_private"],
    ["255.255.255.255", "not_private"],
    ["172.18.0.2", "own_network"],
    ["172.18.255.254", "own_network"],
    ["::ffff:172.18.0.2", "own_network"],
    ["fd12:3456::9", "own_network"],
    ["garbage", "not_private"]
  ])("denies %s as %s", (address, reason) => {
    expect(classifyAddress(address, own)).toBe(reason);
  });

  it.each([
    "10.0.0.5",
    "10.255.255.255",
    "172.16.0.1",
    "172.17.0.9",
    "172.31.255.255",
    "192.168.1.20",
    "100.64.0.1",
    "100.101.5.5",
    "100.127.255.254",
    "fd7a:115c:a1e0::1",
    "fc00::1",
    "::ffff:192.168.1.5",
    "::ffff:c0a8:105"
  ])("allows %s", (address) => {
    expect(classifyAddress(address, own)).toBeNull();
  });

  it("reads the proxy's own subnets from interface cidrs, skipping malformed ones", () => {
    const nets = parseOwnNetworks([{ cidr: "10.9.0.2/24" }, { cidr: null }, { cidr: "nonsense" }, {}]);
    expect(nets).toHaveLength(1);
    expect(classifyAddress("10.9.0.77", nets)).toBe("own_network");
    expect(classifyAddress("10.9.1.77", nets)).toBeNull();
  });
});

describe("resolveOllamaTarget", () => {
  const parse = (raw: string) => {
    const parsed = parseOllamaBaseUrl(raw);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed;
  };

  it("takes an IP literal as typed, with no lookup", async () => {
    const lookup = vi.fn();
    const target = await resolveOllamaTarget(parse("http://192.168.1.20:11434"), { lookup, ownNetworks: own });
    expect(target).toEqual({
      ok: true,
      address: "192.168.1.20",
      family: 4,
      hostHeader: "192.168.1.20:11434",
      origin: "http://192.168.1.20:11434"
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("brackets an IPv6 literal in the origin", async () => {
    const target = await resolveOllamaTarget(parse("http://[fd7a:115c:a1e0::1]:11434"), { ownNetworks: own });
    expect(target).toMatchObject({ ok: true, family: 6, origin: "http://[fd7a:115c:a1e0::1]:11434" });
  });

  it.each([
    ["loopback", "http://[::1]:11434", "loopback"],
    ["loopback v4", "http://127.0.0.1:11434", "loopback"],
    ["mapped loopback", "http://[::ffff:7f00:1]:11434", "loopback"],
    ["metadata", "http://169.254.169.254:11434", "metadata"],
    ["link local", "http://169.254.10.10:11434", "link_local"],
    ["alibaba metadata", "http://100.100.100.200:11434", "metadata"],
    ["public", "http://8.8.8.8:11434", "not_private"],
    ["own bridge", "http://172.18.0.3:11434", "own_network"],
    ["bridge gateway", "http://172.18.0.1:11434", "own_network"]
  ])("refuses a literal: %s", async (_name, raw, reason) => {
    const target = await resolveOllamaTarget(parse(raw), { ownNetworks: own });
    expect(target).toMatchObject({ ok: false, reason });
    if (!target.ok) expect(target.message).toMatch(/LAN|tailnet|private/);
  });

  it("resolves a hostname once and pins the checked address, keeping the typed Host header", async () => {
    const lookup = vi.fn(async () => [{ address: "100.101.5.5", family: 4 }]);
    const target = await resolveOllamaTarget(parse("http://pc.tail1234.ts.net:11434"), { lookup, ownNetworks: own });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(target).toEqual({
      ok: true,
      address: "100.101.5.5",
      family: 4,
      hostHeader: "pc.tail1234.ts.net:11434",
      origin: "http://100.101.5.5:11434"
    });
  });

  it("simulated DNS rebinding: the second answer is never used because there is no second lookup", async () => {
    const answers = [[{ address: "192.168.1.20", family: 4 }], [{ address: "169.254.169.254", family: 4 }]];
    const lookup = vi.fn(async () => answers.shift()!);
    const target = await resolveOllamaTarget(parse("http://rebind.example.net:11434"), { lookup, ownNetworks: own });
    expect(target).toMatchObject({ ok: true, address: "192.168.1.20", origin: "http://192.168.1.20:11434" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("refuses when any answer is outside the allowed ranges (a split-horizon answer)", async () => {
    const lookup = async () => [
      { address: "192.168.1.20", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ];
    expect(
      await resolveOllamaTarget(parse("http://mix.example.net:11434"), { lookup, ownNetworks: own })
    ).toMatchObject({
      ok: false,
      reason: "loopback"
    });
  });

  it("refuses a name that resolves to the metadata address or a compose container", async () => {
    for (const [address, reason] of [
      ["169.254.169.254", "metadata"],
      ["172.18.0.2", "own_network"]
    ] as const) {
      const lookup = async () => [{ address, family: 4 }];
      expect(
        await resolveOllamaTarget(parse("http://x.example.net:11434"), { lookup, ownNetworks: own })
      ).toMatchObject({
        ok: false,
        reason
      });
    }
  });

  it("prefers IPv4, and names the fix when DNS fails or returns nothing", async () => {
    const both = async () => [
      { address: "fd7a:115c:a1e0::1", family: 6 },
      { address: "100.101.5.5", family: 4 }
    ];
    expect(
      await resolveOllamaTarget(parse("http://pc.ts.net:11434"), { lookup: both, ownNetworks: own })
    ).toMatchObject({
      ok: true,
      address: "100.101.5.5"
    });
    const none = await resolveOllamaTarget(parse("http://pc.ts.net:11434"), {
      lookup: async () => [],
      ownNetworks: own
    });
    expect(none).toMatchObject({ ok: false, reason: "dns_failed" });
    const broken = await resolveOllamaTarget(parse("http://pc.ts.net:11434"), {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
      ownNetworks: own
    });
    expect(broken).toMatchObject({ ok: false, reason: "dns_failed" });
    if (!broken.ok) expect(broken.message).toContain("IP address");
  });
});
