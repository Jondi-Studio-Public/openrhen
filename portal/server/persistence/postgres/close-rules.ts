import { InvalidCommandError } from "./command-errors";
import type { Sql } from "./sql-pool";

/**
 * Rules that apply when a record is archived, whichever command does it (a save that sets the status, or the close
 * command), so the two cannot drift apart.
 */

/**
 * Sleep and every return leg point at the owner's home location, so it cannot quietly stop existing: the owner
 * chooses another home in Settings first. Throws when `contextId` (the stored slug) is that home.
 */
export async function assertNotHomeLocation(
  tx: Sql,
  userId: string,
  contextId: string,
  shownId: string
): Promise<void> {
  const home = await tx<
    { home_location_id: string | null }[]
  >`SELECT home_location_id FROM user_preferences WHERE user_id=${userId}`;
  if (home[0]?.home_location_id === contextId)
    throw new InvalidCommandError(
      `Context "${shownId}" is the owner's home location, and sleep and every return leg point at it, so it cannot be archived. ` +
        "Only the owner can choose another home (in Settings, under Places); tell the person, then archive this one once they have."
    );
}
