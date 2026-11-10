import type { AgentCall } from "../agent-error.js";
import { formatRequirementKey, parseRequirementKey, type RequirementTag } from "./requirement-key.js";
import type { ConditionDefinition } from "./context-model.js";

/**
 * The `requires` shorthand an agent writes on an action or a step: a flat list read as "all of these".
 * Ids may be places, capabilities or live conditions as they are; a person must say how: `pete@with`
 * (physically with you) or `pete@remote` (contactable). Nothing is guessed, and nothing is half-saved: a
 * list with any problem is refused whole, with every problem named and the exact next call.
 */

/** The fields of a condition definition this check reads. */
export type RequirementDefinition = Pick<ConditionDefinition, "id" | "name" | "kind" | "status" | "channels">;

export const REQUIRES_MAX = 12;

export type RequiresProblemCode =
  | "blank"
  | "not_text"
  | "too_many"
  | "unknown_id"
  | "archived"
  | "bare_person"
  | "tag_on_non_person"
  | "no_remote_channel"
  | "conflicting_tags";

export interface RequiresProblem {
  code: RequiresProblemCode;
  key: string;
  message: string;
  nextCall?: AgentCall;
}

export type RequiresResult =
  | { ok: true; keys: string[] }
  | {
      ok: false;
      message: string;
      problems: RequiresProblem[];
      nextCall?: AgentCall;
      validValues: { ids: string[] };
    };

const WITH_OR_REMOTE = "write {id}@with (physically with you) or {id}@remote (just contactable by call or message)";

/** A guess at an id for a name, only ever offered as a suggestion for the agent to confirm. */
function suggestedId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const titleCase = (raw: string): string => {
  const words = raw.trim().replace(/[-_]+/g, " ");
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : raw;
};

export function resolveRequires(
  requires: readonly unknown[],
  definitions: readonly RequirementDefinition[]
): RequiresResult {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const known = [...byId.values()]
    .filter((definition) => definition.status !== "archived")
    .map((d) => d.id)
    .sort();
  const problems: RequiresProblem[] = [];
  const keys: string[] = [];
  const tagsByPerson = new Map<string, Set<RequirementTag>>();

  if (requires.length > REQUIRES_MAX)
    problems.push({
      code: "too_many",
      key: "",
      message: `requires lists ${requires.length} conditions; the most it takes is ${REQUIRES_MAX}. Split the work into steps that each need fewer.`
    });

  for (const entry of requires) {
    if (typeof entry !== "string") {
      problems.push({
        code: "not_text",
        key: String(entry),
        message: `requires takes text ids such as "garage" or "pete@with", but got ${JSON.stringify(entry)}, which is not text.`
      });
      continue;
    }
    const key = entry.trim();
    if (!key) {
      problems.push({ code: "blank", key, message: "requires has a blank entry; remove it or give an id." });
      continue;
    }
    const parsed = parseRequirementKey(key, (id) => byId.has(id));
    const definition = byId.get(parsed.id);

    if (!definition) {
      const suggestion = suggestedId(parsed.id) || "<lowercase-id>";
      const name = titleCase(parsed.id);
      problems.push({
        code: "unknown_id",
        key,
        message:
          `"${parsed.id}" is not a place, capability or contact you have. ` +
          (parsed.tag
            ? `If ${name} is a person only mentioned in notes, create a name-only contact from notes, then repeat this call. `
            : `If it is a person only mentioned in notes, create a name-only contact from notes first (then write ${suggestion}@with or ${suggestion}@remote); if it is a place or capability, list the ones you have with rhen_list entity condition-definitions. `) +
          `Do not invent an id.`,
        nextCall: parsed.tag
          ? {
              tool: "rhen_save",
              arguments: {
                entityType: "condition_definition",
                id: suggestion,
                create: true,
                fields: { name, kind: "contact" },
                basis: "stated",
                evidence: "<the owner's words naming this person, or the note that does>"
              },
              note: "a name-only contact (no phone, email or channels); then repeat this call"
            }
          : {
              tool: "rhen_list",
              arguments: { entity: "condition-definitions", limit: 50 },
              note: "the ids you may require"
            }
      });
      continue;
    }
    if (definition.status === "archived") {
      problems.push({
        code: "archived",
        key,
        message: `${definition.name} ("${definition.id}") is archived, so nothing can require it. Restore it first (rhen_save condition_definition with status active) or pick another.`
      });
      continue;
    }

    if (definition.kind === "contact") {
      if (!parsed.tag) {
        problems.push({
          code: "bare_person",
          key,
          message: `${definition.id} is a person: ${WITH_OR_REMOTE.replaceAll("{id}", definition.id)}. If the owner said "with ${definition.name}", that means ${definition.id}@with.`
        });
        continue;
      }
      if (parsed.tag === "remote") {
        const remote = definition.channels.some((channel) => channel !== "in_person");
        if (!remote) {
          problems.push({
            code: "no_remote_channel",
            key,
            message: definition.channels.length
              ? `${definition.name} can only be met in person (their channel is in_person), so ${key} could never be met. Write ${definition.id}@with instead.`
              : `There is no way to reach ${definition.name} recorded (no call or message channel), so ${key} could not be met. Write ${definition.id}@with if you need them with you, or record how to reach them first (rhen_save condition_definition id ${definition.id} with channels).`
          });
          continue;
        }
      }
      const seen = tagsByPerson.get(definition.id) ?? new Set<RequirementTag>();
      seen.add(parsed.tag);
      tagsByPerson.set(definition.id, seen);
    } else if (parsed.tag) {
      problems.push({
        code: "tag_on_non_person",
        key,
        message: `${definition.id} is not a person (it is a ${definition.kind}), so it takes no tag: write ${definition.id}, not ${key}.`
      });
      continue;
    }
    const final = formatRequirementKey(parsed.id, parsed.tag);
    if (!keys.includes(final)) keys.push(final);
  }

  for (const [person, tags] of tagsByPerson)
    if (tags.size > 1)
      problems.push({
        code: "conflicting_tags",
        key: person,
        message: `${person} is required both with you and remotely (${person}@with and ${person}@remote). Pick one: ${person}@with if they must be physically there.`
      });

  if (problems.length) {
    const first = problems.find((problem) => problem.nextCall !== undefined);
    return {
      ok: false,
      message:
        problems.map((problem) => problem.message).join(" ") +
        " Nothing was saved; fix these and send the whole requires list again.",
      problems,
      ...(first?.nextCall ? { nextCall: first.nextCall } : {}),
      validValues: { ids: known }
    };
  }
  return { ok: true, keys };
}
