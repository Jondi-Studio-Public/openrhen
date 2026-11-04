import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PLACEHOLDER_HOST, isStamped, normalizeServerUrl, stampManifest } from "./stamp-url.mjs";

const manifest = JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));

test("the shipped manifest is unstamped, so an install without a stamp fails loudly", () => {
  assert.equal(isStamped(manifest), false);
  assert.ok(manifest.mcpServers.openrhen.url.includes(PLACEHOLDER_HOST));
});

test("stamping sets the endpoint and the agent-time address, and leaves the scope alone", () => {
  const stamped = stampManifest(manifest, "https://plan.example.org/");
  assert.equal(stamped.mcpServers.openrhen.url, "https://plan.example.org/mcp");
  assert.equal(stamped.configSchema.properties.portalUrl.default, "https://plan.example.org");
  assert.equal(stamped.mcpServers.openrhen.oauth.scope, manifest.mcpServers.openrhen.oauth.scope);
  assert.equal(isStamped(stamped), true);
  assert.equal(isStamped(manifest), false, "the input is not changed");
});

test("an address with /mcp already on it, or a path prefix, stamps the same way", () => {
  assert.equal(normalizeServerUrl("https://a.example/mcp"), "https://a.example");
  assert.equal(normalizeServerUrl("https://a.example/planner/"), "https://a.example/planner");
});

test("plain http is refused except for localhost; credentials and queries are refused", () => {
  assert.throws(() => normalizeServerUrl("http://a.example"), /https/);
  assert.equal(normalizeServerUrl("http://localhost:3000"), "http://localhost:3000");
  assert.throws(() => normalizeServerUrl("https://u:p@a.example"), /bare address/);
  assert.throws(() => normalizeServerUrl("https://a.example?x=1"), /bare address/);
  assert.throws(() => normalizeServerUrl("nope"), /not a web address/);
});
