"use client";

import { useId, useState } from "react";
import { isClosedStatus, verbFor, type CloseType, type CloseVerb } from "@openrhen/contracts";
import { Button } from "@/components/ui/button";
import { usePortal } from "@/state/portal-provider";
import { closableRowIn, noun } from "../closable-row";
import { useCloseEntity } from "../use-close-entity";
import styles from "./close-control.module.css";

/**
 * The one Archive, Cancel or Restore control a record carries (archive-removals design, section 6). Which verb it
 * offers follows the row's state (`verbFor`): an action or deliverable that is finished is archived and an open one is
 * cancelled, an area, routine or context is archived, a commitment is cancelled, and an active outcome or project is
 * either, so it opens a two-choice question. A closed row shows Restore. A row that is open in a status the rules do
 * not know shows nothing, never a Restore the server would refuse.
 *
 * Everything goes through `POST /api/commands/close` (so a person's close is stamped `person` and cascades like an
 * agent's), with an Undo toast. The questions ("Close all?", Archive or Cancel) are inline, not a second modal, because
 * this control lives inside an editor's own sheet. `dirty` disables it while the editor holds unsaved edits, since the
 * close would bump the version under them; `onDone` runs after a success so the editor can close.
 */
export function CloseControl({
  type,
  id,
  dirty = false,
  onDone
}: {
  type: CloseType;
  id: string;
  dirty?: boolean;
  onDone?: (() => void) | undefined;
}) {
  const { state } = usePortal();
  const closer = useCloseEntity();
  const [choosing, setChoosing] = useState(false);
  const hintId = useId();
  const row = closableRowIn(state, type, id);
  if (!row) return null;
  const what = noun(type);
  const target = { type, id, title: row.title, version: row.version };

  async function close(verb: CloseVerb) {
    setChoosing(false);
    const outcome = await closer.close(target, verb);
    if (outcome.ok) onDone?.();
  }

  if (isClosedStatus(row.status)) {
    if (row.version === undefined) return null;
    const restoreVerb: CloseVerb = row.status === "archived" ? "archive" : "cancel";
    return (
      <div className={styles.control}>
        <Button
          disabled={closer.busy || dirty}
          aria-label={`Restore ${what} "${row.title}"`}
          onClick={async () => {
            const outcome = await closer.restore({ ...target, version: row.version!, restoreVerb });
            if (outcome.ok) onDone?.();
          }}
        >
          Restore
        </Button>
        {closer.error && (
          <p className={styles.error} role="alert">
            {closer.error}
          </p>
        )}
      </div>
    );
  }

  const verb = verbFor(type, row.status);
  if (verb === null) return null;
  const label = verb === "either" ? `Close ${what}…` : `${verb === "archive" ? "Archive" : "Cancel"} ${what}`;

  if (closer.pending) {
    return (
      <div className={styles.control}>
        <div className={styles.question} role="group" aria-label={`Close everything under ${row.title}?`}>
          <p>{closer.pending.message}</p>
          <Button variant="danger" disabled={closer.busy} onClick={async () => {
            const outcome = await closer.confirmChildren();
            if (outcome.ok) onDone?.();
          }}>
            Close all
          </Button>
          <Button disabled={closer.busy} onClick={closer.dismissChildren}>
            Keep open
          </Button>
        </div>
        {closer.error && (
          <p className={styles.error} role="alert">
            {closer.error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.control}>
      <Button
        variant="secondary"
        disabled={closer.busy || dirty}
        aria-label={`${label.replace(/…$/, "")} "${row.title}"`}
        aria-describedby={dirty ? hintId : undefined}
        aria-expanded={verb === "either" ? choosing : undefined}
        onClick={() => (verb === "either" ? setChoosing((open) => !open) : void close(verb))}
      >
        {label}
      </Button>
      {dirty && (
        <p className={styles.hint} id={hintId}>
          Save or discard your changes first.
        </p>
      )}
      {verb === "either" && choosing && (
        <div className={styles.question} role="group" aria-label={`How should ${row.title} be closed?`}>
          <Button disabled={closer.busy} onClick={() => void close("archive")}>
            Archive (finished or retired)
          </Button>
          <Button disabled={closer.busy} onClick={() => void close("cancel")}>
            Cancel (abandoned)
          </Button>
        </div>
      )}
      {closer.error && (
        <p className={styles.error} role="alert">
          {closer.error}
        </p>
      )}
    </div>
  );
}
