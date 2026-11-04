/**
 * The closed-stamp family of the data health check (`plans/archive-removals-design.md`, section 5): every closed
 * record (status in CLOSED_TABLES) carries `closed_at`, every other record does not. A database trigger keeps that
 * true, so a finding here means the trigger was bypassed or missing (a restore from an old dump, a disabled trigger).
 * Counts only; the reader owns the SQL.
 */
import type { DoctorItem } from "./doctor.js";

export interface DoctorClosedSlice {
  /** Per table with a finding: rows holding `closed_at` while not closed, and closed rows with no `closed_at`. */
  tables: { table: string; strayStamp: number; missingStamp: number }[];
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function closedStampItems(slice: DoctorClosedSlice): DoctorItem[] {
  const items: DoctorItem[] = [];
  const stray = slice.tables.filter((t) => t.strayStamp > 0);
  const missing = slice.tables.filter((t) => t.missingStamp > 0);
  const where = (rows: { table: string }[]) => rows.map((t) => t.table.replaceAll("_", " ")).join(", ");
  const total = (rows: { strayStamp: number; missingStamp: number }[], key: "strayStamp" | "missingStamp") =>
    rows.reduce((sum, t) => sum + t[key], 0);
  if (stray.length)
    items.push({
      id: "closed_stamp_stray",
      check: "closed_stamp_stray",
      tier: "tidy",
      area: "facts",
      title: `${plural(total(stray, "strayStamp"), "record")} not closed but stamped as closed (${where(stray)})`,
      why: "A closed time on an open record would put it on the Closed list and hide its real state.",
      handles: [],
      fix: {
        who: "person",
        question: "Ask for the closed stamps on open records to be cleared (the closed-record trigger may be missing)."
      }
    });
  if (missing.length)
    items.push({
      id: "closed_stamp_missing",
      check: "closed_stamp_missing",
      tier: "tidy",
      area: "facts",
      title: `${plural(total(missing, "missingStamp"), "closed record")} with no closed time (${where(missing)})`,
      why: "The Closed list sorts and restores by the closed time, so these would be missing from it.",
      handles: [],
      fix: {
        who: "person",
        question: "Ask for the missing closed times to be filled in (the closed-record trigger may be missing)."
      }
    });
  return items;
}
