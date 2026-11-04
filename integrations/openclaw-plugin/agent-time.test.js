import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import plugin, { unstampedProblem } from "./index.js";
import { stampManifest } from "./stamp-url.mjs";
import { createAgentTimeReporter, sessionKeyOf } from "./agent-time.js";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-27T09:00:00Z");

function harness() {
  const posts = [];
  const timers = [];
  let clock = T0;
  const reporter = createAgentTimeReporter({
    portalUrl: "https://openrhen.example.com",
    token: "pri_test",
    now: () => clock,
    setTimer: (callback) => timers.push(callback),
    fetchImpl: async (url, init) => {
      posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    }
  });
  const fireTimers = async () => {
    for (const callback of timers.splice(0)) callback();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const sessions = () => posts.map((post) => post.body.sessions[0]);
  return { reporter, posts, sessions, fireTimers, advance: (ms) => (clock += ms) };
}

test("posts a burst of model calls once, metadata only, with the agent-time token", async () => {
  const { reporter, posts, sessions, fireTimers, advance } = harness();
  reporter.activity("abc", 2 * MINUTE);
  advance(MINUTE);
  reporter.activity("abc", 30_000);
  assert.equal(posts.length, 0);
  await fireTimers();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "https://openrhen.example.com/api/agent-sessions");
  assert.equal(posts[0].headers["x-openrhen-token"], "pri_test");
  assert.equal(posts[0].body.schemaVersion, 1);
  assert.deepEqual(sessions()[0], {
    id: `oc-abc-${T0 - 2 * MINUTE}`,
    startedAt: "2026-10-27T08:58:00.000Z",
    endedAt: "2026-10-27T09:01:00.000Z",
    kind: "conversation"
  });
});

test("activity within 30 idle minutes grows the same record; later activity starts a new one", async () => {
  const { reporter, sessions, fireTimers, advance } = harness();
  reporter.activity("abc", MINUTE);
  await fireTimers();
  advance(20 * MINUTE);
  reporter.activity("abc", MINUTE);
  await fireTimers();
  assert.equal(sessions()[1].id, sessions()[0].id);
  assert.equal(sessions()[1].endedAt, "2026-10-27T09:20:00.000Z");
  advance(3 * 60 * MINUTE);
  reporter.activity("abc", MINUTE);
  await fireTimers();
  assert.notEqual(sessions()[2].id, sessions()[0].id);
  assert.equal(sessions()[2].startedAt, "2026-10-27T12:19:00.000Z");
});

test("a burst that goes idle is posted before the next one starts, even without a timer", async () => {
  const { reporter, sessions, advance } = harness();
  reporter.activity("abc", 0);
  advance(45 * MINUTE);
  reporter.activity("abc", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions().length, 1);
  assert.equal(sessions()[0].endedAt, "2026-10-27T09:00:00.000Z");
});

test("a burst never passes the ingest's 24-hour limit", async () => {
  const { reporter, sessions, fireTimers, advance } = harness();
  for (let minutes = 0; minutes <= 25 * 60; minutes += 20) {
    reporter.activity("abc", 0);
    await fireTimers();
    advance(20 * MINUTE);
  }
  const ids = new Set(sessions().map((session) => session.id));
  assert.equal(ids.size, 2);
  for (const session of sessions())
    assert.ok(Date.parse(session.endedAt) - Date.parse(session.startedAt) <= 24 * 60 * MINUTE);
});

test("ids keep to the ingest's character rule and length", async () => {
  const { reporter, sessions, fireTimers } = harness();
  reporter.activity(`agent:main/${"x".repeat(200)} chat`, 0);
  await fireTimers();
  assert.match(sessions()[0].id, /^[A-Za-z0-9._:-]{1,128}$/);
});

test("session_end posts what is left and forgets the session; gateway_stop flushes all", async () => {
  const { reporter, sessions, advance } = harness();
  reporter.activity("a", 0);
  await reporter.end("a");
  assert.equal(sessions().length, 1);
  await reporter.end("a");
  assert.equal(sessions().length, 1);
  advance(MINUTE);
  reporter.activity("a", 0);
  reporter.activity("b", 0);
  await reporter.flushAll();
  assert.equal(sessions().length, 3);
  assert.notEqual(sessions()[1].id, sessions()[0].id);
});

