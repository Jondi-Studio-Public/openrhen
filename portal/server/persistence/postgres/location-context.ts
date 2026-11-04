import { InvalidCommandError, invalidChoice } from "./command-errors";
import type { Sql } from "./sql-pool";

/**
 * Resolves an optional location reference to the slug of an active `location` context definition,
 * or null when nothing was supplied. Commitments and the home base point at places by slug (no FK,
 * like capacity windows), so this is the only guard between a typo and a place the engine cannot find.
 */
export async function optionalActiveLocationId(sql: Sql, userId: string, value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) return null;
  const id = value.trim();
  const rows = await sql<
    { id: string }[]
  >`SELECT id FROM condition_definitions WHERE user_id=${userId} AND id=${id} AND kind='location' AND status='active'`;
  if (!rows[0]) throw await unknownLocation(sql, userId, id, label);
  return rows[0].id;
}

/** The refusal for a location id that is not an active place: lists the owner's active places and the call that shows them. */
async function unknownLocation(sql: Sql, userId: string, got: string, label: string): Promise<InvalidCommandError> {
  const places = await sql<
    { id: string }[]
  >`SELECT id FROM condition_definitions WHERE user_id=${userId} AND kind='location' AND status='active' ORDER BY id LIMIT 30`;
  return invalidChoice(
    "locationId",
    got,
    places.map((place) => place.id),
    {
      label: `${label} (must be an active place)`,
      nextCall: {
        tool: "rhen_list",
        arguments: { entity: "places", limit: 30 },
        note: "the owner's saved places"
      }
    }
  );
}

/**
 * A `currentSituation` write that names a `locationId` must name an active saved place (`null` clears it,
 * a payload that does not mention the field leaves it alone, and re-sending the stored one is no change, so
 * a whole-situation save still works after that place is archived). The slug is stored as typed, so a
 * padded or non-string value is refused rather than trimmed.
 */
export async function assertCurrentLocationIsSavedPlace(
  sql: Sql,
  userId: string,
  currentSituation: unknown,
  storedLocationId: string | null
) {
  if (!currentSituation || typeof currentSituation !== "object") return;
  const named = (currentSituation as Record<string, unknown>).locationId;
  if (named === undefined || named === null || named === storedLocationId) return;
  const active =
    typeof named === "string" ? await optionalActiveLocationId(sql, userId, named, "Current location") : null;
  if (active !== named) throw await unknownLocation(sql, userId, String(named), "Current location");
}
