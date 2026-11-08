import { describe, expect, it } from "vitest";
import {
  checkOllamaTarget,
  classifyAddress,
  ollamaPortsFromEnv,
  parseOllamaBaseUrl,
  parseOwnNetworks
} from "./guard.js";

const own = parseOwnNetworks([{ cidr: "172.18.0.5/16" }, { cidr: "fd12:3456::5/64" }, { cidr: "127.0.0.1/8" }]);

describe("parseOllamaBaseUrl: what is accepted as typed", () => {
  it.each([
    ["http://192.168.1.20:11434", "192.168.1.20", 11434],
    ["http://192.168.1.20:11434/", "192.168.1.20", 11434],
    ["http://192.168.1.20", "192.168.1.20", 11434],
    ["http://100.101.5.5:11434", "100.101.5.5", 11434],
    ["http://[fd7a:115c:a1e0::1]:11434", "fd7a:115c:a1e0::1", 11434],
    ["http://[FD7A:115C:A1E0::1]/", "fd7a:115c:a1e0::1", 11434]
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
    ["host name", "http://pc.tail1234.ts.net:11434"],
    ["host name, upper case", "http://PC.Example.COM:11434"],
    ["name that looks like an IP", "http://192.168.1.20.nip.io:11434"],
    ["IPv6 without brackets", "http://fd7a::1:11434"],
    ["IPv6 bad literal", "http://[not-an-ip]:11434"],
    ["IPv6 zone id", "http://[fe80::1%25eth0]:11434"],
    ["port 0", "http://192.168.1.20:0"],
    ["port too big", "http://192.168.1.20:65536"],
    ["a port Ollama does not use by default", "http://192.168.1.20:8000"],
    ["port 8080", "http://192.168.1.20:8080"],
    ["port 1024", "http://192.168.1.20:1024"],
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

  it("names the allowed port and the variable when a port is refused", () => {
    const parsed = parseOllamaBaseUrl("http://192.168.1.20:8000");
    expect(parsed.ok ? "" : parsed.message).toContain("11434");
    expect(parsed.ok ? "" : parsed.message).toContain("OUTBOUND_OLLAMA_EXTRA_PORTS");
  });

  it("allows an extra port only from the operator's list, and never a stack port", () => {
    const ports = ollamaPortsFromEnv({ OUTBOUND_OLLAMA_EXTRA_PORTS: "8000, 11500" });
    expect([...ports].sort((a, b) => a - b)).toEqual([8000, 11434, 11500]);
    expect(parseOllamaBaseUrl("http://192.168.1.20:8000", ports)).toMatchObject({ ok: true, port: 8000 });
    expect(parseOllamaBaseUrl("http://192.168.1.20:11434", ports)).toMatchObject({ ok: true });
    expect(parseOllamaBaseUrl("http://192.168.1.20:8001", ports).ok).toBe(false);
    // The static list is a second layer even if the set were wrong.
    expect(parseOllamaBaseUrl("http://192.168.1.20:5432", new Set([5432])).ok).toBe(false);
  });

  it.each(["80", "1023", "65536", "abc", "8000,", "8000,5432", "4200", "8000;9000", "-1", "1e4"])(
    "refuses OUTBOUND_OLLAMA_EXTRA_PORTS=%s at start",
    (value) => {
      expect(() => ollamaPortsFromEnv({ OUTBOUND_OLLAMA_EXTRA_PORTS: value })).toThrow(/OUTBOUND_OLLAMA_EXTRA_PORTS/);
    }
  );

  it("defaults to 11434 alone when the variable is unset or blank", () => {
    expect([...ollamaPortsFromEnv({})]).toEqual([11434]);
    expect([...ollamaPortsFromEnv({ OUTBOUND_OLLAMA_EXTRA_PORTS: "  " })]).toEqual([11434]);
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

describe("checkOllamaTarget", () => {
  const parse = (raw: string) => {
    const parsed = parseOllamaBaseUrl(raw);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed;
  };

  it("takes the IP literal as typed", () => {
    expect(checkOllamaTarget(parse("http://192.168.1.20:11434"), { ownNetworks: own })).toEqual({
      ok: true,
      address: "192.168.1.20",
      family: 4,
      hostHeader: "192.168.1.20:11434",
      origin: "http://192.168.1.20:11434"
    });
  });

  it("brackets an IPv6 literal in the origin and the Host header", () => {
    expect(checkOllamaTarget(parse("http://[fd7a:115c:a1e0::1]:11434"), { ownNetworks: own })).toMatchObject({
      ok: true,
      family: 6,
      hostHeader: "[fd7a:115c:a1e0::1]:11434",
      origin: "http://[fd7a:115c:a1e0::1]:11434"
    });
  });

  it.each([
    ["loopback", "http://[::1]:11434", "loopback"],
    ["loopback v4", "http://127.0.0.1:11434", "loopback"],
    ["mapped loopback", "http://[::ffff:7f00:1]:11434", "loopback"],
    ["metadata", "http://169.254.169.254:11434", "metadata"],
    ["link local", "http://169.254.10.10:11434", "link_local"],
    ["alibaba metadata", "http://100.100.100.200:11434", "metadata"],
    ["aws ipv6 metadata", "http://[fd00:ec2::254]:11434", "metadata"],
    ["public", "http://8.8.8.8:11434", "not_private"],
    ["own bridge", "http://172.18.0.3:11434", "own_network"],
    ["bridge gateway", "http://172.18.0.1:11434", "own_network"]
  ])("refuses a literal: %s", (_name, raw, reason) => {
    const target = checkOllamaTarget(parse(raw), { ownNetworks: own });
    expect(target).toMatchObject({ ok: false, reason });
    if (!target.ok) expect(target.message).toMatch(/LAN|tailnet|private/);
  });
});
