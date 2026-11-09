import { describe, expect, it } from "vitest";
import { MODEL_PROVIDERS, SECRET_NAMES } from "../index.js";

describe("model provider descriptors", () => {
  it("name a connection each, and the hosted secret is a registered secret", () => {
    expect(MODEL_PROVIDERS.local.connectionId).not.toBe(MODEL_PROVIDERS.hosted.connectionId);
    expect(SECRET_NAMES).toContain(MODEL_PROVIDERS.hosted.secretName);
    expect(MODEL_PROVIDERS.local.secretName).toBeUndefined();
  });

  it("gives the local start help the saved host and port, or a placeholder", () => {
    const saved = MODEL_PROVIDERS.local.startHelp!("http://192.168.1.20:11500");
    expect(saved.lines[0]).toContain("192.168.1.20:11500");
    expect(saved.lines[1]).toContain("-LocalPort 11500");
    expect(MODEL_PROVIDERS.local.startHelp!(null).lines[0]).toContain("<this computer's LAN or tailnet IP>:11434");
    expect(MODEL_PROVIDERS.local.startHelp!("not a url").lines[0]).toContain("<this computer's");
  });

  it("refuses by maker prefix with the descriptor's own sentence", () => {
    const hosted = MODEL_PROVIDERS.hosted;
    expect(Object.keys(hosted.refusedOrgs ?? {}).sort()).toEqual(["anthropic", "google"]);
    expect(hosted.refusalMessage?.("google/gemma-3", "Google")).toContain("Google");
  });
});