test("a failed post is logged, not thrown", async () => {
  const warnings = [];
  const reporter = createAgentTimeReporter({
    portalUrl: "https://openrhen.example.com",
    token: "pri_test",
    setTimer: () => {},
    log: { warn: (message) => warnings.push(message) },
    fetchImpl: async () => {
      throw new Error("offline");
    }
  });
  reporter.activity("abc", 0);
  await reporter.flushAll();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /offline/);
});

test("without a token the plugin registers no hooks", () => {
  const hooks = [];
  const info = [];
  plugin.register({ pluginConfig: {}, logger: { info: (m) => info.push(m) }, on: (name) => hooks.push(name) });
  assert.deepEqual(hooks, []);
  assert.equal(info.length, 1);
});

test("a token without a portal address registers no hooks and says so", () => {
  const hooks = [];
  const info = [];
  plugin.register({
    pluginConfig: { agentTimeToken: "pri_test" },
    logger: { info: (m) => info.push(m) },
    on: (name) => hooks.push(name)
  });
  assert.deepEqual(hooks, []);
  assert.match(info[0], /portalUrl/);
});

test("with a token it uses only metadata hooks, none that need conversation access", () => {
  const hooks = [];
  plugin.register({ pluginConfig: { agentTimeToken: "pri_test", portalUrl: "https://openrhen.example.com" }, logger: {}, on: (name) => hooks.push(name) });
  assert.deepEqual(hooks, ["model_call_ended", "session_end", "gateway_stop"]);
});

test("both hooks find the session the same way, including from the context", () => {
  assert.equal(sessionKeyOf({ sessionId: "e" }, { sessionId: "c" }), "e");
  assert.equal(sessionKeyOf({}, { sessionId: "c", sessionKey: "k" }), "c");
  assert.equal(sessionKeyOf({ sessionKey: "k" }, {}), "k");
  assert.equal(sessionKeyOf(undefined, { sessionKey: "k" }), "k");
});

test("a session whose id only the context carries is flushed by its session_end", async () => {
  const hooks = {};
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posts.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };
  try {
    plugin.register({
      pluginConfig: { agentTimeToken: "pri_test", portalUrl: "https://openrhen.example.com" },
      logger: {},
      on: (name, handler) => (hooks[name] = handler)
    });
    hooks.model_call_ended({ durationMs: 1000 }, { sessionId: "ctx-only" });
    await hooks.session_end({}, { sessionId: "ctx-only" });
    assert.equal(posts.length, 1);
    assert.match(posts[0].sessions[0].id, /^oc-ctx-only-/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a huge duration is clamped to what the ingest accepts", async () => {
  const { reporter, sessions } = harness();
  reporter.activity("abc", 1e12);
  await reporter.flushAll();
  assert.equal(Date.parse(sessions()[0].endedAt) - Date.parse(sessions()[0].startedAt), 24 * 60 * MINUTE);
});

test("other sessions gone idle are posted and dropped when activity arrives", async () => {
  const { reporter, sessions, advance } = harness();
  reporter.activity("old", 0);
  advance(45 * MINUTE);
  reporter.activity("new", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sessions().map((session) => session.id),
    [`oc-old-${T0}`]
  );
  await reporter.flushAll();
  assert.equal(sessions().length, 2);
  assert.equal(sessions()[1].id, `oc-new-${T0 + 45 * MINUTE}`);
});

test("an unstamped plugin logs an error naming the exact next command, even without a token", () => {
  const errors = [];
  plugin.register({ pluginConfig: {}, logger: { info() {}, error: (m) => errors.push(m) }, on() {} });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /node stamp-url\.mjs https:\/\/your-server\.example/);
  assert.match(errors[0], /openclaw plugins install \.\/openclaw-plugin --accept-capabilities --force/);
});

test("a stamped manifest raises no problem", () => {
  const manifest = JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
  assert.ok(unstampedProblem(manifest));
  assert.equal(unstampedProblem(stampManifest(manifest, "https://plan.example.org")), undefined);
});
