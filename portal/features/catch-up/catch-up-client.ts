import {
  CATCH_UP_PAGE_SIZE,
  catchUpLedgerSchema,
  settleCatchUpResultSchema,
  type CatchUpEntry,
  type CatchUpLedger,
  type SettleCatchUpCommand,
  type SettleCatchUpResult
} from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";

/** Pages never fetched beyond this many, so a runaway ledger cannot loop the screen. */
const MAX_PAGES = 20;

/** Reads the ledger: the first page for the banner, every page for the screen. */
export async function fetchCatchUp(options: { all?: boolean } = {}): Promise<CatchUpLedger> {
  let ledger: CatchUpLedger | null = null;
  const entries: CatchUpEntry[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetch(`/api/catch-up?offset=${page * CATCH_UP_PAGE_SIZE}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Catch-up could not be read.");
    const parsed = catchUpLedgerSchema.parse(await response.json());
    ledger ??= parsed;
    entries.push(...parsed.entries);
    if (!options.all || parsed.remaining === 0 || parsed.entries.length === 0) break;
  }
  return { ...ledger!, entries, remaining: Math.max(0, ledger!.unsettled - entries.length) };
}

export interface SettleResponse {
  result: SettleCatchUpResult;
  state: PortalState | null;
}

/** Sends one settle. A refusal (the switch is off or in shadow, a bad entry) carries the server's words. */
export async function postSettle(command: SettleCatchUpCommand): Promise<SettleResponse> {
  const response = await fetch("/api/commands/catch-up-settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command)
  });
  const body = (await response.json().catch(() => ({}))) as { result?: unknown; state?: PortalState; error?: string };
  if (!response.ok) throw new Error(body.error ?? "The settle was not saved.");
  return { result: settleCatchUpResultSchema.parse(body.result), state: body.state ?? null };
}
