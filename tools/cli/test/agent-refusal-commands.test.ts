import {
  classifiedRoutes,
  hardFloorInstead,
  hardFloorReason,
  scopesForRoute,
  type HardFloorCall
} from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { parseCommandArgs } from "../src/command.js";
import { findEntityType } from "../src/commands/save.js";
import { commands } from "../src/registry.js";

/**
 * Refusal text in `platform/contracts` names `rhen` commands for an agent to run instead. The contracts
 * package cannot import this one, so this test holds each named command to the registry: it exists, takes the
 * subcommand or action named, and parses with exactly those flags.
 */

/** Every way onto the hard floor, one call each (the contracts test holds the same list to its wording). */
const FLOORED: HardFloorCall[] = [
  { tool: "span", action: "remove" },
  { tool: "save", entityType: "sleep_log_entry", remove: true },
  ...["area", "outcome", "project", "action", "commitment", "capture", "routine_preset", "condition_definition"].map(
    (entityType) => ({ tool: "save", entityType, remove: true })
  ),
  { tool: "import", action: "delete" },
  { tool: "recurrence", action: "end" },
  { tool: "recurrence", action: "end", entityType: "action" },
  { tool: "inbox-act", room: "kept", action: "drop" },
  { tool: "save", entityType: "settings", settingsFields: ["timezone", "sessionBreakMinutes"] },
  { tool: "bulk", entityType: "action", rowCount: 21 },
  { tool: "save", entityType: "commitment", touchesPeople: true }
];

/** The `rhen ...` commands a piece of refusal text puts in backticks. */
const commandsIn = (text: string): string[] => [...text.matchAll(/`(rhen [^`]+)`/g)].map((match) => match[1]!);

/** The refusals a route table gives, for every classified route and the bodies that decide an entity write. */
function routeRefusals(): string[] {
  const messages: string[] = [];
  const bodies: unknown[] = [
    undefined,
    {},
    { entityType: "mystery", entity: {} },
    { entityType: "capture", entity: { status: "confirmed" } },
    { entityType: "deliverable_contract_review", entity: {} },
    { kind: "entity_command", payload: { command: "save_entity", body: {} } }
  ];
  for (const entry of classifiedRoutes()) {
    const [method, route] = entry.split(" ") as [string, string];
    for (const body of bodies) {
      const decision = scopesForRoute(method, route, body);
      if (decision.kind === "refused") messages.push(decision.message);
    }
  }
  return messages;
}

/** Whether the command's own help names `word` as a subcommand or action (`room` narrows `inbox-act` to one room). */
function namesSubcommand(spec: (typeof commands)[number], word: string, room?: string): boolean {
  const positionals = spec.positionals.map((positional) => positional.description);
  if (room !== undefined) {
    const line = positionals.find((description) => description.includes(`${room}: `)) ?? "";
    const actions = line.split(";").find((part) => part.trim().startsWith(`${room}:`)) ?? "";
    return new RegExp(`\\b${word}\\b`).test(actions);
  }
  return positionals.some((description) => new RegExp(`\\b${word}\\b`).test(description));
}

function checkCommand(text: string): void {
  const [program, name, ...rest] = text.split(/\s+/);
  expect(program, text).toBe("rhen");
  const spec = commands.find((candidate) => candidate.name === name);
  expect(spec, `${text}: no such command`).toBeDefined();
  // Parsing is strict, so a flag the command does not have throws.
  const parsed = parseCommandArgs(spec!, rest);
  const [first, second] = parsed.positionals;
  if (name === "save") {
    expect(findEntityType(first ?? ""), `${text}: unknown entity type ${first}`).toBeDefined();
  } else if (name === "inbox-act") {
    expect(namesSubcommand(spec!, second ?? "", first), `${text}: no such inbox-act action`).toBe(true);
  } else if (spec!.positionals[0]?.name === "subcommand" || spec!.positionals[0]?.name === "action") {
    expect(namesSubcommand(spec!, first ?? ""), `${text}: no such subcommand ${first}`).toBe(true);
  }
}

describe("the commands refusal text tells an agent to run", () => {
  it("exist, with the subcommands and flags named", () => {
    const named = new Set<string>();
    for (const call of FLOORED) {
      const instead = hardFloorInstead(call);
      expect(instead, JSON.stringify(call)).not.toBeNull();
      if (instead!.startsWith("rhen ")) named.add(instead!);
      for (const command of commandsIn(hardFloorReason(call) ?? "")) named.add(command);
    }
    for (const message of routeRefusals()) for (const command of commandsIn(message)) named.add(command);
    // The floor alone names at least the span, import, recurrence, kept and save paths.
    expect(named.size).toBeGreaterThan(8);
    for (const command of named) checkCommand(command);
  });

  it("is checked against the real registry, so a made-up flag or subcommand fails", () => {
    expect(() => checkCommand("rhen span set <span> --finish YYYY-MM-DD")).toThrow();
    expect(() => checkCommand("rhen span reshape <span> --end YYYY-MM-DD")).toThrow();
    expect(() => checkCommand("rhen save sleep_log_entries --id <id>")).toThrow();
    expect(() => checkCommand("rhen inbox-act kept forget <id>")).toThrow();
    expect(() => checkCommand("rhen gone-command --yes")).toThrow();
  });
});
