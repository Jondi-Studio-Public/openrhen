import { z } from "zod";

/**
 * Photo check-ins. Record-only: nothing in these shapes feeds the plan,
 * a session, the pulse or a check-in's status.
 */

export const PHOTO_CHECKIN_MODES = ["off", "on"] as const;
export const photoCheckinModeSchema = z.enum(PHOTO_CHECKIN_MODES);
export type PhotoCheckinMode = z.infer<typeof photoCheckinModeSchema>;

/** Photo check-ins are on unless the person mutes them; an absent setting reads as this. A stored `shadow` reads as `on`. */
export const DEFAULT_PHOTO_CHECKIN_MODE: PhotoCheckinMode = "on";

export const photoCheckinModeInputSchema = z.object({ mode: photoCheckinModeSchema });

/** The largest photo the ingest route accepts. A phone photo is a few MB; a larger body is refused unread. */
export const PHOTO_MAX_BYTES = 15 * 1024 * 1024;

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

/**
 * The type a photo's own bytes say it is, or null. A client's content-type is never trusted: it is
 * what a browser file picker guessed, and the type decides how the bytes are served back.
 */
export function sniffPhotoType(bytes: Uint8Array): PhotoType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|mif1|msf1)$/.test(ascii(8, 12))) {
    return "image/heic";
  }
  return null;
}

export const photoCheckinMetaSchema = z.object({
  takenAt: z.string().datetime({ offset: true }),
  /** What the person said about the photo, as transcribed on the phone. */
  transcript: z.string().max(4000).default(""),
  /** The check-in slot this answers; omitted for a photo sent unprompted. */
  checkInId: z.string().uuid().optional()
});
export type PhotoCheckinMeta = z.infer<typeof photoCheckinMetaSchema>;

/** The person editing their own description. Never touches the pipeline's reading. */
export const photoCheckinEditSchema = z.object({
  description: z.string().max(4000),
  expectedVersion: z.number().int().min(1)
});
export type PhotoCheckinEdit = z.infer<typeof photoCheckinEditSchema>;

export const PHOTO_CHECKIN_STATUSES = ["pending", "processed", "failed"] as const;

/** One photo check-in as the portal shows it. The photo bytes are fetched separately. */
export interface PhotoCheckinWire {
  id: string;
  takenAt: string;
  checkInId: string | null;
  /** What the check-in slot this answers asked about, frozen when it fired; null for a photo sent unprompted. */
  directiveTitle: string | null;
  transcript: string;
  description: string;
  editedByUser: boolean;
  vlmDescription: string | null;
  agreement: "agrees" | "disagrees" | "unclear" | null;
  status: (typeof PHOTO_CHECKIN_STATUSES)[number];
  statusDetail: string | null;
  originalType: string;
  originalBytes: number;
  version: number;
}
