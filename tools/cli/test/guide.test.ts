import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { commands } from "../src/registry.js";
import { guideOverview, guideTopics } from "../src/guide-content.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

/** `guide` is offline, so a fetch impl that throws proves it never talks to the portal, even with --url. */
async function runGuide(argv: readonly string[]): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    fetchImpl: fakeFetch({}, calls)
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

async function runGuideNoNetwork(argv: readonly string[]): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const throwingFetch: typeof fetch = () => {
    throw new Error("guide must never call fetch");
  };
  const exitCode = await runCli(argv, {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    fetchImpl: throwingFetch
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

describe("guide", () => {
  it("with no topic, prints the overview and names every topic", async () => {
    const { exitCode, stdout } = await runGuide(["guide"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("what should I work on right now");
    for (const topic of guideTopics) expect(stdout).toContain(topic.name);
  });

  it("--json with no topic prints {overview, topics: [{name, summary}]}", async () => {
    const { exitCode, stdout } = await runGuide(["guide", "--json"]);
    expect(exitCode).toBe(EXIT.ok);
    const json = JSON.parse(stdout) as { overview: string; topics: { name: string; summary: string }[] };
    expect(json.overview).toBe(guideOverview);
    expect(json.topics.map((topic) => topic.name).sort()).toEqual(guideTopics.map((topic) => topic.name).sort());
    for (const topic of json.topics) {
      expect(typeof topic.name).toBe("string");
      expect(typeof topic.summary).toBe("string");
    }
  });

  it("vocabulary defines the core hierarchy terms", async () => {
    const { exitCode, stdout } = await runGuide(["guide", "vocabulary"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("outcome —");
    expect(stdout).toContain("deliverable —");
    expect(stdout).toContain("directive —");
  });

  it("workflows names real command sequences", async () => {
    const { exitCode, stdout } = await runGuide(["guide", "workflows"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("import preview");
    expect(stdout).toContain("session start");
    expect(stdout).toContain("session finish");
  });

  it("workflows gives the sleep log its own recipe: a night, a lone wake, and correcting by id", async () => {
    const { exitCode, stdout } = await runGuide(["guide", "workflows"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("4c. Log a night's sleep, or only a wake");
    expect(stdout).toContain("save sleep-log-entry --set sleepAt=");
    expect(stdout).toContain("rhen wake --at ");
    expect(stdout).toContain("save sleep-log-entry --id <id>");
    expect(stdout).toContain("never by saving a second one");
  });

  it("writing-data covers version conflicts, dry-run, and --yes", async () => {
    const { exitCode, stdout } = await runGuide(["guide", "writing-data"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("expectedVersion");
    expect(stdout).toContain("--yes");
  });

  it("reading-data covers status --json, list filters, and state --key", async () => {
    const { exitCode, stdout } = await runGuide(["guide", "reading-data"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("status --json");
    expect(stdout).toContain("state --key");
    expect(stdout).toContain("schema");
  });

  it("recurrence distinguishes commitment, recurring-action, and cadence recurrence", async () => {
    const { exitCode, stdout } = await runGuide(["guide", "recurrence"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("commitment recurrence");
    expect(stdout).toContain("recurring action");
    expect(stdout).toContain("cadence action");
    expect(stdout).toContain("recurrence set");
    expect(stdout).toContain("cadence complete");
    expect(stdout).toContain("generated");
  });

  it("--json for a single topic prints {topic, text}", async () => {
    const { exitCode, stdout } = await runGuide(["guide", "workflows", "--json"]);
    expect(exitCode).toBe(EXIT.ok);
    const json = JSON.parse(stdout) as { topic: string; text: string };
    expect(json.topic).toBe("workflows");
    const expected = guideTopics.find((topic) => topic.name === "workflows");
    expect(json.text).toBe(expected?.text);
  });

  it("an unknown topic is a usage error naming the valid topics", async () => {
    const { exitCode, stderr } = await runGuide(["guide", "nope"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr).toContain('Unknown guide topic "nope"');
    for (const topic of guideTopics) expect(stderr).toContain(topic.name);
  });

  it("never calls the portal, even with --url, for the overview or a topic", async () => {
    for (const argv of [
      ["guide", "--url", "http://example.com"],
      ["guide", "vocabulary", "--url", "http://example.com"]
    ]) {
      const { exitCode, calls } = await runGuideNoNetwork(argv);
      expect(exitCode).toBe(EXIT.ok);
      expect(calls).toHaveLength(0);
    }
  });

  it("every 'rhen <command>' example line in guide content names a real registered command", () => {
    const registered = new Set(commands.map((command) => command.name));
    const allText = [guideOverview, ...guideTopics.map((topic) => topic.text)].join("\n");
    const exampleLines = allText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("rhen "));
    expect(exampleLines.length).toBeGreaterThan(0);
    for (const line of exampleLines) {
      const firstWord = line.slice("rhen ".length).trim().split(/\s+/)[0];
      expect(registered.has(firstWord ?? "")).toBe(true);
    }
  });
});

describe("guide: running late", () => {
  it("has a recipe for a person who is late or ran over, with the exact calls", () => {
    const text = JSON.stringify(guideTopics);
    expect(text).toContain("running late");
    expect(text).toContain("disruption start --title");
    expect(text).toContain("recalculate");
  });
});
