import { describe, expect, it } from "vitest";
import { ollamaStartHelp } from "./mail-understanding-help";

describe("ollamaStartHelp", () => {
  it("builds PowerShell lines that bind Ollama to the saved LAN or tailnet address, not every interface", () => {
    const help = ollamaStartHelp("http://192.168.1.20:11434");
    expect(help.lines[0]).toBe('[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "192.168.1.20:11434", "User")');
    expect(help.lines.join("\n")).not.toContain("0.0.0.0");
    expect(help.lines.some((line) => line.includes("New-NetFirewallRule") && line.includes("11434"))).toBe(true);
    expect(help.steps.join(" ")).toContain("Quit Ollama");
  });

  it("uses the tailnet address and a non-default port as typed", () => {
    expect(ollamaStartHelp("http://100.101.102.103:11500").lines[0]).toContain("100.101.102.103:11500");
  });

  it("falls back to a placeholder address when none is saved or it does not parse", () => {
    for (const url of [null, "", "not a url"])
      expect(ollamaStartHelp(url).lines[0]).toContain("<this computer's LAN or tailnet IP>:11434");
  });
});
