import { MCP_TOOL_MANIFEST, SAVE_ENTITY_KINDS, buildNeeds, entityFieldNames, type Need } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { parseCommandArgs } from "../src/command.js";
import { findEntityType, withKnownFields } from "../src/commands/save.js";
import { EXIT } from "../src/errors.js";
import { commands } from "../src/registry.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureActiveSession, fixtureNow, fixtureRawState, fixtureState } from "./fixture-state.js";

/**
 * Every need `buildNowAnswer` can raise carries the way to settle it (the fact freshness design note, "The
 * needs list"): the MCP tool, the action, the fields the person supplies, and the command line. They are strings
 * written beside the engine, so nothing else stops one drifting from the CLI that has to run it. This builds a
 * need from each stale fact, then holds its answer to the real registry (strict flags), the real MCP manifest
 * and, for a save, the field check `save` applies, and finally runs it as a dry run against the fixture state.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(fixtureNow.getTime() - ms).toISOString();
const STUDY_ROOM = { id: "ctx-study", name: "Study Room", kind: "location", address: "3 Example Street" };

/** The state with a place that has a space in its name, so the quoting of `arrive "<place>"` is exercised too. */
function rawWithStudyRoom(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = fixtureRawState();
  return {
    ...raw,
    conditionDefinitions: [...(raw.conditionDefinitions as unknown[]), STUDY_ROOM],
    ...overrides
  };
}

const settings = (overrides: Record<string, unknown> = {}) => ({
  ...(fixtureRawState().settings as Record<string, unknown>),
  ...overrides
});

const dated = { locationId: "ctx-study", locationSetAt: ago(HOUR), energySetAt: ago(HOUR) };

interface Case {
  label: string;
  fact: Need["fact"];
  overrides: Record<string, unknown>;
  /** The stored plan's schedule, which says which projects are at risk (effort needs read it). */
  schedule?: unknown;
}

/** The fixture's actions, with one estimate set `age` ago. */
const actionsWithEstimateAged = (id: string, age: number) =>
  (fixtureRawState().actions as Record<string, unknown>[]).map((action) =>
    action.id === id ? { ...action, remainingSetAt: ago(age) } : action
  );

const cases: Case[] = [
  {
    label: "an action session left open",
    fact: "session_end",
    overrides: {
      ...fixtureActiveSession(),
      activeSession: {
        ...(fixtureActiveSession().activeSession as Record<string, unknown>),
        startedAt: ago(19 * HOUR),
        plannedEndAt: ago(18 * HOUR),
        segmentStartedAt: ago(19 * HOUR)
      }
    }
  },
  {
    label: "an action session paused and left",
    fact: "session_end",
    overrides: {
      activeSession: {
        ...(fixtureActiveSession().activeSession as Record<string, unknown>),
        status: "paused",
        startedAt: ago(7 * HOUR),
        plannedEndAt: ago(6 * HOUR),
        pausedAt: ago(5 * HOUR),
        segmentStartedAt: undefined
      }
    }
  },
  {
    label: "a routine step left open",
    fact: "session_end",
    overrides: {
      activeSession: {
        ...(fixtureActiveSession().activeSession as Record<string, unknown>),
        targetType: "routine_step",
        startedAt: ago(9 * HOUR),
        plannedEndAt: ago(8 * HOUR),
        segmentStartedAt: ago(9 * HOUR)
      }
    }
  },
  {
    label: "a commitment left open",
    fact: "session_end",
    overrides: {
      activeSession: {
        ...(fixtureActiveSession().activeSession as Record<string, unknown>),
        targetType: "fixed_commitment",
        startedAt: ago(9 * HOUR),
        plannedEndAt: ago(8 * HOUR),
        segmentStartedAt: ago(9 * HOUR)
      }
    }
  },
  {
    label: "a place said three days ago",
    fact: "location",
    overrides: {
      currentSituation: { ...dated, locationSetAt: ago(3 * DAY) },
      conditionDefinitions: rawWithStudyRoom().conditionDefinitions
    }
  },
  {
    label: "a wake from a month ago",
    fact: "wake",
    overrides: { settings: settings({ lastWokeAt: ago(30 * DAY) }), currentSituation: dated }
  },
  {
    label: "energy said three days ago",
    fact: "energy",
    overrides: {
      currentSituation: { ...dated, energySetAt: ago(3 * DAY) },
      conditionDefinitions: rawWithStudyRoom().conditionDefinitions
    }
  },
  {
    label: "an estimate set three weeks ago on a project that is at risk",
    fact: "effort",
    schedule: {
      forecasts: [{ projectId: "project-thesis", health: "at_risk", agedInputs: [{ actionId: "action-draft" }] }]
    },
    overrides: { actions: actionsWithEstimateAged("action-draft", 21 * DAY), currentSituation: dated }
  },
  {
    label: "energy never dated",
    fact: "energy",
    overrides: {
      currentSituation: { locationId: "ctx-study", locationSetAt: ago(HOUR) },
      conditionDefinitions: rawWithStudyRoom().conditionDefinitions
    }
  }
];

function needFor({ overrides, fact, label, schedule }: Case): Need {
  const state = fixtureState({ conditionDefinitions: rawWithStudyRoom().conditionDefinitions, ...overrides });
  const names = new Map(state.conditionDefinitions.map((definition) => [definition.id, definition.name]));
  const need = buildNeeds({ state, currentDirective: undefined, schedule, now: fixtureNow }, names).find(
    (item) => item.fact === fact
  );
  if (!need) throw new Error(`${label}: no ${fact} need was raised`);
  return need;
}

