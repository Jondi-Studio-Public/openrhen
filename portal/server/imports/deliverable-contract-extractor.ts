export type DeliverableVerificationMethod =
  "llm_inspection" | "user_confirmation" | "submission_receipt" | "external_result" | "not_verifiable";

export interface DeliverableCriterionProposal {
  key: string;
  title: string;
  required: boolean;
  interpretation: string | null;
  sourceLocation: string | null;
  expectedEvidence: string | null;
  verificationMethod: DeliverableVerificationMethod | null;
  notes: string | null;
  basis: "explicit" | "inferred" | "missing";
  confidence: "high" | "medium" | "low" | null;
  evidence: string[];
}
