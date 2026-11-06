import type { CommandContext, CommandSpec, ParsedArgs } from "./command.js";
import type { RemoteTool } from "./remote-manifest.js";

/**
 * The extension point for commands the core CLI does not ship (P4-11, the "seam" rule in
 * the design notes). A command module is a bundle of commands, and optionally Inbox rooms, that
 * a build adds; the core CLI loads none by default. A module is registered in one of two ways: a folder
 * `tools/cli/extensions/<name>/command-module.ts` with a default export (found by `drop-ins.ts`), or a direct
 * `registerCommandModule()` call from a host that builds its own CLI.
 */

/** One thing waiting in an Inbox room, and the command that acts on it. */
export interface InboxItemSpec {
  id: string;
  title: string;
  detail?: string | undefined;
  openQuestions?: number | undefined;
  /** The command that acts on it. */
  act?: string | undefined;
}

/** A room a module adds to `rhen inbox`. Registered rooms list ahead of the core's own rooms. */
export interface InboxRoomSpec {
  id: string;
  label: string;
  /** Lists directly before this core room (default: ahead of all of them). */
  before?: string;
  /** How `rhen inbox` describes the room, for the command's description ("From people (notes)"). */
  about?: string;
  /** The fence label of the room's text when it is not the core's ("mail"). */
  untrustedOutput?: string;
  /** Reads the room from the portal state's captures and, if it needs more, from the portal's routes. */
  load(context: CommandContext, captures: readonly unknown[]): Promise<InboxItemSpec[]>;
}

/** An Inbox room a module adds to `rhen inbox-act`, with the words the command's help gives it. */
export interface InboxActRoomSpec {
  id: string;
  actions: readonly string[];
  /** The sentence in the command description, ending in a space ("people (From people): `reply ...`. "). */
  description: string;
  /** The room in the remote tool's words (no flags): "room people: reply (id, text), keep or seen. ". Optional. */
  remoteDescription?: string;
  /** The room's entry in the `action` argument's help ("people: reply|keep|seen"). */
  actionHelp: string;
  /** A clause for the description's "Confirm when..." sentence ("a capture from X is the person's to confirm"). */
  confirmNote?: string;
  /** What the room adds to the import-clash hint ("a sender's clash's"). */
  importClash?: string;
  /** Lines the agent skill's Inbox section gains, indented two spaces and ending without a newline. */
  skillNote?: string;
  options?: CommandSpec["options"];
  examples?: readonly string[];
  run(context: CommandContext, args: ParsedArgs, action: string): Promise<void>;
}

export interface CommandModule {
  /** Stable name; registering the same id twice is a no-op. */
  id: string;
  commands: readonly CommandSpec[];
  /** Name of the command the module's commands list after in `help`; absent or unknown appends them. */
  after?: string;
  inboxRooms?: readonly InboxRoomSpec[];
  /** Rooms the module adds to `rhen inbox-act`, listed after `kept` and before `map`. */
  inboxActRooms?: readonly InboxActRoomSpec[];
  /** The module's commands the remote MCP server serves, each placed after the core tool `remoteAfter` names (default: last). */
  remoteTools?: readonly RemoteTool[];
  remoteAfter?: string;
  /** Markdown for the agent skill's Inbox section: how an agent works the module's rooms and commands (`<stdio>` and `<remote>` markers apply). */
  skillNote?: string;
  /**
   * Where `pnpm manifest` writes the module's MCP tool entries, instead of the core manifest data: a file name under
   * `platform/contracts/src/private/`, the constant it exports for the module's own tools and the one for the core tools its rooms change (`overridesName`, left out when the extension derives those from core), which a contracts extension registers.
   */
  manifestFile?: { file: string; exportName: string; overridesName?: string };
}

const modules = new Map<string, CommandModule>();

/** Records a module. Returns false when its id was already registered, so a caller adds the commands once. */
export function recordCommandModule(module: CommandModule): boolean {
  if (modules.has(module.id)) return false;
  modules.set(module.id, module);
  return true;
}

export function commandModules(): readonly CommandModule[] {
  return [...modules.values()];
}

export function registeredInboxRooms(): InboxRoomSpec[] {
  return commandModules().flatMap((module) => module.inboxRooms ?? []);
}

export function registeredInboxActRooms(): InboxActRoomSpec[] {
  return commandModules().flatMap((module) => module.inboxActRooms ?? []);
}

/** Runs `fn` with the named modules unregistered, then puts them back: the CLI as a build without them has it. */
export function withoutCommandModules<T>(ids: readonly string[], fn: () => T): T {
  const hidden = ids.flatMap((id) => (modules.has(id) ? [[id, modules.get(id)!] as const] : []));
  for (const [id] of hidden) modules.delete(id);
  try {
    return fn();
  } finally {
    for (const [id, module] of hidden) modules.set(id, module);
  }
}
