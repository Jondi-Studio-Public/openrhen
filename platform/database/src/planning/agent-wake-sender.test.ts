import { describe, expect, it } from "vitest";
import { agentWakeRoutingFromEnv, buildAgentWakeBody, validateAgentWakeUrl } from "./agent-wake-sender.js";

describe("validateAgentWakeUrl", () => {
  it.each([
    ["https://gw.example.com", "https://gw.example.com"],
    ["https://gw.example.com/", "https://gw.example.com"],
    ["http://127.0.0.1:18789/", "http://127.0.0.1:18789"],
    ["http://127.5.6.7", "http://127.5.6.7"],
    ["http://localhost:1", "http://localhost:1"],
    ["http://[::1]:1", "http://[::1]:1"],
    ["http://100.64.0.1", "http://100.64.0.1"],
    ["http://100.127.255.254", "http://100.127.255.254"],
    ["http://box.tail1234.ts.net:18789", "http://box.tail1234.ts.net:18789"]
  ])("accepts %s", (raw, expected) => {
    expect(validateAgentWakeUrl(raw)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "not a url",
    "ftp://127.0.0.1",
    "http://192.168.1.5",
    "http://10.0.0.1",
    "http://100.63.0.1",
    "http://100.128.0.1",
    "http://example.com",
    "https://user:pw@gw.example.com",
    "http://user@127.0.0.1"
  ])("rejects %j", (raw) => {
    expect(validateAgentWakeUrl(raw)).toBeNull();
  });
});

describe("agent wake routing", () => {
  it("reads the routing fields from OPENCLAW_HOOKS_* and ignores blanks", () => {
    expect(
      agentWakeRoutingFromEnv({
        OPENCLAW_HOOKS_AGENT_ID: "main",
        OPENCLAW_HOOKS_CHANNEL: "telegram",
        OPENCLAW_HOOKS_ACCOUNT_ID: "main",
        OPENCLAW_HOOKS_TO: " 12345 ",
        OPENCLAW_HOOKS_SESSION_KEY: "agent:main:main"
      })
    ).toEqual({ agentId: "main", channel: "telegram", accountId: "main", to: "12345", sessionKey: "agent:main:main" });
    expect(agentWakeRoutingFromEnv({ OPENCLAW_HOOKS_TO: "  ", OPENCLAW_HOOKS_CHANNEL: "" })).toEqual({});
  });

  it("puts the routing fields and a persistent session mode in the body", () => {
    const body = buildAgentWakeBody("hi", {
      agentId: "main",
      channel: "telegram",
      accountId: "main",
      to: "12345",
      sessionKey: "agent:main:main"
    });
    expect(body).toEqual({
      message: "hi",
      name: "rhen",
      agentId: "main",
      channel: "telegram",
      accountId: "main",
      to: "12345",
      sessionKey: "agent:main:main",
      sessionMode: "persistent"
    });
  });

  it("sends only message and name when nothing is routed", () => {
    expect(buildAgentWakeBody("hi")).toEqual({ message: "hi", name: "rhen" });
  });
});
