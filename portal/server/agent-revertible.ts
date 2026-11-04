import { requestAgent } from "@/server/agent-actor";
import { getStateStore } from "@/server/persistence/state-store";

/**
 * What an agent's write answers with so the CLI can journal it for `rhen undo`: `revertible: <commandId>`
 * when the write kept row images (write-snapshot.ts), nothing otherwise, and nothing for the person's own write.
 * A write that changed no row keeps no images, so it does not claim to be undoable.
 */
export async function revertibleAnswer(commandId: string | undefined): Promise<{ revertible?: string }> {
  if (requestAgent() === null || !commandId) return {};
  return (await getStateStore().hasSnapshot(commandId)) ? { revertible: commandId } : {};
}
