"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createClientId } from "@/shared/client-id";
import {
  deleteReasonAndTags,
  fetchReasonTags,
  putReasonTags,
  type ReasonTagView
} from "@/features/check-in/reason-tag-client";

const SHOWN_AT_FIRST = 5;

/**
 * The correction card for "What pulled you off?" answers on Review: each recent reason with its own words, the tags
 * the local model inferred, and a way to take a tag away, add one in your own words, take your answer back (Reset) or
 * delete the reason. Tags are free text: there is no list to pick from and nothing is suggested while typing. Nothing
 * here feeds back into planning. The card shows nothing until there is a reason to show.
 */
export function ReasonTagsCard() {
  const [reasons, setReasons] = useState<ReasonTagView[] | null>(null);
  const [modelConfigured, setModelConfigured] = useState(false);
  const [all, setAll] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    fetchReasonTags().then(
      (answer) => {
        if (!live) return;
        setLoadError(null);
        setReasons(answer.reasons);
        setModelConfigured(answer.modelConfigured);
      },
      (failure: unknown) => {
        if (live) setLoadError(failure instanceof Error ? failure.message : "The reasons could not be loaded.");
      }
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const replace = useCallback(
    (saved: ReasonTagView) =>
      setReasons((held) => held?.map((item) => (item.checkInId === saved.checkInId ? saved : item)) ?? held),
    []
  );
  const remove = useCallback(
    (checkInId: string) => setReasons((held) => held?.filter((item) => item.checkInId !== checkInId) ?? held),
    []
  );

  if (loadError !== null && reasons === null)
    return (
      <section className="reason-tags" aria-label="Why you left the plan">
        <p className="form-error" role="alert">
          Your reasons could not be loaded: {loadError}
        </p>
        <button className="quiet small" onClick={() => setAttempt(attempt + 1)}>
          Try again
        </button>
      </section>
    );
  if (reasons === null || reasons.length === 0) return null;
  const shown = all ? reasons : reasons.slice(0, SHOWN_AT_FIRST);
  return (
    <section className="reason-tags" aria-label="Why you left the plan">
      <h3 className="reason-tags-title">Why you left the plan</h3>
      <ul className="reason-tags-list">
        {shown.map((item) => (
          <ReasonTagsItem
            key={item.checkInId}
            item={item}
            modelConfigured={modelConfigured}
            onSaved={replace}
            onDeleted={remove}
          />
        ))}
      </ul>
      {reasons.length > SHOWN_AT_FIRST && (
        <button className="quiet small" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${reasons.length}`}
        </button>
      )}
    </section>
  );
}

function ReasonTagsItem({
  item,
  modelConfigured,
  onSaved,
  onDeleted
}: {
  item: ReasonTagView;
  modelConfigured: boolean;
  onSaved: (saved: ReasonTagView) => void;
  onDeleted: (checkInId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const run = (work: Promise<ReasonTagView | void>, done: (saved: ReasonTagView | void) => void) => {
    setBusy(true);
    setError(null);
    work.then(
      (saved) => {
        setBusy(false);
        done(saved);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(failure instanceof Error ? failure.message : "That was not saved. Try again.");
      }
    );
  };
  const save = (tags: string[]) =>
    run(putReasonTags(item.checkInId, { tags }, createClientId()), (saved) => {
      if (saved) onSaved(saved);
      setDraft("");
    });
  const add = (event: FormEvent) => {
    event.preventDefault();
    const tag = draft.trim();
    if (tag === "") return;
    save([...item.tags, tag]);
  };

  const caption =
    item.origin === "corrected"
      ? "Your answer"
      : item.origin === "inferred"
        ? item.stale
          ? "Inferred (an earlier model; it will be redone)"
          : "Inferred"
        : modelConfigured
          ? "No tags yet"
          : "No tags (no local model is set)";
  return (
    <li className="reason-tags-item">
      <p className="reason-tags-words">{item.text}</p>
      <p className="reason-tags-caption" role="status">
        {caption}
      </p>
      <ul className="reason-tags-pills" aria-label="Tags">
        {item.tags.map((tag) => (
          <li key={tag} className="reason-tags-pill">
            <span>{tag}</span>
            <button
              className="quiet small"
              aria-label={`Remove tag ${tag}`}
              disabled={busy}
              onClick={() => save(item.tags.filter((held) => held !== tag))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form className="reason-tags-add" onSubmit={add}>
        <input
          type="text"
          aria-label="Add a tag"
          placeholder="Add a tag in your own words"
          maxLength={40}
          autoComplete="off"
          spellCheck={false}
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="quiet small" disabled={busy || draft.trim() === ""}>
          Add
        </button>
        {item.origin === "corrected" && (
          <button
            type="button"
            className="quiet small"
            disabled={busy}
            onClick={() =>
              run(putReasonTags(item.checkInId, { reset: true }, createClientId()), (saved) => saved && onSaved(saved))
            }
          >
            Reset
          </button>
        )}
        {confirming ? (
          <>
            <button
              type="button"
              className="quiet small"
              disabled={busy}
              onClick={() => run(deleteReasonAndTags(item.checkInId), () => onDeleted(item.checkInId))}
            >
              Delete reason and tags
            </button>
            <button type="button" className="quiet small" disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="quiet small" disabled={busy} onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
