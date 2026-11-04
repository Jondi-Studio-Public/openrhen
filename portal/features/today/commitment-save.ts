import type { PlanningEntityCommand, SaveCommitmentRecurrenceRuleCommand } from "@openrhen/contracts";
import type { PortalState, StoredCommitment } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { createPlace } from "@/features/locations/create-place";
import { iso } from "@/features/today/local-datetime";
import type { ConditionDefinition } from "@/features/settings/context-summary";
import type { GeocodeMatch } from "@/features/today/components/location-picker";
import {
  commitmentEntityFrom,
  commitmentRuleFrom,
  revertToSeriesEntity,
  validateCommitmentDraft,
  type CommitmentEditorDraft
} from "./today-drafts";

/**
 * Saving whatever the one commitment editor is holding. The form is mounted in three places now —
 * the quick add on Today, the sheet on a commitment's own page, and the rule editor on Schedule —
 * and every one of them has to pick the same command route from `repeats`, send the expected version
 * its caller seeded the draft from, and refuse the same drafts. Three copies of that drifted the
 * moment one of them learned about a field the others did not, so the branch lives here and the
 * pages only host it.
 */
export interface CommitmentSaveDeps {
  state: PortalState;
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>;
  saveCommitmentRecurrenceRuleCommand: (command: SaveCommitmentRecurrenceRuleCommand) => Promise<void>;
}

/**
 * Answers the series save's `occurrence_in_progress` refusal (the commitment timeline design note,
 * "Who asks"). Absent on the first attempt; the caller resubmits the same draft and version with this
 * set once the reader has answered the question. Only ever sent on the series command — a one-off
 * commitment save has no occurrence to ask about.
 */
export interface CommitmentSaveOptions {
  applyToOccurrenceInProgress?: boolean;
  /** Id for a NEW record, minted when the draft opened, so a retry after a lost response reuses it. */
  newId?: string;
}

/** The one `save_entity` commitment envelope this module builds, for an edit and for **Use the series**. */
function commitmentEntityCommand(
  entity: Record<string, unknown>,
  expectedVersion: number | null
): PlanningEntityCommand {
  return { commandId: createClientId(), expectedVersion, type: "save_entity", entityType: "commitment", entity };
}

/**
 * **Use the series** on an overridden occurrence (the commitment timeline design note, "Undoing an
 * override"), at the version the page holds for it.
 */
export function revertCommitmentToSeriesCommand(commitment: StoredCommitment): PlanningEntityCommand {
  return commitmentEntityCommand(revertToSeriesEntity(commitment), commitment.version ?? null);
}

/**
 * Sends the draft down whichever route `repeats` selects. Returns "" when it was saved, or the
 * sentence to show the reader — a refused draft and a rejected command both leave the form open, so
 * the caller needs no exception handling to tell them apart. A series save refused with the
 * `occurrence_in_progress` message is returned exactly like any other message: the caller checks
 * `isOccurrenceInProgressRefusal` on it to decide whether to show the question instead of the raw text.
 *
 * `expectedVersion` is not looked up here: it is the version the caller's draft was seeded from,
 * supplied explicitly, the way `persist` in `deliverables/page.tsx` takes it. Resolving it internally
 * against `state` would read whatever the draft happens to be at submit time — a moment that can be
 * arbitrarily later than when the draft's body was actually composed — which defeats the optimistic
 * lock the version exists to provide. A caller with no prior record to be stale against (a
 * pure create) passes `null`.
 */
export async function saveCommitmentDraft(
  draft: CommitmentEditorDraft,
  expectedVersion: number | null,
  { state, saveEntityCommand, saveCommitmentRecurrenceRuleCommand }: CommitmentSaveDeps,
  options?: CommitmentSaveOptions
): Promise<string> {
  const invalid = validateCommitmentDraft(draft);
  if (invalid) return invalid;
  const id = draft.id || options?.newId || createClientId();
  if (draft.repeats) {
    try {
      await saveCommitmentRecurrenceRuleCommand({
        commandId: createClientId(),
        expectedVersion,
        rule: commitmentRuleFrom(draft, id, state.settings.timezone),
        ...(options?.applyToOccurrenceInProgress !== undefined
          ? { applyToOccurrenceInProgress: options.applyToOccurrenceInProgress }
          : {})
      });
      return "";
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Recurring commitment was not saved.";
    }
  }
  try {
    await saveEntityCommand(
      commitmentEntityCommand(commitmentEntityFrom(draft, id, state.settings.timezone), expectedVersion)
    );
    return "";
  } catch (cause) {
    return cause instanceof Error ? cause.message : "Commitment was not saved.";
  }
}

