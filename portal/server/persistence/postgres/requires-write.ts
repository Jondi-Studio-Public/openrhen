import { resolveRequires, type RequirementDefinition } from "@openrhen/contracts";
import { InvalidCommandError } from "./command-errors";
import type { Sql } from "./sql-pool";

/**
 * The `requires` shorthand on an action or a step, resolved inside the caller's transaction against the
 * owner's own conditions. It runs before the save touches a row, so a refusal leaves the old pathways exactly
 * as they were (nothing is half-written), and it reads the conditions the same transaction can see, so a
 * contact created earlier in the same changeset counts.
 */

export async function readRequirementDefinitions(tx: Sql, userId: string): Promise<RequirementDefinition[]> {
  const rows = await tx<
    { id: string; name: string; kind: string; status: string; channels: unknown }[]
  >`SELECT id, name, kind, status, channels FROM condition_definitions WHERE user_id=${userId}`;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind as RequirementDefinition["kind"],
    status: row.status as RequirementDefinition["status"],
    channels: (Array.isArray(row.channels) ? row.channels : []) as RequirementDefinition["channels"]
  }));
}

/** The stored alternative routes of the given actions, each as the keys it holds, in route order. */
export async function readStoredRoutes(tx: Sql, actionIds: readonly string[]): Promise<Map<string, string[][]>> {
  const routes = new Map<string, string[][]>();
  if (!actionIds.length) return routes;
  const rows = await tx<
    { action_id: string; pathway_id: string; context_key: string }[]
  >`SELECT rp.action_id, rp.id AS pathway_id, req.context_key FROM action_requirement_pathways rp
      JOIN action_requirements req ON req.pathway_id=rp.id
      WHERE rp.action_id = ANY(${[...actionIds]}) ORDER BY rp.action_id, rp.sort_order, req.context_key`;
  const byPathway = new Map<string, { action: string; keys: string[] }>();
  for (const row of rows) {
    const entry = byPathway.get(row.pathway_id) ?? { action: row.action_id, keys: [] };
    entry.keys.push(row.context_key);
    byPathway.set(row.pathway_id, entry);
  }
  for (const { action, keys } of byPathway.values()) routes.set(action, [...(routes.get(action) ?? []), keys]);
  return routes;
}

/**
 * The one route a `requires` list means: `[[keys]]`, or `[]` when it clears. Refuses, naming every problem and
 * the exact next call, when a key is not valid; and refuses to flatten an action that already offers more than
 * one alternative route, because `requires` is all-of and would silently destroy the "either" it had.
 */
export function routesFromRequires(
  requires: readonly unknown[],
  definitions: readonly RequirementDefinition[],
  storedRoutes: readonly string[][],
  subject: { id: string; title?: string; tool: "action" | "deliverable" }
): string[][] {
  const resolved = resolveRequires(requires, definitions);
  if (!resolved.ok)
    throw new InvalidCommandError(resolved.message, {
      ...(resolved.nextCall ? { nextCall: resolved.nextCall } : {}),
      validValues: resolved.validValues
    });
  if (storedRoutes.length > 1) {
    const shown = storedRoutes.map((route) => `[${route.join(", ")}]`).join(" OR ");
    const name = subject.title ? `"${subject.title}" (${subject.id})` : `"${subject.id}"`;
    throw new InvalidCommandError(
      `${name} already has ${storedRoutes.length} alternative routes (any one of them is enough): ${shown}. ` +
        "requires means all of these at once, so sending it would replace the alternatives with a single route. Nothing was saved. " +
        (subject.tool === "action"
          ? "Keep them as they are, or send requirementPathways with the exact routes you want (a list of routes, any one enough, every id inside a route needed), " +
            "with a person written as id@with or id@remote; or clear them first with requires [] and then send requires."
          : "Keep them as they are, or send the step's requirementPathways with the exact routes you want, with a person written as id@with or id@remote."),
      {
        nextCall: {
          tool: "rhen_save",
          arguments: {
            entityType: subject.tool === "action" ? "action" : "deliverable",
            id: subject.id,
            fields: { requirementPathways: [["<id>", "<id>@with"]] }
          },
          note: "replace the routes explicitly; any one route is enough, all ids inside a route are needed"
        }
      }
    );
  }
  return resolved.keys.length ? [resolved.keys] : [];
}
