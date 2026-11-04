"use client";

import { PlaceTabs } from "@/components/place-tabs";
import { useState, type FormEvent } from "react";
import { isOccurrenceInProgressRefusal } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import type { StoredRoutineStep } from "@/state/portal-state";
import { Sheet } from "@/components/sheet";
import { useNow } from "@/shared/clock";
import { ConnectionsSection } from "@/features/plan-map/components/connections-section";
import { CommitmentEditor } from "@/features/today/components/commitment-editor";
import type { GeocodeMatch } from "@/features/today/components/location-picker";
import { useCommitmentPrep } from "@/features/commitments/use-commitment-prep";
import { CommitmentHeader } from "@/features/commitments/components/commitment-header";
import { CommitmentPlacePanel } from "@/features/commitments/components/commitment-place-panel";
import { CommitmentProvenanceFooter } from "@/features/commitments/components/commitment-provenance-footer";
import { CommitmentSources } from "@/features/commitments/components/commitment-sources";
import { CommitmentRecurrencePanel } from "@/features/commitments/components/commitment-recurrence-panel";
import {
  CommitmentRoutinePanel,
  type RoutineStepEdit
} from "@/features/commitments/components/commitment-routine-panel";
import {
  futureCustomOccurrenceCount,
  InProgressOccurrenceQuestion,
  PerDateChangesWarning
} from "@/features/commitments/components/series-edit-scope";
import type { RoutineSource } from "@/features/commitments/commitment-routine";
import {
  commitmentRoutineSourceCommand,
  routineStepEditCommand,
  splitSourceCommand
} from "@/features/commitments/commitment-commands";
import { resolveCommitmentContact } from "@/features/commitments/commitment-contact";
import { createContact, revertCommitmentToSeriesCommand, saveCommitmentDraft } from "@/features/today/commitment-save";
import {
  commitmentEditorFrom,
  commitmentEditorFromRule,
  type CommitmentEditorDraft
} from "@/features/today/today-drafts";

/**
 * One commitment, whole: what it is, where it happens, which series it belongs to, and — the reason
 * this page exists — where its preparation routine comes from and what that routine currently is.
 *
 * The quick editor is still the editor; it opens here in a sheet rather than being replaced, because
 * changing a time is a five-second job and does not want a page of its own. What this page adds is
 * everything the row on Today has no room for.
 */
