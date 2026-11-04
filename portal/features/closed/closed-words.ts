import { classifyClosedBy, type ClosedRow } from "@openrhen/contracts";
import { noun } from "./closable-row";

/** Who closed a row, in the words the page shows (the same classifier the server filters use). */
export function closedByText(closedBy: string | null): string {
  const kind = classifyClosedBy(closedBy);
  switch (kind.kind) {
    case "person":
      return "You";
    case "agent":
      return `Agent ${kind.agent}`;
    case "confirmed":
      return `Agent ${kind.agent}, confirmed by you`;
    case "system":
      return "Imported or synced";
    default:
      return "Earlier (unknown)";
  }
}

/** "Action in Quarterly report" or just "Action". */
export function kindLine(row: Pick<ClosedRow, "type" | "parent">): string {
  const label = noun(row.type);
  const cap = label.charAt(0).toUpperCase() + label.slice(1);
  return row.parent ? `${cap} in ${row.parent}` : cap;
}

/** Plural labels for the type filter. */
export const TYPE_FILTER: ReadonlyArray<{ value: ClosedRow["type"]; label: string }> = [
  { value: "area", label: "Areas" },
  { value: "outcome", label: "Outcomes" },
  { value: "project", label: "Projects" },
  { value: "action", label: "Actions" },
  { value: "deliverable", label: "Deliverables" },
  { value: "commitment", label: "Commitments" },
  { value: "routine_preset", label: "Routines" },
  { value: "condition_definition", label: "Contexts" }
];
