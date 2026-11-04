"use client";

import type { StoredDeliverableContractProposal } from "@/state/portal-state";
import { label } from "@/features/deliverables/deliverable-model";
import { verificationMethods } from "./criteria-rail";

/**
 * One extracted requirement awaiting review. Every field that becomes part of the criterion is
 * editable before acceptance, because extraction is a proposal and the person is the one who decides
 * what the contract says. The source evidence, basis and confidence are shown but not editable: they
 * record where the proposal came from, which is not the person's to rewrite.
 */
export function ProposalCard({
  proposal,
  draft,
  editable,
  busy,
  onChange,
  onDecide
}: {
  proposal: StoredDeliverableContractProposal;
  draft: StoredDeliverableContractProposal;
  editable: boolean;
  busy: boolean;
  onChange: (change: Partial<StoredDeliverableContractProposal>) => void;
  onDecide: (decision: "confirm" | "ignore") => void;
}) {
  return (
    <article className="proposal-message" aria-label={`Proposal ${proposal.title}`}>
      {editable ? (
        <div className="workspace-item-editor flush">
          <label>
            Key
            <input value={draft.key} onChange={(event) => onChange({ key: event.target.value })} />
          </label>
          <label>
            Requirement
            <input value={draft.title} onChange={(event) => onChange({ title: event.target.value })} />
          </label>
          <label>
            Interpretation
            <input
              value={draft.interpretation ?? ""}
              onChange={(event) => onChange({ interpretation: event.target.value || undefined })}
            />
          </label>
          <label>
            Source location
            <input
              value={draft.sourceLocation ?? ""}
              onChange={(event) => onChange({ sourceLocation: event.target.value || undefined })}
            />
          </label>
          <label>
            Expected evidence
            <input
              value={draft.expectedEvidence ?? ""}
              onChange={(event) => onChange({ expectedEvidence: event.target.value || undefined })}
            />
          </label>
          <label>
            Verification method
            <select
              value={draft.verificationMethod ?? ""}
              onChange={(event) => onChange({ verificationMethod: (event.target.value || undefined) as never })}
            >
              <option value="">Not decided</option>
              {verificationMethods.map((value) => (
                <option value={value} key={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={draft.required}
              onChange={(event) => onChange({ required: event.target.checked })}
            />
            Required
          </label>
        </div>
      ) : (
        <>
          <strong>{draft.title}</strong>
          <p>{draft.interpretation ?? draft.basis}</p>
        </>
      )}
      <small>
        {proposal.sourceTitle ?? proposal.sourceDocument ?? "Source"}
        {proposal.sourceLocation ? ` · ${proposal.sourceLocation}` : ""} · {proposal.basis} ·{" "}
        {proposal.confidence ?? "unknown"} confidence
      </small>
      {proposal.evidence.length > 0 && (
        <ul className="workspace-note-list">
          {proposal.evidence.map((line, index) => (
            <li key={index}>
              <small>{line}</small>
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="actions">
          <button
            type="button"
            disabled={busy || !draft.title.trim() || !draft.key.trim()}
            onClick={() => onDecide("confirm")}
          >
            Accept into contract
          </button>
          <button type="button" className="quiet" disabled={busy} onClick={() => onDecide("ignore")}>
            Ignore
          </button>
        </div>
      )}
    </article>
  );
}
