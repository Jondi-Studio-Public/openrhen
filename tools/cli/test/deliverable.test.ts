import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readdirSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { memoryJournal } from "../src/undo-journal.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  rawState: Record<string, unknown> = fixtureRawState()
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const fetchImpl = fakeFetch({ "/api/state": { body: { state: rawState } }, ...routes }, calls);
  const exitCode = await runCli(["deliverable", ...argv], {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

describe("deliverable: resolution", () => {
  it("resolves the deliverable by id", async () => {
    const raw = fixtureRawState();
    const { exitCode, calls } = await run(
      ["pack", "deliverable-chapter"],
      {
        "/api/deliverables/deliverable-chapter/pack": { body: { deliverable: { id: "deliverable-chapter" } } }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    // pack only GETs, never POSTs
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("resolves the deliverable by exact title", async () => {
    const raw = fixtureRawState();
    const { exitCode, calls } = await run(
      ["pack", "Chapter 3 draft"],
      {
        "/api/deliverables/deliverable-chapter/pack": { body: { deliverable: { id: "deliverable-chapter" } } }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("errors with notFound when id/title does not resolve", async () => {
    const { exitCode, calls } = await run(["pack", "nonexistent"]);
    expect(exitCode).toBe(EXIT.notFound);
    // Should not call any deliverable-specific route when resolution fails
    expect(calls.some((call) => call.path.startsWith("/api/deliverables/"))).toBe(false);
  });
});

describe("deliverable: handoff", () => {
  it("GETs the pack and prints pack.prompts.handoff verbatim when no --inline", async () => {
    const { exitCode, stdout, calls } = await run(["handoff", "deliverable-chapter"], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { title: "Chapter 3 draft" },
          prompts: { handoff: "Start writing the draft." }
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toBe("Start writing the draft.");
    // handoff never POSTs
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("uses a fallback prompt when pack.prompts.handoff is missing", async () => {
    const { exitCode, stdout } = await run(["handoff", "deliverable-chapter"], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { title: "Chapter 3 draft", id: "deliverable-chapter" },
          prompts: {}
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("Coordinate the deliverable");
    expect(stdout).toContain("pick-up");
  });

  it("with --inline, appends the rendered pack content to the prompt", async () => {
    const { exitCode, stdout } = await run(["handoff", "deliverable-chapter", "--inline"], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: {
            id: "deliverable-chapter",
            title: "Chapter 3 draft",
            status: "in_progress",
            projectTitle: "Thesis",
            phase: "draft"
          },
          prompts: { handoff: "Start writing." },
          criteria: [],
          steps: [],
          blockers: [],
          readiness: { eligible: true },
          sources: [],
          transcript: []
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("Start writing.");
    expect(stdout).toContain("Chapter 3 draft");
    expect(stdout).toContain("## Criteria");
  });

  it("with --json and no --inline, prints {prompt}", async () => {
    const { exitCode, stdout } = await run(["handoff", "deliverable-chapter", "--json"], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { id: "deliverable-chapter" },
          prompts: { handoff: "Start writing." }
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const doc = JSON.parse(stdout);
    expect(doc.prompt).toBe("Start writing.");
    expect(doc.pack).toBeUndefined();
  });

  it("with --json and --inline, prints {prompt, pack}", async () => {
    const { exitCode, stdout } = await run(["handoff", "deliverable-chapter", "--json", "--inline"], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { id: "deliverable-chapter", title: "Chapter 3 draft" },
          prompts: { handoff: "Start writing." },
          criteria: [],
          steps: [],
          blockers: [],
          readiness: { eligible: true },
          sources: [],
          transcript: []
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const doc = JSON.parse(stdout);
    expect(doc.prompt).toBe("Start writing.");
    expect(doc.pack).toBeDefined();
  });
});

describe("deliverable: pick-up", () => {
  it("POSTs {kind:pick_up, tool:external tool} when --tool and env are both absent", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["pick-up", "deliverable-chapter"],
      {
        "/api/deliverables/deliverable-chapter/handoff": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { coordination: {}, row: {} } };
        },
        "/api/deliverables/deliverable-chapter/pack": {
          body: {
            deliverable: { id: "deliverable-chapter", title: "Chapter 3 draft" },
            criteria: [],
            steps: [],
            blockers: [],
            readiness: { eligible: true },
            sources: [],
            transcript: []
          }
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.kind).toBe("pick_up");
    expect(posted?.tool).toBe("external tool");
  });

  it("--tool overrides the default tool name", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(["pick-up", "deliverable-chapter", "--tool", "Claude Code"], {
      "/api/deliverables/deliverable-chapter/handoff": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: { coordination: {}, row: {} } };
      },
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { id: "deliverable-chapter" },
          criteria: [],
          steps: [],
          blockers: [],
          readiness: { eligible: true },
          sources: [],
          transcript: []
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.tool).toBe("Claude Code");
  });

  it("OPENRHEN_TOOL_NAME env var sets the tool name when --tool is absent", async () => {
    let posted: Record<string, unknown> | undefined;
    const savedEnv = process.env.OPENRHEN_TOOL_NAME;
    try {
      process.env.OPENRHEN_TOOL_NAME = "Codex CLI";
      const { exitCode } = await run(["pick-up", "deliverable-chapter"], {
        "/api/deliverables/deliverable-chapter/handoff": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: {} };
        },
        "/api/deliverables/deliverable-chapter/pack": {
          body: {
            deliverable: { id: "deliverable-chapter" },
            criteria: [],
            steps: [],
            blockers: [],
            readiness: { eligible: true },
            sources: [],
            transcript: []
          }
        }
      });
      expect(exitCode).toBe(EXIT.ok);
      expect(posted?.tool).toBe("Codex CLI");
    } finally {
      process.env.OPENRHEN_TOOL_NAME = savedEnv;
    }
  });

  it("after POST, GETs the pack and renders it", async () => {
    const { exitCode, stdout } = await run(["pick-up", "deliverable-chapter"], {
      "/api/deliverables/deliverable-chapter/handoff": {
        body: {}
      },
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { id: "deliverable-chapter", title: "Chapter 3 draft", status: "in_progress" },
          criteria: [],
          steps: [],
          blockers: [],
          readiness: { eligible: true },
          sources: [],
          transcript: []
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("Chapter 3 draft");
  });

  it("with --json, prints the pack JSON after POST", async () => {
    const { exitCode, stdout } = await run(["pick-up", "deliverable-chapter", "--json"], {
      "/api/deliverables/deliverable-chapter/handoff": { body: {} },
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { id: "deliverable-chapter", title: "Chapter 3 draft" },
          criteria: [],
          steps: [],
          blockers: [],
          readiness: { eligible: true },
          sources: [],
          transcript: []
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const doc = JSON.parse(stdout);
    expect(doc.deliverable).toBeDefined();
  });

  it("with --dry-run, prints payload and never POSTs", async () => {
    const { exitCode, stdout, calls } = await run(["pick-up", "deliverable-chapter", "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain('"dryRun": true');
    expect(stdout).toContain("/api/deliverables/deliverable-chapter/handoff");
    expect(calls.some((call) => call.path === "/api/deliverables/deliverable-chapter/handoff")).toBe(false);
  });
});

describe("deliverable: pack", () => {
  it("GETs the pack only (no POST)", async () => {
    const { exitCode, calls } = await run(["pack", "deliverable-chapter"], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { id: "deliverable-chapter", title: "Chapter 3 draft" },
          criteria: [],
          steps: [],
          blockers: [],
          readiness: { eligible: true },
          sources: [],
          transcript: []
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("--transcript non-numeric is a usage error before any network call", async () => {
    const { exitCode, calls } = await run(["pack", "deliverable-chapter", "--transcript", "abc"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.path.startsWith("/api/deliverables/"))).toBe(false);
  });

  it("--transcript negative is a usage error", async () => {
    const { exitCode, calls } = await run(["pack", "deliverable-chapter", "--transcript", "-5"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.path.startsWith("/api/deliverables/"))).toBe(false);
  });

  it("renders the pack by default with full transcript", async () => {
    const { exitCode, stdout } = await run(["pack", "deliverable-chapter"], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { id: "deliverable-chapter", title: "Chapter 3 draft" },
          criteria: [],
          steps: [],
          blockers: [],
          readiness: { eligible: true },
          sources: [],
          transcript: [
            { createdAt: "2026-09-03T09:00:00+10:00", role: "user", content: "First entry" },
            { createdAt: "2026-09-03T09:05:00+10:00", role: "assistant", content: "Second entry" }
          ]
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("First entry");
    expect(stdout).toContain("Second entry");
  });

  it("with --transcript N, caps the transcript to the last N rows", async () => {
    const { exitCode, stdout } = await run(["pack", "deliverable-chapter", "--transcript", "1"], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { id: "deliverable-chapter" },
          criteria: [],
          steps: [],
          blockers: [],
          readiness: { eligible: true },
          sources: [],
          transcript: [
            { createdAt: "2026-09-03T09:00:00+10:00", role: "user", content: "First" },
            { createdAt: "2026-09-03T09:05:00+10:00", role: "assistant", content: "Second" }
          ]
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("Second");
    expect(stdout).not.toContain("First");
  });

  it("with --json, prints the pack as JSON", async () => {
    const { exitCode, stdout } = await run(["pack", "deliverable-chapter", "--json"], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { id: "deliverable-chapter", title: "Chapter 3 draft" },
          criteria: [],
          steps: [],
          blockers: [],
          readiness: { eligible: true },
          sources: [],
          transcript: []
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const doc = JSON.parse(stdout);
    expect(doc.deliverable.title).toBe("Chapter 3 draft");
  });
});

describe("deliverable: note", () => {
  it("requires --text, no POST if missing", async () => {
    const { exitCode, calls } = await run(["note", "deliverable-chapter"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("POSTs {kind:note, tool, text} and prints confirmation", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode, stdout } = await run(["note", "deliverable-chapter", "--text", "Work in progress"], {
      "/api/deliverables/deliverable-chapter/handoff": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: { coordination: {}, row: {} } };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.kind).toBe("note");
    expect(posted?.text).toBe("Work in progress");
    expect(stdout).toContain("Note recorded");
  });

  it("with --json, prints the response as JSON", async () => {
    const { exitCode, stdout } = await run(["note", "deliverable-chapter", "--text", "Test", "--json"], {
      "/api/deliverables/deliverable-chapter/handoff": {
        body: { coordination: { tool: "test" }, row: { id: "row-1" } }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const doc = JSON.parse(stdout);
    expect(doc.coordination?.tool).toBe("test");
  });

  it("with --dry-run, prints payload and never POSTs", async () => {
    const { exitCode, stdout, calls } = await run(["note", "deliverable-chapter", "--text", "Test", "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain('"dryRun": true');
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("deliverable: drop-off", () => {
  it("POSTs {kind:drop_off, tool, text} with summary becoming text", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(["drop-off", "deliverable-chapter", "--summary", "Draft complete"], {
      "/api/deliverables/deliverable-chapter/handoff": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: {} };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.kind).toBe("drop_off");
    expect(posted?.text).toBe("Draft complete");
  });

  it("omitted --summary defaults to empty string", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(["drop-off", "deliverable-chapter"], {
      "/api/deliverables/deliverable-chapter/handoff": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: {} };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.text).toBe("");
  });

  it("with --dry-run, prints payload and never POSTs", async () => {
    const { exitCode, stdout, calls } = await run(["drop-off", "deliverable-chapter", "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain('"dryRun": true');
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("deliverable: export-sources", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openrhen-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("requires --dir, no GET if missing", async () => {
    const { exitCode, calls } = await run(["export-sources", "deliverable-chapter"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.path.startsWith("/api/deliverables/"))).toBe(false);
  });

  it("GETs the pack, downloads source files, and writes captured text", async () => {
    const { exitCode, stdout } = await run(["export-sources", "deliverable-chapter", "--dir", tempDir], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { id: "deliverable-chapter" },
          sources: [
            {
              title: "Research notes",
              id: "source-1",
              files: [
                {
                  id: "file-1",
                  filename: "notes.txt",
                  downloadPath: "/api/files/file-1",
                  mimeType: "text/plain",
                  byteSize: 100
                }
              ],
              capturedText: "Important findings"
            }
          ],
          criteria: [],
          steps: [],
          blockers: [],
          readiness: { eligible: true },
          transcript: []
        }
      },
      "/api/files/file-1": { body: "file content from download" }
    });
    expect(exitCode).toBe(EXIT.ok);
    const files = readdirSync(tempDir);
    expect(files).toHaveLength(2);
    expect(files).toContain("notes.txt");
    expect(files).toContain("Research notes.md");
    expect(stdout).toContain(tempDir);
  });

  it("writes downloaded file content and captured text to temp dir", async () => {
    const { exitCode } = await run(["export-sources", "deliverable-chapter", "--dir", tempDir], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { id: "deliverable-chapter" },
          sources: [
            {
              title: "Notes",
              id: "source-1",
              files: [
                {
                  filename: "data.txt",
                  downloadPath: "/api/files/data"
                }
              ],
              capturedText: "Captured text content"
            }
          ],
          criteria: [],
          steps: [],
          blockers: [],
          readiness: { eligible: true },
          transcript: []
        }
      },
      "/api/files/data": { body: "downloaded file data" }
    });
    expect(exitCode).toBe(EXIT.ok);
    const markdownFile = join(tempDir, "Notes.md");
    const content = readFileSync(markdownFile, "utf-8");
    expect(content).toBe("Captured text content");
  });

  it("refuses to write through a symbolic link already at an export path", async () => {
    const outside = mkdtempSync(join(tmpdir(), "openrhen-outside-"));
    try {
      symlinkSync(join(outside, "planted.txt"), join(tempDir, "notes.txt"));
      const { exitCode, stderr } = await run(["export-sources", "deliverable-chapter", "--dir", tempDir], {
        "/api/deliverables/deliverable-chapter/pack": {
          body: {
            deliverable: { id: "deliverable-chapter" },
            sources: [
              { title: "Notes", id: "source-1", files: [{ filename: "notes.txt", downloadPath: "/api/files/n" }] }
            ],
            criteria: [],
            steps: [],
            blockers: [],
            readiness: { eligible: true },
            transcript: []
          }
        },
        "/api/files/n": { body: "should never land outside --dir" }
      });
      expect(exitCode).toBe(EXIT.usage);
      expect(stderr).toContain("symbolic link");
      expect(existsSync(join(outside, "planted.txt"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("with --dry-run, returns note and never GETs/writes", async () => {
    const { exitCode, stdout } = await run(
      ["export-sources", "deliverable-chapter", "--dir", tempDir, "--dry-run"],
      {}
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain('"dryRun": true');
    expect(stdout).toContain("no write");
    const files = readdirSync(tempDir);
    expect(files).toHaveLength(0);
  });
});

describe("deliverable: complete-steps", () => {
  it("requires --steps, no POST if missing", async () => {
    const { exitCode, calls } = await run(["complete-steps", "deliverable-chapter"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("resolves step ids to their titles and POSTs mark_steps_complete", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(["complete-steps", "deliverable-chapter", "--steps", "step-outline,step-write"], {
      "/api/deliverables/deliverable-chapter/workspace": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: { summary: "Steps marked complete", applied: true, deliverable: {} } };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const call = posted?.call as Record<string, unknown>;
    expect(call?.name).toBe("mark_steps_complete");
    const completion = call?.completion as Record<string, unknown>;
    expect(completion?.stepTitles).toEqual(["Outline", "Write"]);
  });

  it("resolves step titles directly", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(["complete-steps", "deliverable-chapter", "--steps", "Outline,Write"], {
      "/api/deliverables/deliverable-chapter/workspace": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: { summary: "Done", applied: true, deliverable: {} } };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const completion = (posted?.call as Record<string, unknown>)?.completion as Record<string, unknown>;
    expect(completion?.stepTitles).toEqual(["Outline", "Write"]);
  });

  it("a step token that matches nothing exits notFound, no POST", async () => {
    const { exitCode, calls } = await run(["complete-steps", "deliverable-chapter", "--steps", "nonexistent"]);
    expect(exitCode).toBe(EXIT.notFound);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("mixes ids and titles correctly", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(["complete-steps", "deliverable-chapter", "--steps", "step-outline,Write"], {
      "/api/deliverables/deliverable-chapter/workspace": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: { summary: "Mixed resolved", applied: true, deliverable: {} } };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const completion = (posted?.call as Record<string, unknown>)?.completion as Record<string, unknown>;
    expect(completion?.stepTitles).toEqual(["Outline", "Write"]);
  });

  it("with --evidence, includes evidenceNote in the completion", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["complete-steps", "deliverable-chapter", "--steps", "step-outline", "--evidence", "Draft approved"],
      {
        "/api/deliverables/deliverable-chapter/workspace": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { summary: "Done", applied: true, deliverable: {} } };
        }
      }
    );
    expect(exitCode).toBe(EXIT.ok);
    const completion = (posted?.call as Record<string, unknown>)?.completion as Record<string, unknown>;
    expect(completion?.evidenceNote).toBe("Draft approved");
  });

  it("omitted --evidence defaults evidenceNote to empty string", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(["complete-steps", "deliverable-chapter", "--steps", "step-outline"], {
      "/api/deliverables/deliverable-chapter/workspace": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: { summary: "Done", applied: true, deliverable: {} } };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const completion = (posted?.call as Record<string, unknown>)?.completion as Record<string, unknown>;
    expect(completion?.evidenceNote).toBe("");
  });

  it("response with applied:false shows (already recorded) note in output", async () => {
    const { exitCode, stdout } = await run(["complete-steps", "deliverable-chapter", "--steps", "step-outline"], {
      "/api/deliverables/deliverable-chapter/workspace": {
        body: { summary: "Already recorded", applied: false, deliverable: {} }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("(already recorded)");
  });

  it("with --dry-run, prints the exact call payload", async () => {
    const { exitCode, stdout, calls } = await run([
      "complete-steps",
      "deliverable-chapter",
      "--steps",
      "step-outline",
      "--dry-run"
    ]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain('"dryRun": true');
    expect(stdout).toContain("mark_steps_complete");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("deliverable: record-blocker", () => {
  it("requires --description, no POST if missing", async () => {
    const { exitCode, calls } = await run([
      "record-blocker",
      "deliverable-chapter",
      "--category",
      "missing_information"
    ]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("requires --category, no POST if missing", async () => {
    const { exitCode, calls } = await run(["record-blocker", "deliverable-chapter", "--description", "Cannot proceed"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("POSTs record_blocker with description, category, and empty stepTitles when --steps omitted", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["record-blocker", "deliverable-chapter", "--description", "Missing data", "--category", "missing_information"],
      {
        "/api/deliverables/deliverable-chapter/workspace": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { summary: "Blocker recorded", applied: true, deliverable: {} } };
        }
      }
    );
    expect(exitCode).toBe(EXIT.ok);
    const report = (posted?.call as Record<string, unknown>)?.report as Record<string, unknown>;
    expect(report?.description).toBe("Missing data");
    expect(report?.category).toBe("missing_information");
    expect(report?.stepTitles).toEqual([]);
  });

  it("resolves --steps to step titles", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      [
        "record-blocker",
        "deliverable-chapter",
        "--description",
        "Bug found",
        "--category",
        "technical_problem",
        "--steps",
        "step-write"
      ],
      {
        "/api/deliverables/deliverable-chapter/workspace": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { summary: "Recorded", applied: true, deliverable: {} } };
        }
      }
    );
    expect(exitCode).toBe(EXIT.ok);
    const report = (posted?.call as Record<string, unknown>)?.report as Record<string, unknown>;
    expect(report?.stepTitles).toEqual(["Write"]);
  });

  it("invalid --category fails local validation with EXIT.validation, no POST", async () => {
    const { exitCode, calls } = await run([
      "record-blocker",
      "deliverable-chapter",
      "--description",
      "Test",
      "--category",
      "bogus_category"
    ]);
    expect(exitCode).toBe(EXIT.validation);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("with --proposed-resolution, includes it in the report", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      [
        "record-blocker",
        "deliverable-chapter",
        "--description",
        "Issue",
        "--category",
        "waiting_on_someone",
        "--proposed-resolution",
        "Ask supervisor by Friday"
      ],
      {
        "/api/deliverables/deliverable-chapter/workspace": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { summary: "Recorded", applied: true, deliverable: {} } };
        }
      }
    );
    expect(exitCode).toBe(EXIT.ok);
    const report = (posted?.call as Record<string, unknown>)?.report as Record<string, unknown>;
    expect(report?.proposedResolution).toBe("Ask supervisor by Friday");
  });

  it("omitted --proposed-resolution is absent from the report (not null)", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["record-blocker", "deliverable-chapter", "--description", "Test", "--category", "other"],
      {
        "/api/deliverables/deliverable-chapter/workspace": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { summary: "Recorded", applied: true, deliverable: {} } };
        }
      }
    );
    expect(exitCode).toBe(EXIT.ok);
    const report = (posted?.call as Record<string, unknown>)?.report as Record<string, unknown>;
    expect("proposedResolution" in report!).toBe(false);
  });
});

describe("deliverable: resolve-blocker", () => {
  it("requires --blocker, no POST if missing", async () => {
    const { exitCode, calls } = await run(["resolve-blocker", "deliverable-chapter"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("POSTs resolve_blocker with blockerDescription and default empty resolutionNote", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(["resolve-blocker", "deliverable-chapter", "--blocker", "Missing data"], {
      "/api/deliverables/deliverable-chapter/workspace": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: { summary: "Blocker resolved", applied: true, deliverable: {} } };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const call = posted?.call as Record<string, unknown>;
    expect(call?.name).toBe("resolve_blocker");
    const resolution = call?.resolution as Record<string, unknown>;
    expect(resolution?.blockerDescription).toBe("Missing data");
    expect(resolution?.resolutionNote).toBe("");
  });

  it("with --note, includes resolutionNote", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["resolve-blocker", "deliverable-chapter", "--blocker", "Missing data", "--note", "Data received"],
      {
        "/api/deliverables/deliverable-chapter/workspace": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { summary: "Resolved", applied: true, deliverable: {} } };
        }
      }
    );
    expect(exitCode).toBe(EXIT.ok);
    const resolution = (posted?.call as Record<string, unknown>)?.resolution as Record<string, unknown>;
    expect(resolution?.resolutionNote).toBe("Data received");
  });

  it("--feedback is included only when given (not null)", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["resolve-blocker", "deliverable-chapter", "--blocker", "Waiting", "--feedback", "Stakeholder approved"],
      {
        "/api/deliverables/deliverable-chapter/workspace": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { summary: "Resolved", applied: true, deliverable: {} } };
        }
      }
    );
    expect(exitCode).toBe(EXIT.ok);
    const resolution = (posted?.call as Record<string, unknown>)?.resolution as Record<string, unknown>;
    expect("feedback" in resolution!).toBe(true);
    expect(resolution?.feedback).toBe("Stakeholder approved");
  });

  it("omitted --feedback is absent from the payload (not null)", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(["resolve-blocker", "deliverable-chapter", "--blocker", "Waiting"], {
      "/api/deliverables/deliverable-chapter/workspace": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: { summary: "Resolved", applied: true, deliverable: {} } };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const resolution = (posted?.call as Record<string, unknown>)?.resolution as Record<string, unknown>;
    expect("feedback" in resolution!).toBe(false);
  });
});

describe("deliverable: approve", () => {
  it("POSTs start_carry_out with optional approvalNote", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(["approve", "deliverable-chapter", "--note", "Ready to proceed"], {
      "/api/deliverables/deliverable-chapter/workspace": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: { summary: "Approved", applied: true, deliverable: {} } };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const call = posted?.call as Record<string, unknown>;
    expect(call?.name).toBe("start_carry_out");
  });
});

describe("deliverable: begin-review", () => {
  it("POSTs begin_review", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(["begin-review", "deliverable-chapter"], {
      "/api/deliverables/deliverable-chapter/workspace": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: { summary: "Review begun", applied: true, deliverable: {} } };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const call = posted?.call as Record<string, unknown>;
    expect(call?.name).toBe("begin_review");
  });
});

describe("deliverable: extend-plan", () => {
  it("requires --from, no POST if missing", async () => {
    const { exitCode, calls } = await run(["extend-plan", "deliverable-chapter"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("reads JSON file and POSTs extend_plan with addition", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openrhen-test-"));
    try {
      const jsonFile = join(tempDir, "plan.json");
      writeFileSync(jsonFile, JSON.stringify({ steps: [{ title: "New step", expectedMinutes: 30 }] }));

      let posted: Record<string, unknown> | undefined;
      const { exitCode } = await run(["extend-plan", "deliverable-chapter", "--from", jsonFile], {
        "/api/deliverables/deliverable-chapter/workspace": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { summary: "Plan extended", applied: true, deliverable: {} } };
        }
      });
      expect(exitCode).toBe(EXIT.ok);
      const call = posted?.call as Record<string, unknown>;
      expect(call?.name).toBe("extend_plan");
      expect((call?.addition as Record<string, unknown>)?.steps).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("deliverable: add-to-breakdown", () => {
  it("requires --from, no POST if missing", async () => {
    const { exitCode, calls } = await run(["add-to-breakdown", "deliverable-chapter"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("reads JSON file and POSTs add_to_breakdown with addition", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openrhen-test-"));
    try {
      const jsonFile = join(tempDir, "breakdown.json");
      writeFileSync(jsonFile, JSON.stringify({ criteria: [] }));

      let posted: Record<string, unknown> | undefined;
      const { exitCode } = await run(["add-to-breakdown", "deliverable-chapter", "--from", jsonFile], {
        "/api/deliverables/deliverable-chapter/workspace": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { summary: "Added to breakdown", applied: true, deliverable: {} } };
        }
      });
      expect(exitCode).toBe(EXIT.ok);
      const call = posted?.call as Record<string, unknown>;
      expect(call?.name).toBe("add_to_breakdown");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("deliverable: record-review", () => {
  it("requires --from, no POST if missing", async () => {
    const { exitCode, calls } = await run(["record-review", "deliverable-chapter"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("reads JSON file and POSTs record_review with review", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openrhen-test-"));
    try {
      const jsonFile = join(tempDir, "review.json");
      writeFileSync(
        jsonFile,
        JSON.stringify({
          criteria: [{ title: "Correct citations", state: "satisfied", evidenceNote: "Checked all references" }]
        })
      );

      let posted: Record<string, unknown> | undefined;
      const { exitCode } = await run(["record-review", "deliverable-chapter", "--from", jsonFile], {
        "/api/deliverables/deliverable-chapter/workspace": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { summary: "Review recorded", applied: true, deliverable: {} } };
        }
      });
      expect(exitCode).toBe(EXIT.ok);
      const call = posted?.call as Record<string, unknown>;
      expect(call?.name).toBe("record_review");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("deliverable: submit", () => {
  it("requires --waiting-for, no POST if missing", async () => {
    const { exitCode, calls } = await run(["submit", "deliverable-chapter"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("POSTs submit_for_result with waitingFor, defaulting category to waiting_on_someone", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(["submit", "deliverable-chapter", "--waiting-for", "the marker to grade it"], {
      "/api/deliverables/deliverable-chapter/workspace": (call) => {
        posted = call.body as Record<string, unknown>;
        return { body: { summary: "Submitted", applied: true, deliverable: {} } };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    const call = posted?.call as Record<string, unknown>;
    expect(call?.name).toBe("submit_for_result");
    const submission = call?.submission as Record<string, unknown>;
    expect(submission?.waitingFor).toBe("the marker to grade it");
    expect(submission?.category).toBe("waiting_on_someone");
    expect("proposedResolution" in submission!).toBe(false);
  });

  it("includes --category and --proposed-resolution when given", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      [
        "submit",
        "deliverable-chapter",
        "--waiting-for",
        "the marker",
        "--category",
        "prerequisite",
        "--proposed-resolution",
        "They said Friday"
      ],
      {
        "/api/deliverables/deliverable-chapter/workspace": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { summary: "Submitted", applied: true, deliverable: {} } };
        }
      }
    );
    expect(exitCode).toBe(EXIT.ok);
    const submission = (posted?.call as Record<string, unknown>)?.submission as Record<string, unknown>;
    expect(submission?.category).toBe("prerequisite");
    expect(submission?.proposedResolution).toBe("They said Friday");
  });
});

describe("deliverable: next", () => {
  it("prints the current directive's deliverable with one pack fetch, no candidate scan", async () => {
    const raw = fixtureRawState() as Record<string, unknown>;
    const planning = raw.planning as Record<string, unknown>;
    const result = planning.result as Record<string, unknown>;
    result.currentDirective = {
      kind: "deliverable",
      targetId: "deliverable:deliverable-chapter",
      title: "Chapter 3 draft",
      recommendedMinutes: 30
    };
    const { exitCode, stdout, calls } = await run(
      ["next"],
      {
        "/api/deliverables/deliverable-chapter/pack": {
          body: {
            deliverable: { title: "Chapter 3 draft", phase: "Carry out", status: "in_progress" },
            prompts: { handoff: "Pick up Chapter 3 draft." }
          }
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("Chapter 3 draft");
    expect(stdout).toContain("the current directive");
    expect(stdout).toContain("Pick up Chapter 3 draft.");
    expect(calls.filter((call) => call.path.endsWith("/pack")).length).toBe(1);
  });

  it("falls back to the highest-ranked eligible in_progress deliverable when there is no deliverable directive", async () => {
    const { exitCode, stdout } = await run(["next"], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: {
          deliverable: { title: "Chapter 3 draft", phase: "Carry out", status: "in_progress" },
          readiness: { eligible: true },
          prompts: { handoff: "Pick up Chapter 3 draft." }
        }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("Chapter 3 draft");
    expect(stdout).not.toContain("the current directive");
  });

  it("reports nothing eligible when no in_progress deliverable's pack says it is", async () => {
    const { exitCode, stdout } = await run(["next"], {
      "/api/deliverables/deliverable-chapter/pack": {
        body: { deliverable: {}, readiness: { eligible: false } }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("No deliverable is currently eligible");
  });
});

describe("deliverable: inline payload and undo", () => {
  const WORKSPACE = "/api/deliverables/deliverable-chapter/workspace";

  it("takes the move's JSON inline with --payload, and refuses it together with --from", async () => {
    let posted: Record<string, unknown> | undefined;
    const ok = await run(
      [
        "extend-plan",
        "deliverable-chapter",
        "--payload",
        JSON.stringify({ steps: [{ title: "New", expectedMinutes: 20 }] })
      ],
      {
        [WORKSPACE]: (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { summary: "Plan extended", applied: true, deliverable: {} } };
        }
      }
    );
    expect(ok.exitCode).toBe(EXIT.ok);
    const sent = posted as unknown as { call: { addition: { steps: unknown[] } } };
    expect(sent.call.addition.steps).toHaveLength(1);

    const both = await run(["extend-plan", "deliverable-chapter", "--payload", "{}", "--from", "x.json"]);
    expect(both.exitCode).toBe(EXIT.usage);
    const bad = await run(["record-review", "deliverable-chapter", "--payload", "{not json"]);
    expect(bad.exitCode).toBe(EXIT.usage);
    expect(bad.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("sends a command id and journals a revertible move as one server-checked entry", async () => {
    const journal = memoryJournal();
    const calls: RecordedCall[] = [];
    const exitCode = await runCli(["deliverable", "complete-steps", "deliverable-chapter", "--steps", "step-outline"], {
      stdout: () => undefined,
      stderr: () => undefined,
      env: {},
      readConfigFile: () => null,
      now: () => fixtureNow,
      journal,
      fetchImpl: fakeFetch(
        {
          "/api/state": { body: { state: fixtureRawState() } },
          [WORKSPACE]: (call) => ({
            body: {
              summary: "Marked complete",
              applied: true,
              deliverable: {},
              revertible: (call.body as { commandId: string }).commandId
            }
          })
        },
        calls
      )
    });
    expect(exitCode).toBe(EXIT.ok);
    const sent = calls.find((call) => call.path === WORKSPACE)!.body as { commandId: string };
    expect(sent.commandId).toBeTruthy();
    expect(journal.read()).toHaveLength(1);
    expect(journal.read()[0]).toMatchObject({
      serverChecked: true,
      undo: { path: "/api/commands/revert", payload: { target: sent.commandId, direction: "undo" } }
    });
  });

  it("journals nothing when the portal kept no rows (a move that changed nothing)", async () => {
    const journal = memoryJournal();
    const exitCode = await runCli(["deliverable", "begin-review", "deliverable-chapter"], {
      stdout: () => undefined,
      stderr: () => undefined,
      env: {},
      readConfigFile: () => null,
      now: () => fixtureNow,
      journal,
      fetchImpl: fakeFetch(
        {
          "/api/state": { body: { state: fixtureRawState() } },
          [WORKSPACE]: { body: { summary: "Already", applied: false, deliverable: {} } }
        },
        []
      )
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(journal.read()).toHaveLength(0);
  });
});