export function CommitmentDetail({ commitmentId }: { commitmentId: string }) {
  const {
    state,
    ready,
    saving,
    saveEntityCommand,
    saveCommitmentRecurrenceRuleCommand,
    splitCommitmentSourceCommand,
    recalculate
  } = usePortal();
  const [editing, setEditing] = useState<"occurrence" | "series" | null>(null);
  const [draft, setDraft] = useState<CommitmentEditorDraft | null>(null);
  // The version the draft was seeded from, captured alongside it in `openEditor` — not a new field
  // on the draft itself (it must not be re-read live at submit).
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [error, setError] = useState("");
  // Set only when a series save comes back with the `occurrence_in_progress` refusal: the question
  // replaces the form until it is answered or cancelled, but the draft itself is untouched either way.
  const [inProgressQuestion, setInProgressQuestion] = useState(false);
  const now = useNow("minute");
  const prep = useCommitmentPrep(commitmentId);

  const commitment = state.commitments.find((item) => item.id === commitmentId);
  const rule = commitment?.recurrenceRuleId
    ? state.commitmentRecurrenceRules.find((item) => item.id === commitment.recurrenceRuleId)
    : undefined;
  // The flag for a commitment the projection could give no journey figure at all
  // absent means a journey was
  // resolved, or none was needed. Read from the latest stored timeline, the same source the day
  // agenda's own chip reads.
  const travelGap = state.planning?.result?.derivedState?.commitmentTimelines?.find(
    (entry) => entry.id === commitmentId
  )?.travelGap;

  if (!ready)
    return (
      <main className="content-page">
        <p>Loading the commitment…</p>
      </main>
    );
  if (!commitment)
    return (
      <main className="content-page">
        <p className="eyebrow">Fixed commitment</p>
        <h1>That commitment is not here.</h1>
        <p className="reason">
          It may have been cancelled, or it belongs to a plan this browser has not loaded. <a href="/today">Today</a>{" "}
          lists the ones that are.
        </p>
      </main>
    );

  const steps = state.routineSteps
    .filter((step) => step.commitmentId === commitment.id)
    .sort((a, b) => a.sequence - b.sequence);

  /**
   * A source change only rewrites steps on the next forecast persist, so the page asks for one
   * rather than leaving a chip that says "no routine" above the steps it has not dropped yet. Goes
   * through `usePortal()`'s `recalculate` rather than a raw fetch: that carries `runCommand`'s replay
   * guard and the saving/error state every other command sets, and it applies the returned state
   * itself, so there is nothing left here to accept.
   */
  const saveSource = async (source: RoutineSource, presetId: string) => {
    await saveEntityCommand(commitmentRoutineSourceCommand(commitment, source, presetId));
    await recalculate();
  };

  /**
   * The step's own fields go back with the change applied. Nothing here names a routine source: the
   * server flips the commitment to 'custom' because the edit happened, and the chip re-reads it.
   */
  const saveStep = async (step: StoredRoutineStep, edit: RoutineStepEdit) => {
    await saveEntityCommand(routineStepEditCommand(step, edit));
  };

  function openEditor(which: "occurrence" | "series") {
    setError("");
    setEditing(which);
    setDraft(
      which === "series" && rule
        ? commitmentEditorFromRule(rule, state.settings)
        : commitmentEditorFrom(commitment!, state.settings)
    );
    setDraftVersion(which === "series" && rule ? (rule.version ?? null) : (commitment!.version ?? null));
  }
  function closeEditor() {
    setEditing(null);
    setDraft(null);
    setDraftVersion(null);
    setInProgressQuestion(false);
  }

  async function submitEditor(event: FormEvent): Promise<boolean> {
    event.preventDefault();
    if (!draft) return false;
    const message = await saveCommitmentDraft(draft, draftVersion, {
      state,
      saveEntityCommand,
      saveCommitmentRecurrenceRuleCommand
    });
    if (editing === "series" && message && isOccurrenceInProgressRefusal(message)) {
      setError("");
      setInProgressQuestion(true);
      return false;
    }
    setError(message);
    if (message) return false;
    // "The editor is the only place a cancel happens": a save
    // that just cancelled an occurrence or a one-off, with a contact that still resolves, leaves the
    // sheet open so `CommitmentEditor`'s own "Cancelled. Let Sam know?" confirmation stays on screen
    // instead of being closed out from under it. Every other save closes exactly as before.
    // The same goes for "Cancel its N open prep actions too?", which the editor asks after such a save.
    if (
      editing === "occurrence" &&
      draft.status === "cancelled" &&
      (resolveCommitmentContact({ contactId: draft.contactId }, state.conditionDefinitions) ||
        (commitment!.status !== "cancelled" && prep.openPrep.length > 0))
    )
      return true;
    closeEditor();
    return true;
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

  const useTheSeries = async () => {
    await saveEntityCommand(revertCommitmentToSeriesCommand(commitment));
    await recalculate();
  };

  // The detail page never invents places: a one-off search result belongs to the form that created
  // the commitment, and this form is only ever editing one that already exists.
  const refusePlaceSearch = async (_match: GeocodeMatch) => {
    throw new Error("Add a new place from the commitment form on Today.");
  };

  return (
    <main className="content-page commitment-page">
      <a className="back-link" href="/today">
        ← Today
      </a>
      <CommitmentHeader
        commitment={commitment}
        project={state.projects.find((item) => item.id === commitment.projectId)}
        timezone={state.settings.timezone}
        actions={
          <button type="button" className="quiet small" onClick={() => openEditor("occurrence")}>
            Edit
          </button>
        }
      />
      <PlaceTabs />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <CommitmentPlacePanel commitment={commitment} conditionDefinitions={state.conditionDefinitions} />
      {travelGap && (
        <p className="form-warning" role="alert">
          {travelGap === "no_place" ? (
            <>
              No place set — travel can’t be planned.{" "}
              <button type="button" className="quiet small" onClick={() => openEditor("occurrence")}>
                Set it?
              </button>
            </>
          ) : (
            "This place has no travel figure yet — no coordinates, no stored minutes, and no samples. Travel time is a guess (30 minutes assumed)."
          )}
        </p>
      )}
      <CommitmentRecurrencePanel commitment={commitment} rule={rule} onEditSeries={() => openEditor("series")} />
      {commitment.recurrenceRuleId && commitment.scheduleSource === "custom" && (
        <section className="commitment-section" aria-labelledby="commitment-override-heading">
          <div className="section-heading">
            <h2 id="commitment-override-heading">Changed for this date</h2>
          </div>
          <p className="microcopy">
            This occurrence no longer follows the series for its title, times, place and buffers.
          </p>
          <div className="row-actions">
            <button type="button" className="quiet small" onClick={useTheSeries}>
              Use the series
            </button>
          </div>
        </section>
      )}
      <section className="commitment-section" aria-labelledby="commitment-sharing-heading">
        <div className="section-heading">
          <h2 id="commitment-sharing-heading">Family calendar</h2>
        </div>
        {commitment.shareToCalendar ? (
          <p>
            Shared with the family calendar
            {commitment.shareSource === "inherit" && rule ? " · from the series" : " · set on this occurrence"}
          </p>
        ) : (
          <p className="empty">Not shared with the family calendar</p>
        )}
      </section>
      {/* Pulse privacy: effective privacy is
          this occurrence's own flag OR its series rule's. */}
      {(commitment.private || rule?.private) && (
        <p className="microcopy">
          Private — hidden from the published pulse{rule?.private && !commitment.private ? " (from the series)" : ""}.
        </p>
      )}
      <CommitmentRoutinePanel
        commitment={commitment}
        steps={steps}
        presets={state.routinePresets}
        conditionDefinitions={state.conditionDefinitions}
        timezone={state.settings.timezone}
        saving={saving}
        onSaveSource={saveSource}
        onSaveStep={saveStep}
      />
      <ConnectionsSection itemType="commitment" itemId={commitment.id} recurrenceRuleId={commitment.recurrenceRuleId} />
      <CommitmentSources
        commitment={commitment}
        onSplit={(linkId) => splitCommitmentSourceCommand(splitSourceCommand(commitment, linkId))}
      />
      <CommitmentProvenanceFooter commitment={commitment} timezone={state.settings.timezone} />
      <Sheet
        open={Boolean(editing && draft)}
        onClose={closeEditor}
        title={editing === "series" ? "Edit recurring commitment" : "Edit commitment"}
      >
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {editing === "series" && rule && (
          <PerDateChangesWarning count={futureCustomOccurrenceCount(state.commitments, rule.id, now)} />
        )}
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
              onCreatePlaceFromSearch={refusePlaceSearch}
              onCreateContact={(name) => createContact(name, state.conditionDefinitions, saveEntityCommand)}
              projects={state.projects}
              definitions={state.conditionDefinitions}
              timezone={state.settings.timezone}
              open
              storedStatus={commitment.status}
              {...prep}
            />
          )
        )}
      </Sheet>
    </main>
  );
}
