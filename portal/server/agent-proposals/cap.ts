import { AGENT_PROPOSAL_PENDING_CAP } from "@openrhen/contracts";

/** Whether an agent holding `pending` proposals may open another. Past the cap the write is refused, not dropped. */
export function overPendingCap(pending: number, cap: number = AGENT_PROPOSAL_PENDING_CAP): boolean {
  return pending >= cap;
}

export function overCapMessage(agent: string, cap: number = AGENT_PROPOSAL_PENDING_CAP): string {
  return `The agent "${agent}" already has ${cap} proposals waiting for review. Nothing was recorded; ask the person to review them in the Inbox, then propose again.`;
}
