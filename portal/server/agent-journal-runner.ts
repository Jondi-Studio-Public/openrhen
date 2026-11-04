import { findCommand, memoryJournal, type JournalEntry } from "@openrhen/cli/in-process";
import type { RevertCommand } from "@openrhen/contracts";
import { AGENT_JOURNAL_LIMIT } from "./persistence/postgres/agent-changes";
import { runCliInProcess, type CliRunResult, type RunCliInProcessOptions } from "./mcp-cli-runner";

/**
 * Runs a CLI command in-process with the agent's own undo journal, which is the write ledger
 * (`agent-ledger-journal.ts`): every write of the agent that kept something to put back is a server-checked entry,
 * so `undo` works across `/mcp` calls and from the owner's "Agent changes" list, and a new write adds no journal
 * entry of its own.
 *
 * The CLI's `Journal` is synchronous, so a write loads the agent's ledger entries first and hands the CLI an
 * in-memory journal holding them. Nothing is saved back: the ledger is the record. Without a database the journal
 * is empty for the one call (undo then finds nothing), and the call is not refused. With a database a write whose
 * journal cannot be read is refused, since the answer would promise an undo that finds nothing.
 */

export interface JournalStore {
  /** The agent's journal: its ledger writes as server-checked entries, oldest first. */
  load(agent: string): Promise<JournalEntry[]>;
  /**
   * The ledger's agent write `id` (a row of Review > Agent changes), or null. The owner's undo of it is
   * `revertLedgerWrite`. Absent where there is no ledger.
   */
  ledgerWrite?(id: string): Promise<{ id: string; agent: string } | null>;
  /** Runs the revert command as the owner (the caller has already refused any agent identity). */
  revertLedgerWrite?(command: RevertCommand): Promise<void>;
}

/** The journal store over the portal's database, or undefined when none is configured. */
export async function databaseJournalStore(): Promise<JournalStore | undefined> {
  const { databaseUrl } = await import("./runtime-env");
  const url = databaseUrl();
  if (!url) return undefined;
  const [{ sqlPool }, { ensureUser }, { findLedgerWrite }, { runRevertCommand }, { withCommandRetry }, ledgerJournal] =
    await Promise.all([
      import("./persistence/postgres/sql-pool"),
      import("./persistence/postgres/ensure-user"),
      import("./persistence/postgres/agent-changes"),
      import("./persistence/postgres/write-revert"),
      import("./persistence/postgres/command-retry"),
      import("./agent-ledger-journal")
    ]);
  const sql = sqlPool(url);
  return {
    load: async (agent) => ledgerJournal.ledgerJournalEntries(sql, await ensureUser(sql), agent),
    ledgerWrite: async (id) => {
      const found = await findLedgerWrite(sql, id);
      return found ? { id: found.id, agent: found.agent } : null;
    },
    revertLedgerWrite: async (command) => {
      await withCommandRetry(() => runRevertCommand(sql, command));
    }
  };
}

/** The CLI's exit code for "the portal could not do that" (tools/cli/src/errors.ts). */
const EXIT_UNAVAILABLE = 5;

/** Why a write was refused before it ran: its undo record could not be read, so `undo` would find nothing. */
export const JOURNAL_UNREADABLE = "The undo record could not be read; nothing was changed. Try again.";

export interface RunWithJournalOptions extends Omit<RunCliInProcessOptions, "journal"> {
  /** Whose journal: the bare agent name (`principal.name`). */
  agent: string;
  /** Where journals live; none (an empty journal for this call) when null or absent. */
  store?: JournalStore | null | undefined;
}

export async function runCliWithAgentJournal(options: RunWithJournalOptions): Promise<CliRunResult> {
  const { agent, store, ...rest } = options;
  // A command that changes nothing (a read) never touches the journal.
  const spec = findCommand(options.argv[0] ?? "");
  if (spec !== undefined && !spec.mutates) return runCliInProcess({ ...rest, journal: memoryJournal() });
  let entries: JournalEntry[] = [];
  if (store) {
    const loaded = await store.load(agent).catch(() => undefined);
    if (!loaded)
      return {
        exitCode: EXIT_UNAVAILABLE,
        stdout: [],
        stderr: [JOURNAL_UNREADABLE],
        failed: true,
        retryMessage: JOURNAL_UNREADABLE
      };
    entries = loaded;
  }
  // Rebuilt from the ledger next call, so a restating entry would be a false promise of undo: none is recorded.
  return runCliInProcess({
    ...rest,
    journal: { ...memoryJournal([...entries], AGENT_JOURNAL_LIMIT), serverCheckedOnly: true }
  });
}
