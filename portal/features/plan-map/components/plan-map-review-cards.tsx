"use client";

import { useState } from "react";
import {
  planHealthCheckLabel,
  resolveQuestion,
  unansweredQuestions,
  type PlanFinding,
  type PlanLink
} from "@openrhen/contracts";
import { Button } from "@/components/ui/button";
import flat from "@/components/ui/embedded.module.css";
import { QuestionField } from "@/features/capture/components/question-field";
import { LINK_KIND_LABELS, describeSuggestedChange, type TitleResolver } from "@/features/plan-map/plan-map-model";

/**
 * The Inbox's Links detail: one suggested link or one plan finding. Nothing here changes the plan:
 * confirming a link or accepting a finding records a decision, and a finding's suggested plan changes
 * are shown but not applied yet.
 */

function EvidenceList({ evidence }: { evidence: string[] }) {
  if (!evidence.length) return null;
  return (
    <ul className="plan-map-evidence">
      {evidence.map((line, index) => (
        <li key={`${index}:${line}`}>{line}</li>
      ))}
    </ul>
  );
}

/** Both ends by title, the kind, who proposed it and why. Suggestions change nothing until confirmed. */
export function SuggestedLinkCard({
  link,
  resolver,
  busy,
  onDecide
}: {
  link: PlanLink;
  resolver: TitleResolver;
  busy: boolean;
  onDecide: (action: "confirm" | "reject") => void;
}) {
  const from = resolver.titleOf(link.fromType, link.fromId);
  const to = resolver.titleOf(link.toType, link.toId);
  return (
    <div className={flat.card}>
      <p>
        <strong>{from}</strong> <span className="plan-map-kind">{LINK_KIND_LABELS[link.kind]}</span>{" "}
        <strong>{to}</strong>
      </p>
      <p className="microcopy">
        Suggested by {link.proposer}
        {link.weight !== null ? ` · confidence ${Math.round(link.weight * 100)}%` : ""}
      </p>
      <EvidenceList evidence={link.evidence} />
      <p className="microcopy">
        A suggestion is drawn dashed on the map and changes nothing until you confirm it and an add-on that reads it is
        on.
      </p>
      <div className={flat.actions}>
        <Button variant="primary" data-inbox-action="yes" disabled={busy} onClick={() => onDecide("confirm")}>
          Confirm
        </Button>
        <Button variant="ghost" data-inbox-action="no" disabled={busy} onClick={() => onDecide("reject")}>
          Reject
        </Button>
      </div>
    </div>
  );
}

/** A finding with its question, the items it is about, its evidence and its suggested changes. */
export function FindingCard({
  finding,
  resolver,
  busy,
  onDecide
}: {
  finding: PlanFinding;
  resolver: TitleResolver;
  busy: boolean;
  onDecide: (action: "accept" | "dismiss", answers?: Record<string, string>) => void;
}) {
  const questions = finding.questions.map(resolveQuestion);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answered = unansweredQuestions(questions, answers).length === 0;
  return (
    <div className={flat.card}>
      <p>{finding.text}</p>
      {questions.map((question) => (
        <QuestionField
          key={question.field}
          idPrefix={`finding-question-${finding.id}`}
          question={question}
          value={answers[question.field] ?? ""}
          onChange={(value) => setAnswers((current) => ({ ...current, [question.field]: value }))}
        />
      ))}
      {finding.itemIds.length > 0 && (
        <p className="microcopy">About {finding.itemIds.map(resolver.handleTitle).join(", ")}</p>
      )}
      <EvidenceList evidence={finding.evidence} />
      {finding.suggestedChanges.length > 0 && (
        <div className="plan-map-changes">
          <p className="microcopy">
            {finding.suggestedChanges.length === 1
              ? "1 suggested change (not applied yet):"
              : `${finding.suggestedChanges.length} suggested changes (not applied yet):`}
          </p>
          <ul>
            {finding.suggestedChanges.map((change, index) => (
              <li key={index}>{describeSuggestedChange(change)}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="microcopy">Raised by {planHealthCheckLabel(finding.checkName)}</p>
      <div className={flat.actions}>
        <Button
          variant="primary"
          data-inbox-action="yes"
          disabled={busy || !answered}
          aria-describedby={answered ? undefined : `finding-why-${finding.id}`}
          onClick={() => (questions.length ? onDecide("accept", answers) : onDecide("accept"))}
        >
          Accept
        </Button>
        <Button variant="ghost" data-inbox-action="no" disabled={busy} onClick={() => onDecide("dismiss")}>
          Dismiss
        </Button>
      </div>
      {!answered && (
        <p className="microcopy" id={`finding-why-${finding.id}`}>
          Answer the question to accept.
        </p>
      )}
    </div>
  );
}
