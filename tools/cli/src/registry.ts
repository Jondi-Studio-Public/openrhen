import type { CommandSpec } from "./command.js";
import { recordCommandModule, type CommandModule } from "./command-modules.js";
import { dropInModules } from "./drop-ins.js";
import { agentTokenCommand } from "./commands/agent-token.js";
import { ownerTokenCommand } from "./commands/owner-token.js";
import { activityCommand } from "./commands/activity.js";
import { arriveCommand } from "./commands/arrive.js";
import { bulkCommand } from "./commands/bulk.js";
import { cadenceCommand } from "./commands/cadence.js";
import { captureCommand } from "./commands/capture.js";
import { catchUpCommand } from "./commands/catch-up.js";
import { attentionCommand } from "./commands/attention.js";
import { doctorCommand } from "./commands/doctor.js";
import { catchUpSettleCommand } from "./commands/catch-up-settle.js";
import { changesCommand } from "./commands/changes.js";
import { changesetCommand } from "./commands/changeset.js";
import { checkInCommand } from "./commands/check-in.js";
import { deliverableCommand } from "./commands/deliverable.js";
import { disruptionCommand } from "./commands/disruption.js";
import { routineCommand } from "./commands/routine.js";
import { guideCommand } from "./commands/guide.js";
import { helpCommand } from "./commands/help.js";
import { forecastCommand } from "./commands/forecast.js";
import { historyCommand } from "./commands/history.js";
import { importCommand } from "./commands/import.js";
import { inboxActCommand } from "./commands/inbox-act.js";
import { inboxCommand } from "./commands/inbox.js";
import { listCommand } from "./commands/list.js";
import { mapCommand } from "./commands/map.js";
import { proposalsCommand } from "./commands/proposals.js";
import { proposeCommand } from "./commands/propose.js";
import { mcpCommand } from "./commands/mcp.js";
import { undoCommand } from "./commands/undo.js";
import { recalculateCommand } from "./commands/recalculate.js";
import { recurrenceCommand } from "./commands/recurrence.js";
import { disruptCommand } from "./commands/disrupt.js";
import { reenterCommand } from "./commands/reenter.js";
import { stretchCommand } from "./commands/stretch.js";
import { freeCommand } from "./commands/free.js";
import { saveCommand } from "./commands/save.js";
import { searchCommand } from "./commands/search.js";
import { selfUpdateCommand } from "./commands/self-update.js";
import { schemaCommand } from "./commands/schema.js";
import { archiveCommand, cancelCommand } from "./commands/close.js";
import { reviewCommand } from "./commands/review.js";
import { spanCommand } from "./commands/span.js";
import { sessionCommand } from "./commands/session.js";
import { showCommand } from "./commands/show.js";
import { skillCommand } from "./commands/skill.js";
import { stateCommand } from "./commands/state.js";
import { statusCommand } from "./commands/status.js";
import { summaryCommand } from "./commands/summary.js";
import { versionCommand } from "./commands/version.js";
import { wakeCommand } from "./commands/wake.js";

/** The commands the core CLI ships, in the order help lists them. Command modules add theirs to `commands`. */
const coreCommands: CommandSpec[] = [
  statusCommand,
  forecastCommand,
  summaryCommand,
  listCommand,
  showCommand,
  mapCommand,
  searchCommand,
  changesCommand,
  proposalsCommand,
  catchUpCommand,
  doctorCommand,
  attentionCommand,
  saveCommand,
  changesetCommand,
  captureCommand,
  proposeCommand,
  agentTokenCommand,
  ownerTokenCommand,
  catchUpSettleCommand,
  reenterCommand,
  disruptCommand,
  arriveCommand,
  stretchCommand,
  freeCommand,
  wakeCommand,
  bulkCommand,
  sessionCommand,
  spanCommand,
  reviewCommand,
  archiveCommand,
  cancelCommand,
  historyCommand,
  activityCommand,
  deliverableCommand,
  checkInCommand,
  disruptionCommand,
  routineCommand,
  recalculateCommand,
  undoCommand,
  cadenceCommand,
  recurrenceCommand,
  importCommand,
  inboxCommand,
  inboxActCommand,
  stateCommand,
  schemaCommand,
  guideCommand,
  skillCommand,
  helpCommand,
  versionCommand,
  selfUpdateCommand,
  mcpCommand
];

/**
 * Every command, in the order help lists them: the core's, plus those of each registered command module
 * (`command-modules.ts`). `rhen help --json` prints this table. The array is filled in place when a module
 * registers, so a reader that holds it sees later modules.
 */
export const commands: CommandSpec[] = [...coreCommands];

/** Adds a command module's commands after the command it names, or at the end. Registering twice is a no-op. */
export function registerCommandModule(module: CommandModule): void {
  if (!recordCommandModule(module)) return;
  const anchor = module.after === undefined ? -1 : commands.findIndex((command) => command.name === module.after);
  commands.splice(anchor < 0 ? commands.length : anchor + 1, 0, ...module.commands);
}

for (const module of dropInModules()) registerCommandModule(module);

export function findCommand(name: string): CommandSpec | undefined {
  return commands.find((command) => command.name === name);
}
