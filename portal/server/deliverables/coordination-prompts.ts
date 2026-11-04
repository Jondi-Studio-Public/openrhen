/**
 * Coordination handoff and bring-back prompts for external coordinators (CLI agents, desktop AI apps).
 * These are shared verbatim across the workspace UI's copy-prompt button, `rhen deliverable handoff`,
 * and the pack/chat routes, so the wording never drifts between them (per the external coordination design note's
 * "The prompt" decision row). The exact English wording is copied from that design doc's
 * "API contract (the seam)" section.
 */

export interface CoordinationPromptDeliverable {
  title: string;
  id: string;
}

export interface CoordinationPrompts {
  handoff: string;
  bringBack: string;
}

export function handoffPrompt(deliverable: CoordinationPromptDeliverable): string {
  return `You are coordinating the deliverable "${deliverable.title}" (id ${deliverable.id}) in OpenRhen, my planning system, through the \`rhen\` CLI or the \`rhen_deliverable\` MCP tool. First run \`rhen deliverable pick-up ${deliverable.id}\` (over MCP: \`rhen_deliverable\` with subcommand \`pick-up\` and that id) and read the pack it returns, including its rules and command map. Then help me work through the deliverable, recording progress with the deliverable commands as we go. When we stop, run \`rhen deliverable drop-off ${deliverable.id} --summary "…"\` with a summary of what we decided, what is done, and what is still open. If the CLI is not on your PATH, ask me for the script path.`;
}

export function bringBackPrompt(deliverable: CoordinationPromptDeliverable): string {
  return `Please hand the deliverable "${deliverable.title}" (id ${deliverable.id}) back to OpenRhen now: run \`rhen deliverable drop-off ${deliverable.id} --summary "…"\` with a summary of what we decided, what is done, and what is still open, then stop making changes to it.`;
}

export function coordinationPrompts(deliverable: CoordinationPromptDeliverable): CoordinationPrompts {
  return { handoff: handoffPrompt(deliverable), bringBack: bringBackPrompt(deliverable) };
}
