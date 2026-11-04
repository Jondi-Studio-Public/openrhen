"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePortal } from "@/state/portal-provider";
import { validateProposal, type ProposalDraft } from "@/features/capture/proposals";
import {
  emptyProposalDraft,
  normalizeProposalDraft,
  proposalDraftFromCapture
} from "@/features/capture/proposal-draft";
import type { CaptureItem } from "@/state/portal-state";
import { mailSource } from "@/state/extensions";
import { placementSuggestion } from "@/features/capture/placement-suggestion";
import { preselectCaptureDraft } from "@/features/capture/capture-chips";
import { allAnswered, applyProposalAnswers, proposalQuestions } from "@/features/capture/proposal-questions";
import {
  captureIgnoreCommand,
  captureKeepAgainCommand,
  captureReopenCommand,
  captureRestoreCommand,
  captureReviewCommand,
  captureUnignoreCommand,
  emailChangeConfirmCommand,
  isKeptForLater
} from "@/features/capture/capture-commands";

const isFiling = (proposalType: ProposalDraft["proposalType"]) =>
  proposalType === "someday" || proposalType === "reference";

/**
 * Lets the Inbox run its exit motion around a confirm that has passed validation: `save` performs the
 * write and settles true when it was saved.
 */
export type ConfirmWrap = (id: string, save: () => Promise<boolean>) => Promise<boolean>;

/**
 * The Capture page's review flow, as state rather than markup: which proposal is open, the draft
 * being edited for it, and the confirm/ignore/cancel moves. The Inbox lays the editor out beside
 * the list on a desk and inside the card on a phone, so the flow cannot belong to either layout.
 */