/** A placeholder in an answer's command line, replaced by a real value of the kind it names. */
function filled(cli: string): string {
  return cli.replace(/<([^>]+)>/g, (_whole, name: string) => {
    if (name === "time") return "2026-09-03T09:20:00+10:00";
    if (name === "minutes") return "90";
    // An enumeration written `<a|b|c>`: any one of its values.
    if (name.includes("|")) return name.split("|")[0]!;
    throw new Error(`No example value for the placeholder <${name}> in "${cli}"`);
  });
}

/** Splits a command line the way a shell would, for the one quoting an answer uses: a JSON string. */
function tokens(line: string): string[] {
  return (line.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map((token) =>
    token.startsWith('"') ? (JSON.parse(token) as string) : token
  );
}

const kebab = (field: string) => field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

async function dryRun(argv: string[], rawState: Record<string, unknown>) {
  const calls: RecordedCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli([...argv, "--dry-run"], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: rawState } } }, calls)
  });
  return { exitCode, output: [...stdout, ...stderr].join("\n"), calls };
}

describe("a need's answer", () => {
  it("is covered for every fact the freshness rule raises", () => {
    expect([...new Set(cases.map((item) => item.fact))].sort()).toEqual([
      "effort",
      "energy",
      "location",
      "session_end",
      "wake"
    ]);
  });

  for (const item of cases) {
    describe(item.label, () => {
      const need = needFor(item);
      const [program, name = "", ...rest] = tokens(filled(need.answer.cli));
      const spec = commands.find((command) => command.name === name);

      it("is a command line the real registry parses with strict flags", () => {
        expect(program).toBe("rhen");
        expect(spec, `no command "${name}"`).toBeDefined();
        const parsed = parseCommandArgs(spec!, rest);
        const required = spec!.positionals.filter((positional) => positional.required).length;
        expect(parsed.positionals.length).toBeGreaterThanOrEqual(required);
        for (const [index, positional] of spec!.positionals.entries()) {
          if (positional.enum && parsed.positionals[index] !== undefined)
            expect(positional.enum, positional.name).toContain(parsed.positionals[index]);
        }
      });

      it("names an MCP tool in the manifest, for the same command", () => {
        const tool = MCP_TOOL_MANIFEST.find((entry) => entry.name === need.answer.tool);
        expect(tool, `no tool "${need.answer.tool}"`).toBeDefined();
        expect(tool!.command).toBe(name);
      });

      it("names fields that tool accepts, and an action that is the one the command line runs", () => {
        const tool = MCP_TOOL_MANIFEST.find((entry) => entry.name === need.answer.tool)!;
        // Only a paused session asks nothing: its end is the pause, and the server refuses it another one
        // (`resolveRetroactiveEnd`), so its answer must not name `--ended-at`.
        const paused = need.fact === "session_end" && need.question.startsWith("Paused");
        expect(need.answer.fields.length > 0).toBe(!paused);
        if (paused) expect(rest).not.toContain("--ended-at");
        if (name === "save") {
          // `rhen_save` takes the kind as `entityType` and the fields as an open object that `save` checks
          // against the kind's own list: the kind is the action.
          const kind = findEntityType(rest[0] ?? "");
          expect(kind?.canonical).toBe(need.answer.action);
          expect(SAVE_ENTITY_KINDS).toContain(need.answer.action);
          const known = entityFieldNames(need.answer.action as (typeof SAVE_ENTITY_KINDS)[number]);
          for (const field of need.answer.fields) expect(known, `${field} on ${need.answer.action}`).toContain(field);
          // And every `--set` it tells the person to send passes the check `save` applies before sending.
          const sets = rest.flatMap((token, index) => (rest[index - 1] === "--set" ? [token] : []));
          expect(sets.length).toBeGreaterThan(0);
          for (const set of sets) {
            const key = set.slice(0, set.indexOf("=")).split(".")[0]!;
            expect(() => withKnownFields(kind!, { [key]: "x" }), `--set ${set}`).not.toThrow();
          }
          for (const field of need.answer.fields)
            expect(
              sets.some((set) => set.startsWith(`${field}=`)),
              `${field} is settable in ${need.answer.cli}`
            ).toBe(true);
        } else {
          for (const field of need.answer.fields) {
            const positional = spec!.positionals.some((entry) => entry.name === field);
            // A flag over MCP is a kebab-case property of the tool, as it is on the command line.
            const flagged = Object.hasOwn(tool.inputSchema.properties, kebab(field));
            expect(positional || flagged, `${field} on ${need.answer.tool}`).toBe(true);
            if (!positional) expect(rest, `--${kebab(field)} in ${need.answer.cli}`).toContain(`--${kebab(field)}`);
          }
          expect([name, rest[0]]).toContain(need.answer.action);
        }
      });

      it("runs as a dry run against a state that has what it names, and sends nothing", async () => {
        const raw = rawWithStudyRoom(need.fact === "session_end" ? item.overrides : {});
        const { exitCode, output, calls } = await dryRun([name, ...rest], raw);
        expect(exitCode, output).toBe(EXIT.ok);
        expect(calls.some((call) => call.method === "POST")).toBe(false);
      });
    });
  }
});
