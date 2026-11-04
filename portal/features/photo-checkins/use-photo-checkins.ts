"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PhotoCheckinMode, PhotoCheckinWire } from "@openrhen/contracts";
import {
  editPhotoDescription,
  fetchPhotoCheckins,
  setPhotoCheckinMode,
  uploadPhotoCheckin
} from "@/features/photo-checkins/photo-checkin-client";
import { takenAtFor } from "@/features/photo-checkins/photo-checkin-model";

export type PhotoCheckinLoad = "loading" | "ready" | "error";

/**
 * The photo check-in trail as state. Loaded on mount and after every change so what shows is what the
 * server holds. A failed read keeps what was last loaded and says so; a failed change leaves the trail as it
 * was and reports beside the control that raised it. One change runs at a time.
 */
export function usePhotoCheckins(
  options: {
    onFiledAgainst?: (checkInId: string, stillHere: () => boolean) => Promise<string | void>;
  } = {}
) {
  const { onFiledAgainst } = options;
  const [mode, setMode] = useState<PhotoCheckinMode>("on");
  const [photos, setPhotos] = useState<PhotoCheckinWire[]>([]);
  const [status, setStatus] = useState<PhotoCheckinLoad>("loading");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const trail = await fetchPhotoCheckins();
      if (!alive.current) return;
      setMode(trail.mode);
      setPhotos(trail.photos);
      setStatus("ready");
      setError("");
    } catch (loadError) {
      if (!alive.current) return;
      setStatus("error");
      setError(loadError instanceof Error ? loadError.message : "The photo check-ins could not be loaded.");
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- sets state only after the awaited request settles
    void load();
  }, [load]);

  const run = useCallback(
    async (change: () => Promise<string | void>): Promise<boolean> => {
      setBusy(true);
      setActionError("");
      setNotice("");
      try {
        const message = await change();
        if (!alive.current) return true;
        if (message) setNotice(message);
        await load();
        return true;
      } catch (changeError) {
        if (alive.current) {
          setActionError(changeError instanceof Error ? changeError.message : "That did not work.");
        }
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [load]
  );

  return {
    mode,
    photos,
    status,
    error,
    actionError,
    notice,
    busy,
    reload: load,
    changeMode: (next: PhotoCheckinMode) => run(() => setPhotoCheckinMode(next)),
    upload: (photo: File, transcript: string) =>
      run(async () => {
        // The prompt this upload started from, read before the wait: the photo answers that one, even when
        // a duplicate comes back filed against another check-in.
        const initiating = promptedCheckInId();
        const result = await uploadPhotoCheckin({
          photo,
          transcript,
          takenAt: takenAtFor(photo, new Date()),
          ...initiating
        });
        const saved = result.duplicate ? "That photo was already saved." : "Saved.";
        const checkInId = initiating.checkInId ?? (result.duplicate ? undefined : result.photo.checkInId);
        // The photo is kept whatever happens next; a check-in that cannot be answered says so beside it.
        // Once the page is gone nothing answers or navigates: the person has moved on.
        if (checkInId && onFiledAgainst && alive.current) {
          try {
            return (await onFiledAgainst(checkInId, () => alive.current)) || saved;
          } catch (answerError) {
            const why = answerError instanceof Error ? answerError.message : "The check-in was not answered.";
            return `${saved} The check-in was not answered: ${why}`;
          }
        }
        return saved;
      }),
    saveDescription: (photo: PhotoCheckinWire, description: string) =>
      run(async () => {
        await editPhotoDescription(photo.id, description, photo.version);
      })
  };
}

/** The check-in whose "Add a photo" link opened this page, so the photo is filed against it. */
function promptedCheckInId(): { checkInId?: string } {
  if (typeof window === "undefined") return {};
  const id = new URLSearchParams(window.location.search).get("checkIn");
  return id ? { checkInId: id } : {};
}
