"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PhotoCheckinMode, PhotoCheckinWire } from "@openrhen/contracts";
import { MODE_LABELS, STATUS_LABELS, formatTaken } from "@/features/photo-checkins/photo-checkin-model";
import { answerOnTrack } from "@/features/check-in/check-in-command";
import { usePortal } from "@/state/portal-provider";
import { usePhotoCheckins } from "@/features/photo-checkins/use-photo-checkins";

const MODES: readonly PhotoCheckinMode[] = ["on", "off"];

/**
 * `/photo-checkins`: take a photo, say what you are doing, and see the trail. Record-only: nothing here
 * changes your plan, a check-in or a session. Until the native app exists the phone's own camera and
 * keyboard dictation do the work. Opened from "Still on X?", a saved
 * photo answers that question as on track and goes back to Now; the photo is the answer.
 */
export function PhotoCheckinPage() {
  const router = useRouter();
  const { pendingCheckIn, dismissPendingCheckIn } = usePortal();
  const trail = usePhotoCheckins({
    onFiledAgainst: async (checkInId, stillHere) => {
      // Another check-in is open now: the photo is kept and this one is not ours to answer.
      if (pendingCheckIn && pendingCheckIn.id !== checkInId) return;
      // Before the first check-in poll has answered (a reload or a deep link) there is no version to
      // send; null asks the server to answer it as it stands, and it refuses one already answered.
      await answerOnTrack(checkInId, pendingCheckIn?.version ?? null, "sheet");
      // The person left while the answer was going: leave them where they are.
      if (!stillHere()) return;
      dismissPendingCheckIn(checkInId);
      router.push("/");
    }
  });
  return (
    <div className="photo-checkins">
      <section aria-labelledby="photo-checkin-mode-heading">
        <h2 id="photo-checkin-mode-heading">Photo check-ins</h2>
        <p className="microcopy">
          A photo of what you are doing and a few words about it. They are kept on your server, and nothing you add here
          changes your plan. Mute them with Off.
        </p>
        <label>
          Mode{" "}
          <select
            aria-label="Photo check-in mode"
            value={trail.mode}
            disabled={trail.busy || trail.status !== "ready"}
            onChange={(event) => void trail.changeMode(event.target.value as PhotoCheckinMode)}
          >
            {MODES.map((mode) => (
              <option key={mode} value={mode}>
                {MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
      </section>

      {trail.status === "error" && (
        <p className="form-error" role="alert">
          {trail.error}{" "}
          <button type="button" onClick={() => void trail.reload()}>
            Try again
          </button>
        </p>
      )}
      {trail.actionError && (
        <p className="form-error" role="alert">
          {trail.actionError}
        </p>
      )}
      {trail.notice && <p role="status">{trail.notice}</p>}

      {trail.status === "ready" && trail.mode === "off" && (
        <p className="microcopy">Photo check-ins are off. Choose On to start collecting them.</p>
      )}
      {trail.status === "ready" && trail.mode !== "off" && <CaptureForm busy={trail.busy} onSubmit={trail.upload} />}

      <section aria-labelledby="photo-checkin-trail-heading">
        <h2 id="photo-checkin-trail-heading">Trail</h2>
        {trail.status === "loading" && <p role="status">Loading…</p>}
        {trail.status === "ready" && trail.photos.length === 0 && <p className="microcopy">No photos yet.</p>}
        <ul className="photo-checkin-trail">
          {trail.photos.map((photo) => (
            <PhotoRow
              key={`${photo.id}:${photo.version}`}
              photo={photo}
              busy={trail.busy}
              onSave={trail.saveDescription}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function CaptureForm({
  busy,
  onSubmit
}: {
  busy: boolean;
  onSubmit: (photo: File, transcript: string) => Promise<boolean>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [transcript, setTranscript] = useState("");
  const input = useRef<HTMLInputElement>(null);
  return (
    <form
      className="photo-checkin-capture"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!file) return;
        if (await onSubmit(file, transcript.trim())) {
          setFile(null);
          setTranscript("");
          if (input.current) input.current.value = "";
        }
      }}
    >
      <label>
        Photo
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </label>
      <label>
        What are you doing?
        <textarea
          rows={3}
          value={transcript}
          maxLength={4000}
          onChange={(event) => setTranscript(event.target.value)}
          placeholder="Say it with your keyboard's microphone: where you are, what you are doing, who is with you."
        />
      </label>
      <button type="submit" disabled={busy || !file}>
        {busy ? "Saving…" : "Save check-in"}
      </button>
    </form>
  );
}

function PhotoRow({
  photo,
  busy,
  onSave
}: {
  photo: PhotoCheckinWire;
  busy: boolean;
  onSave: (photo: PhotoCheckinWire, description: string) => Promise<boolean>;
}) {
  const [description, setDescription] = useState(photo.description);
  const changed = description !== photo.description;
  return (
    <li className="photo-checkin-row">
      {/* eslint-disable-next-line @next/next/no-img-element -- a private, no-store route; next/image would proxy and cache it */}
      <img
        src={`/api/photo-checkins/${photo.id}/photo`}
        alt={`Photo taken ${formatTaken(photo.takenAt)}`}
        loading="lazy"
        width={120}
      />
      <div>
        <p>
          <strong>{formatTaken(photo.takenAt)}</strong> <span className="microcopy">{STATUS_LABELS[photo.status]}</span>
        </p>
        {photo.directiveTitle && <p className="microcopy">The plan said: {photo.directiveTitle}</p>}
        <label>
          Your description
          <textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        {photo.editedByUser && <p className="microcopy">Edited by you.</p>}
        {photo.vlmDescription && <p className="microcopy">What the pipeline saw: {photo.vlmDescription}</p>}
        <button type="button" disabled={busy || !changed} onClick={() => void onSave(photo, description)}>
          Save description
        </button>
      </div>
    </li>
  );
}
