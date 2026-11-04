/**
 * Agent-facing prose is written once and rendered for the surface that serves it: the stdio CLI and MCP server
 * (every command), or the portal's remote `/mcp` (a curated tool set; see `remote-manifest.ts`). A block between
 * `<stdio>` and `</stdio>` lines is kept only for stdio, one between `<remote>` and `</remote>` lines only for remote.
 * Marker lines sit at the start of a line and are never shown. A test (`agent-text-drift.test.ts`) holds every
 * remote rendering to the tools and commands the remote actually serves.
 */
export type TextSurface = "stdio" | "remote";

export function surfaceText(text: string, surface: TextSurface): string {
  const drop = surface === "remote" ? "stdio" : "remote";
  const keep = surface === "remote" ? "remote" : "stdio";
  return text
    .replace(new RegExp(`^<${drop}>\\n[\\s\\S]*?^</${drop}>\\n?`, "gm"), "")
    .replace(new RegExp(`^</?${keep}>\\n?`, "gm"), "")
    .trimEnd();
}
