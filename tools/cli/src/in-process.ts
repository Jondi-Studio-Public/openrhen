/**
 * The CLI as a library, for the portal's remote `/mcp` endpoint.
 * The endpoint runs the real commands in-process: it hands `runCli` an injected environment, an in-memory journal,
 * no config file and a `fetchImpl` that dispatches to the portal's own route handlers, so a remote tool behaves
 * exactly like its stdio twin. Nothing here reads a file or the process environment on its own; every input comes
 * from the caller. Import this module and no other from the portal (`@openrhen/cli/in-process`).
 */
export { runCli, type CliIo } from "./cli.js";
export { memoryJournal, type Journal, type JournalEntry } from "./undo-journal.js";
export { findCommand } from "./registry.js";
export type { CommandSpec } from "./command.js";
export { toolInvocation, toolResult, type ToolContent } from "./commands/mcp.js";
