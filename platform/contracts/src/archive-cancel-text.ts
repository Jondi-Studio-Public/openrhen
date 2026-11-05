/**
 * The served words for closing a record (archive-removals design 8a): which verb each kind takes, the restore recipe
 * and what is filed for the owner. One owner for the prose; the skill, the guide and the server instructions read it,
 * and a test holds every pair of the verb table to each served text. The kinds named here are the ones in
 * `ARCHIVE_TYPES` and `CANCEL_TYPES` (`closed-entity.ts`), in the words a person says.
 */

/** The short form in `MCP_SERVER_INSTRUCTIONS` (byte-capped). */
export const ARCHIVE_OR_CANCEL_BRIEF =
  "Archive: area, preset, place, contact, capability, live; a finished outcome or project; a done action or " +
  "deliverable. Cancel: appointment, shift, event; an abandoned outcome or project; an open action or deliverable you " +
  "drop. rhen_archive and rhen_cancel take do close|restore and a reason; closed rows show " +
  "their restore call. A save that sets status archived or cancelled, or reopens a closed row, is refused. Past 20 closures in a rolling " +
  "hour (counting the call) a close is filed for the owner.";

/** The full section, as plain bullets, for the skill and the guide. */
export const ARCHIVE_OR_CANCEL_FULL = [
  "Archive or cancel. To remove a record from the plan use rhen_archive or rhen_cancel, each with `do` close or restore. A save that sets status archived or cancelled is refused, and so is a save that reopens a closed row (also in a bulk or a changeset): the refusal names the close or restore call.",
  "ARCHIVE: an area, routine preset, place, contact, capability or live context; a finished or retired outcome or project; a done action or deliverable.",
  "CANCEL: an appointment, shift or event (a commitment); an abandoned outcome or project; an open action or deliverable you drop.",
  "Give a reason (an agent must). include-children also closes the open rows under an area, outcome or project; cancelling a commitment takes its preparation steps with it.",
  "A call that reaches more than 20 rows in one call, or would take agents past 20 closures in a rolling hour (counting this call), or reaches a row the owner must decide (a deadline, a shared appointment), is filed as ONE proposal for the owner to confirm. The hour is a rolling window recounted at every call, not a lockout: small calls that still fit apply. The brake is for token agents.",
  "Taking back a record you just made with rhen_undo closes it with no reason, is not counted, and works only within a day of the create and while nobody else has changed the record.",
  "Restore: every closed row in rhen_list and rhen_show carries its restore call; send it as it stands (do restore, with the row's version). A legacy cancelled area is restored with rhen_cancel.",
  'Ending a recurrence is the owner\'s call (set its end date instead, guide recurrence). When the owner ends one, its future dates are cancelled with the reason "Recurrence ended", not deleted, and setting the rule active again brings those back.',
  "A deliverable save that leaves a step out is refused for an agent, which never deletes a step: cancel an open step or archive a done one first (the refusal names the exact call), then save without it."
] as const;
