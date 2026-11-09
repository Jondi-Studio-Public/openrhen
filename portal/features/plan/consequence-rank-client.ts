import type { ConsequenceGroupView, RankConsequenceGroupCommand } from "@openrhen/contracts";

/** Reads the next group (or the one still waiting). `null` means nothing can be asked right now. */
export async function fetchNextGroup(): Promise<ConsequenceGroupView | null> {
  const response = await fetch("/api/consequence/next", { cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as { group?: ConsequenceGroupView | null; error?: string };
  if (!response.ok) throw new Error(body.error ?? "The next group could not be loaded.");
  return body.group ?? null;
}

/** Sends one answer. A refusal carries the server's own words, which already name the group waiting and the next call. */
export async function postAnswer(command: RankConsequenceGroupCommand): Promise<void> {
  const response = await fetch("/api/commands/consequence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command)
  });
  if (response.ok) return;
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? "The answer was not saved.");
}