export function useProposalReview() {
  const { state, addCapture, saveEntityCommand } = usePortal();
  // An Undo runs seconds after the ignore it reverses, so it reads the state as it is then.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProposalDraft>(emptyProposalDraft);
  const [error, setError] = useState("");
  // The reviewed proposal's answers to its open questions, by question field.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Separate from `error`, which renders inside the editor: a failed "Review again" leaves no editor
  // open, so its message belongs beside the kept lists instead.
  const [keptError, setKeptError] = useState("");
  // Likewise for "Restore" under Replaced in the Emails room.
  const [replacedError, setReplacedError] = useState("");
  const pending = state.captures.filter((item) => item.status === "pending");
  // Recently handled lists now live in each room (features/inbox/use-recently-handled), so this
  // hook keeps only what it needs for ordering the kept lists.
  const processedTimestamp = (item: CaptureItem) => new Date(item.reviewedAt ?? item.createdAt).getTime();
  // Someday and Reference items are kept in full, never windowed like "Recently processed": the
  // point of filing something there is that it can still be found months later.
  const kept = state.captures
    .filter(isKeptForLater)
    .slice()
    .sort((a, b) => processedTimestamp(b) - processedTimestamp(a));
  const someday = kept.filter((item) => item.proposalType === "someday");
  const reference = kept.filter((item) => item.proposalType === "reference");
  const reviewing = reviewingId ? (pending.find((item) => item.id === reviewingId) ?? null) : null;

  // Filing as Someday or Reference plans nothing, so a placement question is moot and does not block it.
  const questions = reviewing && !isFiling(draft.proposalType) ? proposalQuestions(reviewing) : [];
  const answered = allAnswered(questions, answers);

  function beginReview(item: CaptureItem) {
    setReviewingId(item.id);
    // An unsorted capture opens already guessed (Task or At a time, a project chosen) so one tap files it.
    setDraft(
      preselectCaptureDraft(
        proposalDraftFromCapture(item),
        item,
        state,
        placementSuggestion(item, state)?.projectId ?? null
      )
    );
    setAnswers({});
    setError("");
  }

  function cancel() {
    setReviewingId(null);
    setDraft(emptyProposalDraft());
    setAnswers({});
    setError("");
  }

  // A Confirm refusal names what to fix; once the person edits, the old reason no longer describes the
  // draft, so it goes until the next Confirm says what (if anything) is still missing.
  const editDraft = (next: ProposalDraft) => {
    setDraft(next);
    setError("");
  };
  const editAnswers: typeof setAnswers = (next) => {
    setAnswers(next);
    setError("");
  };

  async function confirm(tentative = false, wrap?: ConfirmWrap): Promise<boolean> {
    if (!reviewingId) return false;
    if (!answered) {
      setError("Answer the open questions first.");
      return false;
    }
    const withAnswers = applyProposalAnswers(draft, questions, answers, state);
    const normalized = normalizeProposalDraft(withAnswers.draft);
    const validation = validateProposal(state, normalized);
    if (validation) {
      setError(validation);
      return false;
    }
    const command = captureReviewCommand(reviewingId, normalized, state, tentative, withAnswers.answers);
    if (!command) {
      setError("This proposal is no longer available.");
      return false;
    }
    const save = async () => {
      try {
        await saveEntityCommand(command);
        setReviewingId(null);
        setDraft(emptyProposalDraft());
        setAnswers({});
        setError("");
        return true;
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "The reviewed proposal was not saved.");
        return false;
      }
    };
    return wrap ? wrap(reviewingId, save) : save();
  }

  /** Ignores a proposal; settles true once saved, false when there was nothing to ignore or it failed. */
  async function ignore(id: string): Promise<boolean> {
    const command = captureIgnoreCommand(id, new Date().toISOString(), state);
    if (!command) return false;
    try {
      await saveEntityCommand(command);
      if (reviewingId === id) {
        setReviewingId(null);
        setDraft(emptyProposalDraft());
      }
      setError("");
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The proposal was not updated.");
      return false;
    }
  }

  /**
   * The toast's Undo for an ignore: each proposal goes back to waiting, newest version first read from
   * the state as it is now. Throws the first refusal, which the toast shows.
   */
  async function unignore(ids: readonly string[]) {
    for (const id of ids) {
      const command = captureUnignoreCommand(id, stateRef.current);
      if (!command) throw new Error("This proposal is no longer ignored.");
      await saveEntityCommand(command);
    }
  }

  /**
   * Confirms one reasoning-run change with the answers to its open questions. The refusal (an
   * unanswered question, a change built on one not confirmed yet, a target edited since the run) is
   * thrown to the thread card, which shows it on the row.
   */
  async function confirmEmailChange(item: CaptureItem, answers: Record<string, string>) {
    await saveEntityCommand(emailChangeConfirmCommand(item, answers));
  }

  /**
   * Sends a kept item back to Needs review and opens it, since reclassifying it is the only reason
   * to. The editor starts on "Choose type" rather than the old Someday or Reference, which is the
   * one choice the person is certain to change.
   */
  async function reopen(id: string): Promise<boolean> {
    const item = state.captures.find((capture) => capture.id === id);
    const command = captureReopenCommand(id, state);
    if (!item || !command) {
      setKeptError("This item is no longer kept for later.");
      return false;
    }
    try {
      await saveEntityCommand(command);
      setKeptError("");
      setReviewingId(id);
      setDraft({ ...proposalDraftFromCapture(item), proposalType: "unclassified" });
      setError("");
      return true;
    } catch (saveError) {
      setKeptError(saveError instanceof Error ? saveError.message : "The item was not moved back to review.");
      return false;
    }
  }

  /**
   * Ignores a kept item; the same write as Ignore, with its failure shown beside the kept lists.
   * Settles true once saved.
   */
  async function drop(id: string): Promise<boolean> {
    const command = captureIgnoreCommand(id, new Date().toISOString(), state);
    if (!command) {
      setKeptError("This item is no longer kept for later.");
      return false;
    }
    try {
      await saveEntityCommand(command);
      setKeptError("");
      return true;
    } catch (saveError) {
      setKeptError(saveError instanceof Error ? saveError.message : "The item was not dropped.");
      return false;
    }
  }

  /**
   * The toast's Undo for a Drop: files the item again as it was kept, read against the state as it is
   * now. Throws the refusal, which the toast shows.
   */
  async function keepAgain(kept: CaptureItem) {
    const command = captureKeepAgainCommand(kept, stateRef.current);
    if (!command) throw new Error("This item is already kept for later.");
    await saveEntityCommand(command);
  }

  /** Brings a replaced proposal back to Needs review. The server refuses anything that is not replaced. */
  async function restore(id: string) {
    const command = captureRestoreCommand(id, state);
    if (!command) return setReplacedError("This proposal is no longer in Replaced.");
    try {
      await saveEntityCommand(command);
      setReplacedError("");
    } catch (saveError) {
      setReplacedError(saveError instanceof Error ? saveError.message : "The proposal was not restored.");
    }
  }

  // What the registered mail source reads from portal state; nothing without one.
  const emailChangeContext = useMemo(() => mailSource()?.contextFrom(state), [state]);

  return {
    state,
    addCapture,
    emailChangeContext,
    confirmEmailChange,
    pending,
    someday,
    reference,
    keptError,
    replacedError,
    reviewingId,
    reviewing,
    draft,
    setDraft: editDraft,
    questions,
    placementSuggestion: placementSuggestion(reviewing, state),
    answers,
    setAnswers: editAnswers,
    answered,
    error,
    beginReview,
    cancel,
    confirm,
    ignore,
    unignore,
    reopen,
    drop,
    keepAgain,
    restore
  };
}

export type ProposalReview = ReturnType<typeof useProposalReview>;
