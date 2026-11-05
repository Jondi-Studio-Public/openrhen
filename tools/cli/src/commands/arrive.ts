import { planningEntityCommandSchema } from "@openrhen/contracts";
import type { PortalState } from "../client.js";
import { requirePositional, type CommandContext, type CommandSpec } from "../command.js";
import { entityItems, findEntity, type AnyRecord } from "../entities.js";
import { CliError, EXIT } from "../errors.js";
import { toJson } from "../output.js";
import { commandIdOf, newCommandId, postCommand } from "../write.js";

/**
 * Resolves a place by id or exact, case-insensitive name against active location conditions. Reuses
 * the same "conditions" entity `save`/`show`/`list` use (see entities.ts) rather than a separate
 * lookup, but narrows the candidates to `kind: "location"` first — "arrive gym" must not match a
 * capability, contact, or commitment condition that happens to share the name.
 */
export function resolveLocation(state: PortalState, query: string): AnyRecord {
  const entity = findEntity("conditions");
  if (!entity) throw new CliError('Unknown entity "conditions".', EXIT.usage);
  const locations = entityItems(state, entity).filter((item) => item.kind === "location");
  const byId = locations.find((item) => item.id === query);
  if (byId) return byId;
  const wanted = query.trim().toLowerCase();
  const byName = locations.find((item) => typeof item.name === "string" && item.name.toLowerCase() === wanted);
  if (byName) return byName;
  throw new CliError(
    `No location with id or name "${query}". To list the saved places, run \`rhen list places\` and use an id or name from it.`,
    EXIT.notFound
  );
}

/**
 * Builds the exact `current_availability` write the portal's one-tap `ArrivalButton` sends
 * (`situationCommand` in portal/components/situation-panel.tsx): the legacy `currentEnergy`/
 * `assertedConditions` pair travels alongside the location so a location-only write never trips the
 * server's "Current energy is required" check on this row (`entity-commands.ts`'s
 * `current_availability` handler), and `expectedVersion` reads the shared `user_preferences` row's
 * version off `settings.version` — the same row `current_availability` itself is stored on.
 */
function buildArriveCommand(state: PortalState, locationId: string) {
  return {
    commandId: newCommandId(),
    expectedVersion: typeof state.settings.version === "number" ? state.settings.version : null,
    type: "save_entity" as const,
    entityType: "current_availability" as const,
    entity: {
      currentEnergy: state.currentEnergy,
      assertedConditions: state.assertedConditions,
      currentSituation: { locationId }
    }
  };
}

export const arriveCommand: CommandSpec = {
  name: "arrive",
  summary: "Assert you have arrived at a saved place",
  description:
    "A thin shortcut for the current-location assertion: <place> resolves by id or exact name against " +
    'active location conditions (aliases of "save place"/"condition-definition"), then sends the identical ' +
    "current_availability write the portal's one-tap \"I'm at <place>\" button sends — the same write " +
    '"save current_availability --set currentSituation.locationId=<id>" reaches, but pre-filled with the ' +
    "current energy and conditions so a location-only change never fails validation for missing ones. " +
    "A changed location can make some already-scheduled preparation moot and skip it automatically, the " +
    "same way any arrival does.",
  positionals: [{ name: "place", required: true, description: "A location's id or exact name" }],
  options: {
    "dry-run": { type: "boolean", description: "Print the command that would be sent instead of sending it" }
  },
  mutates: true,
  examples: ["arrive ctx-gym", 'arrive "Gym"', "arrive Campus --dry-run"],
  async run(context: CommandContext, args) {
    const placeArg = requirePositional(arriveCommand, args, 0);
    const state = await context.client.getState();
    const location = resolveLocation(state, placeArg);
    const locationId = String(location.id);
    const locationName = typeof location.name === "string" && location.name.length > 0 ? location.name : locationId;

    if (state.currentSituation.locationId === locationId) {
      if (context.mode !== "table")
        context.stdout(toJson({ ok: true, applied: false, locationId, locationName, changed: false }, true));
      else context.stdout(`rhen: already at "${locationName}".`);
      return;
    }

    const payload = buildArriveCommand(state, locationId);
    const parsed = planningEntityCommandSchema.safeParse(payload);
    if (!parsed.success)
      throw new CliError("The arrival does not match the command schema.", EXIT.validation, parsed.error.issues);

    const result = await postCommand(context, args, {
      path: "/api/commands/entity",
      payload: parsed.data,
      summary: `arrive at "${locationName}" (${locationId})`,
      // Arriving again at the previous place puts the location back; with none recorded there is nothing to restore.
      ...(state.currentSituation.locationId
        ? {
            reverse: {
              undo: {
                path: "/api/commands/entity",
                payload: buildArriveCommand(state, state.currentSituation.locationId)
              },
              target: { stateKey: "settings" }
            }
          }
        : {})
    });
    if (!result.state) return; // --dry-run already printed the payload

    if (context.mode !== "table")
      context.stdout(
        toJson({ ok: true, applied: true, ...commandIdOf(context), locationId, locationName, changed: true }, true)
      );
    else context.stdout(`rhen: arrived at "${locationName}".`);
  }
};
