#!/usr/bin/env node
// Points an unpacked plugin at one OpenRhen server: node stamp-url.mjs https://your-server.example [plugin-dir]
// OpenClaw reads the MCP server address from a static manifest, so each install stamps its own once.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLACEHOLDER_HOST = "stamp-url.invalid";

/** The server's base address, or throws. https only, except a loopback host for local trials. */
export function normalizeServerUrl(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error(`"${input}" is not a web address; use the form https://openrhen.example.com`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("the server address must start with https:// (http:// is allowed only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("the server address must be the bare address, with no credentials, query or fragment");
  }
  return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
}

/** The manifest with the server's `/mcp` endpoint and the agent-time portal address set. */
export function stampManifest(manifest, input) {
  const base = normalizeServerUrl(input);
  const next = structuredClone(manifest);
  for (const server of Object.values(next.mcpServers ?? {})) server.url = `${base}/mcp`;
  if (next.configSchema?.properties?.portalUrl) next.configSchema.properties.portalUrl.default = base;
  return next;
}

export function isStamped(manifest) {
  const urls = Object.values(manifest.mcpServers ?? {}).map((server) => server.url);
  return urls.length > 0 && urls.every((url) => !String(url).includes(PLACEHOLDER_HOST));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [url, dir = fileURLToPath(new URL(".", import.meta.url))] = process.argv.slice(2);
  if (!url) {
    console.error("usage: node stamp-url.mjs https://your-server.example [plugin-dir]");
    process.exit(2);
  }
  try {
    const path = join(dir, "openclaw.plugin.json");
    writeFileSync(path, `${JSON.stringify(stampManifest(JSON.parse(readFileSync(path, "utf8")), url), null, 2)}\n`);
    console.log(`Stamped ${path} for ${normalizeServerUrl(url)}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