/** The commitment a hand entry looks like, as `GET /api/commitments/matches` reports it. */
export interface HandEntryMatch {
  kind: "strong" | "possible";
  id: string;
  title: string;
  startsAt: string;
}

/**
 * The hand-entry check: before a NEW one-off is saved,
 * asks the server whether an existing commitment looks like it. Advisory and never blocking, so any
 * failure — no title yet, a refused draft, a network error, a non-OK answer — reads as no match and
 * the save simply goes ahead. An existing record and a repeating rule are never checked.
 */
export async function findCommitmentMatch(
  draft: CommitmentEditorDraft,
  timezone: string,
  fetcher: typeof fetch = fetch
): Promise<HandEntryMatch | null> {
  if (draft.id || draft.repeats || validateCommitmentDraft(draft)) return null;
  try {
    const query = new URLSearchParams({
      title: draft.title.trim(),
      startsAt: iso(draft.startsAt, timezone),
      endsAt: iso(draft.endsAt, timezone)
    });
    const response = await fetcher(`/api/commitments/matches?${query.toString()}`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { match?: HandEntryMatch | null };
    return body.match ?? null;
  } catch {
    return null;
  }
}

/**
 * A picked place-search result becomes a real stored place at once — flagged one-off so it never
 * enters the general place pickers — and the commitment then references it like any saved place.
 * It is archived automatically once nothing upcoming points at it any more.
 */
export async function createOneOffPlace(
  match: GeocodeMatch,
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>
): Promise<{ id: string; name: string }> {
  return createPlace(match, saveEntityCommand, { oneOff: true });
}

/**
 * Turns a name typed into `ContactPicker` into a real stored `condition_definition` of kind
 * `contact`, `channels: []` — choosing a contact's channels is Settings' job
 * and an empty list resolves unknown, which changes nothing
 * for existing actions. A name that already names a contact — active or archived — picks that
 * contact instead of saving a duplicate: the `(user_id, name)` unique index would refuse a second
 * row under the same name anyway, active or not, so there is no other way to get back a contact
 * someone archived and then typed again. An archived match is reactivated (`status: "active"`)
 * through the same command path rather than returned as-is — otherwise the picker would select an
 * id that still resolves to nothing (`commitment-contact.ts` reads an archived contact as none),
 * silently failing the very save the person just asked for. Keyed by a slug of the name, the same id
 * a hand-typed Settings entry or `createPlace`'s permanent place would get; on a clash with some
 * other condition's id (a location or capability named the same), `-contact` is appended, then a
 * counter, so this never silently overwrites a different kind of condition.
 */
export async function createContact(
  name: string,
  definitions: ConditionDefinition[],
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>
): Promise<{ id: string; name: string }> {
  const trimmed = name.trim();
  const existing = definitions.find((entry) => entry.kind === "contact" && entry.name === trimmed);
  if (existing) {
    if (existing.status === "archived") {
      await saveEntityCommand({
        commandId: createClientId(),
        expectedVersion: (existing.version as number | undefined) ?? null,
        type: "save_entity",
        entityType: "condition_definition",
        entity: { ...existing, status: "active" }
      });
    }
    return { id: existing.id, name: existing.name };
  }
  const base =
    trimmed
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || createClientId();
  let id = base;
  if (definitions.some((entry) => entry.id === id)) {
    let suffix = 1;
    do {
      id = suffix === 1 ? `${base}-contact` : `${base}-contact-${suffix}`;
      suffix += 1;
    } while (definitions.some((entry) => entry.id === id));
  }
  await saveEntityCommand({
    commandId: createClientId(),
    expectedVersion: null,
    type: "save_entity",
    entityType: "condition_definition",
    entity: { id, name: trimmed, kind: "contact", status: "active", channels: [] }
  });
  return { id, name: trimmed };
}
