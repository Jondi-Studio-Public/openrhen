"use client";

import { useState, type FormEvent } from "react";
import { isOccurrenceInProgressRefusal } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import { RuleCatalog } from "@/features/schedule/components/rule-catalog";
import { WeekPanel } from "@/features/schedule/components/week-panel";
import {
  futureCustomOccurrenceCount,
  InProgressOccurrenceQuestion,
  PerDateChangesWarning
} from "@/features/commitments/components/series-edit-scope";
import { CommitmentEditor } from "@/features/today/components/commitment-editor";
import { TodayFormHost } from "@/features/today/components/today-form-host";
import { createContact, createOneOffPlace, saveCommitmentDraft } from "@/features/today/commitment-save";
import { commitmentEditorFromRule, type CommitmentEditorDraft } from "@/features/today/today-drafts";
import { useNow } from "@/shared/clock";
import { useMediaQuery } from "@/shared/use-media-query";

/**
 * Day > Week: the week calendar, the catalog of recurring commitment rules, and each commitment's own
 * detail page a tap away.
 *
 * Editing a rule happens here now, in the one commitment editor every other surface uses — a sheet
 * on a phone, inline on a desk. It used to mean going to Today and finding the rule in a panel that
 * no longer exists; a rule belongs to the week, not to a day.
 */
export default function SchedulePage() {
  const { state, ready, saveEntityCommand, saveCommitmentRecurrenceRuleCommand } = usePortal();
  const desk = useMediaQuery("(min-width: 1024px)");
  const phone = !desk;
  // Only to decide which materialized occurrence is the next one; nothing here moves by the second.
  const now = useNow("minute");
  const [draft, setDraft] = useState<CommitmentEditorDraft | null>(null);
  // The version the draft was seeded from, captured alongside it in `onEdit` — not a new field on
  // the draft itself (it must not be re-read live at submit).
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [error, setError] = useState("");
  // Set only when the rule save comes back with the `occurrence_in_progress` refusal: the question
  // replaces the form until it is answered or cancelled, but the draft itself is untouched either way.
  const [inProgressQuestion, setInProgressQuestion] = useState(false);

  const closeEditor = () => {
    setDraft(null);
    setDraftVersion(null);
    setError("");
    setInProgressQuestion(false);
  };

  async function submitEditor(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const message = await saveCommitmentDraft(draft, draftVersion, {
      state,
      saveEntityCommand,
      saveCommitmentRecurrenceRuleCommand
    });
    if (message && isOccurrenceInProgressRefusal(message)) {
      setError("");
      setInProgressQuestion(true);
      return;
    }
    setError(message);
    if (message) return;
    closeEditor();
  }

  async function answerInProgressQuestion(applyToOccurrenceInProgress: boolean) {
    if (!draft) return;
    const message = await saveCommitmentDraft(
      draft,
      draftVersion,
      { state, saveEntityCommand, saveCommitmentRecurrenceRuleCommand },
      { applyToOccurrenceInProgress }
    );
    setError(message);
    if (message) return;
    closeEditor();
  }

  if (!ready)
    return (
      <main className="content-page">
        <p>Loading the week…</p>
      </main>
    );

  return (
    <main className="content-page schedule-page">
      <WeekPanel />

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <RuleCatalog
        rules={state.commitmentRecurrenceRules}
        projects={state.projects}
        commitments={state.commitments}
        timezone={state.settings.timezone}
        now={now}
        onEdit={(rule) => {
          setError("");
          setInProgressQuestion(false);
          setDraft(commitmentEditorFromRule(rule, state.settings));
          setDraftVersion(rule.version ?? null);
        }}
      />
      <TodayFormHost phone={phone} open={Boolean(draft)} title="Edit recurring commitment" onClose={closeEditor}>
        {draft && <PerDateChangesWarning count={futureCustomOccurrenceCount(state.commitments, draft.id, now)} />}
        {inProgressQuestion ? (
          <InProgressOccurrenceQuestion
            onAnswer={answerInProgressQuestion}
            onCancel={() => setInProgressQuestion(false)}
          />
        ) : (
          draft && (
            <CommitmentEditor
              draft={draft}
              onChange={setDraft}
              onSubmit={submitEditor}
              onCancel={closeEditor}
              onCreatePlaceFromSearch={(match) => createOneOffPlace(match, saveEntityCommand)}
              onCreateContact={(name) => createContact(name, state.conditionDefinitions, saveEntityCommand)}
              projects={state.projects}
              definitions={state.conditionDefinitions}
              timezone={state.settings.timezone}
              open
            />
          )
        )}
      </TodayFormHost>
    </main>
  );
}
