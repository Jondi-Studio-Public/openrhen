// The MCP server and the skills are declared in openclaw.plugin.json. The code here only reports agent time,
// and only once an agent-time token is configured. It uses metadata hooks only: no conversation access.
import { readFileSync } from "node:fs";
import { PLACEHOLDER_HOST, isStamped } from "./stamp-url.mjs";
import { createAgentTimeReporter, sessionKeyOf } from "./agent-time.js";

export const UNSTAMPED_MESSAGE =
  "OpenRhen is not pointed at a server yet, so it cannot connect. Run: node stamp-url.mjs https://your-server.example " +
  "in the plugin folder, then reinstall with: openclaw plugins install ./openclaw-plugin --accept-capabilities --force";

/** The error to log when the manifest still holds the placeholder address, else undefined. */
export function unstampedProblem(manifest) {
  return isStamped(manifest) ? undefined : UNSTAMPED_MESSAGE;
}

function readManifest() {
  try {
    return JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
  } catch {
    return undefined; // an unreadable manifest is OpenClaw's to report
  }
}

export default {
  id: "openrhen",
  name: "OpenRhen",
  description:
    "Connects OpenClaw to OpenRhen over remote MCP, teaches the agent to drive it, and reports agent time.",
  register(api) {
    const manifest = readManifest();
    const problem = manifest ? unstampedProblem(manifest) : undefined;
    if (problem) api.logger.error?.(problem);
    const config = api.pluginConfig ?? {};
    if (typeof config.agentTimeToken !== "string" || config.agentTimeToken.length === 0) {
      api.logger.info("OpenRhen agent time is not reported: set agentTimeToken in the plugin's settings.");
      return;
    }
    if (typeof config.portalUrl !== "string" || config.portalUrl.length === 0 || config.portalUrl.includes(PLACEHOLDER_HOST)) {
      api.logger.info("OpenRhen agent time is not reported: run stamp-url.mjs or set portalUrl in the plugin's settings.");
      return;
    }
    const reporter = createAgentTimeReporter({
      portalUrl: config.portalUrl,
      token: config.agentTimeToken,
      log: api.logger
    });
    api.on("model_call_ended", (event, ctx) => reporter.activity(sessionKeyOf(event, ctx), event?.durationMs));
    api.on("session_end", (event, ctx) => reporter.end(sessionKeyOf(event, ctx)));
    api.on("gateway_stop", () => reporter.flushAll());
  }
};
