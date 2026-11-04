import { describe, expect, it } from "vitest";
import { validateAgentWakeUrl } from "./agent-wake-sender.js";

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
