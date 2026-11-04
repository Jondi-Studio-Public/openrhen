"use client";

import { situationCommand } from "@/components/situation-panel";
import type { PortalState } from "@/state/portal-state";
import type { AnswerDirective, AnswerOption, SaveEntityCommand } from "@/features/now/now-model";
import { EvidenceDetails } from "./evidence-details";

/**
 * Nothing fits only because a context nobody has answered stands in the way, so the question is the
 * directive. It is answered here with the same situation commands the availability panel uses —
 * asserting a location, carrying a portable capability, or overriding what usually follows — and
 * the answer re-ranks the work; the candidate named is what would lead if the answer were yes.
 */
export function AnswerPanel({
  directive,
  options,
  state,
  saving,
  explanation,
  evidence,
  saveEntityCommand
}: {
  directive: AnswerDirective;
  options: readonly AnswerOption[];
  state: PortalState;
  saving: boolean;
  explanation: string;
  evidence: readonly string[];
  saveEntityCommand: SaveEntityCommand;
}) {
  const situation = state.currentSituation;
  const answer = (option: AnswerOption, yes: boolean) => {
    if (option.kind === "location")
      return void saveEntityCommand(situationCommand(state, { locationId: option.contextId }));
    if (option.kind === "carrying")
      return void saveEntityCommand(
        situationCommand(state, { carrying: { ...situation.carrying, [option.contextId]: yes } })
      );
    return void saveEntityCommand(
      situationCommand(state, {
        overrides: { ...situation.overrides, [option.contextId]: yes ? "available" : "unavailable" }
      })
    );
  };
  const candidate = directive.candidate;
  return (
    <>
      <p className="time">One answer would open up work</p>
      <p className="reason">{directive.question}</p>
      {candidate ? (
        <p className="microcopy">
          If yes, <strong>{candidate.title}</strong> would lead for {candidate.recommendedMinutes} minutes.
        </p>
      ) : (
        <p className="microcopy">The engine has not named what would lead once this is answered.</p>
      )}
      <ul className="answer-options">
        {options.map((option) => (
          <li key={option.contextId}>
            <span>{option.name}</span>
            {option.kind === "location" ? (
              <button disabled={saving} onClick={() => answer(option, true)}>
                I am at {option.name}
              </button>
            ) : (
              <>
                <button disabled={saving} onClick={() => answer(option, true)}>
                  {option.kind === "carrying" ? "Yes, with me" : "Yes, available"}
                </button>
                <button className="quiet" disabled={saving} onClick={() => answer(option, false)}>
                  {option.kind === "carrying" ? "No, not with me" : "No, not available"}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="microcopy">{explanation} Answering here is the same as changing it under Available right now.</p>
      {evidence.length > 0 && <EvidenceDetails summary="Why nothing else fits" evidence={evidence} />}
    </>
  );
}
