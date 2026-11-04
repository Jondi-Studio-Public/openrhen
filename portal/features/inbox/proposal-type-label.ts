import { sentenceCase } from "./source-label";

/** What a proposal was to become, in the words the review form uses. */
const PROPOSAL_TYPE_LABELS: Record<string, string> = {
  fixed_commitment: "Fixed commitment",
  someday: "Someday / maybe",
  email_change: "Email change"
};

export const proposalTypeLabel = (proposalType: string): string =>
  PROPOSAL_TYPE_LABELS[proposalType] ?? sentenceCase(proposalType);
