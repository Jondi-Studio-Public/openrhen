/**
 * The PowerShell the card shows when the local-model test fails: Ollama listens only on this computer's own loopback
 * unless told otherwise, so another machine (the portal's container) cannot reach it. Binding to the one LAN or
 * tailnet address, not 0.0.0.0, keeps it off every other network the computer is on.
 */
const PLACEHOLDER = "<this computer's LAN or tailnet IP>";

export function ollamaStartHelp(savedUrl: string | null): { lines: string[]; steps: string[] } {
  let host = PLACEHOLDER;
  let port = "11434";
  try {
    if (savedUrl) {
      const parsed = new URL(savedUrl);
      if (parsed.hostname) {
        host = parsed.hostname;
        if (parsed.port) port = parsed.port;
      }
    }
  } catch {
    // An address that does not parse keeps the placeholder.
  }
  return {
    lines: [
      `[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "${host}:${port}", "User")`,
      `New-NetFirewallRule -DisplayName "Ollama (mail understanding)" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private`
    ],
    steps: [
      "Run both lines in PowerShell on the computer that runs Ollama (the second needs an administrator window).",
      "Quit Ollama from the tray icon, then start it again so it picks up the new address.",
      "Then press Test again."
    ]
  };
}
