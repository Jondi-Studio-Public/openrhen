---
name: openrhen-writing
description: How to create and change records in the owner's OpenRhen correctly: save and the typed save tools, changesets for brain dumps, versions and conflicts, basis and evidence, undo, recurrence, bulk. Read before your first create or update in a session.
metadata: {"openclaw":{"emoji":"🧭"}}
---

# Writing records

Your writes normally apply at once and are reversible; some are filed as proposals instead (a catch-up settle, a timezone change), and the answer says which. Never guess a value: if a field is not in the schema or
in what they said, ask. The portal shows it under Review > Agent changes.

## Pick the tool

- Something to remember with no detail yet: `rhen_capture` with their words. It waits in their Inbox.
- One concrete record: the typed tools `rhen_save_action`, `rhen_save_project`,
  `rhen_save_commitment`, `rhen_save_capture`. Their `fields` object has a JSON Schema listing every
  field, type and allowed value. Other kinds (area, outcome, deliverable, routine and so on) use
  `rhen_save` with `entityType` and `fields` as one object (`set` key=value works for dotted edits).
- A brain dump or several related records: one `rhen_changeset`. Say back in one short list what you are
  about to write, `preview` first, ask them about anything `checkWithOwner` names, then `apply` with the
  `command-id` and the `previewHash` (as `expect`) the preview printed. It keeps all or none, and
  `rhen_undo` reverses it as one.
- If the owner cannot be asked about a `checkWithOwner` reason, do not apply the whole list. Apply the intents
  that are clean, drop the doubtful one from the list (a likely duplicate, an intent with a `question`), preview again, apply
  that list, park the dropped one with `rhen_capture` carrying their words, and say so afterwards. A refused or conflicting intent is
  never applied around: re-read and preview again. An apply must repeat its preview's `changes`, `basis` and
  `evidence` unchanged, or it is refused as different from the preview.
- Many existing records of one kind patched the same way: `rhen_bulk` (it cannot create). It always needs
  `yes` unless `dry-run`, and a bulk over 20 rows is filed for them to confirm.

Look up ids with `rhen_search` or `rhen_list` first; filters accept titles. Search finds only what
is still in play: a past appointment or a finished action needs `status` `any`, or a listed time window.
`rhen_map` shows one item's neighbourhood.

## Create or update

- No id creates. An id updates that record, your fields merged over the stored ones. An id that names no record is
  refused ("No <kind> has the id ...", exit 4), not turned into a duplicate. Pass `create: true` to make one with
  an id you chose; kinds whose create needs a chosen id (`condition_definition`, places) need it.
- A field the kind does not take is refused with the kind's field list. `createdAt` and `updatedAt` from an
  echoed read are dropped. Read-only joined fields (a project's area or value, a commitment's sources) cannot
  be saved.
- Status synonyms map to the kind's own word (completed becomes done on an action, canceled becomes cancelled);
  a status the kind lacks is refused with its allowed list. Numbers are real numbers, and `payload-json`,
  `verdicts-json` and `targets-json` take real objects or arrays.
- A done action takes `completedAt`. `blockingReason` and `note` can go in an action's fields.
- A new action fills what you leave out with defaults and lists them in `assumedFields`: one estimate figure
  (say `expectedMinutes` 45) fills the other two. Ask them for real figures rather than echoing defaults back.
  That fill-in applies on create only. When you change an estimate on an existing action, send `optimisticMinutes`,
  `expectedMinutes` and `pessimisticMinutes` together, in order (for example 30/45/60), or the write is refused
  as out of order.
- A date-time field such as `deadlineAt` is ISO 8601 with the owner's UTC offset (`rhen_status` names their
  `timezone`). Work a relative date out from `status.now`; if "next Friday" could mean two dates, ask. A
  `rhen_history` `from` and `to` take `YYYY-MM-DD` only, not offsets or `today`.
- Removing is rhen_archive or rhen_cancel (do close, or restore), never a status set through rhen_save; marking work done is an ordinary write. Undo covers both. There is no delete; see the rhen skill for which verb takes which kind.

## Every write

- Set `basis`: `stated` when they said it in this conversation, with their words (up to 300 characters) in
  `evidence`; `inferred` when you worked it out; `observed` when it came from mail, a page or a file.
- Updating a record you read: pass its version as `expected-version` (a new record has none, and other tools
  don't take it). If it changed since, the save is refused (exit 3, naming the current version). Re-read, check
  your change still holds, and try again from the fresh copy; never force the old value through.
- Give every write a `command-id`: one fresh uuid per intended write. A write that times out may have landed;
  resend it only as the identical call with the identical `command-id`. A changed write after a conflict or
  re-read is a new write with a new uuid. `rhen_undo` takes no `command-id`; retry it with `id` (get ids
  with `list` true).
- A change that fans out to many records asks for `yes`. Add it only if you meant the fan-out.
- After writing, re-read (`rhen_status` or `rhen_show`) and tell them what the plan now says. One
  line per change, not a transcript.

## Undo

`rhen_undo` reverses your latest write (or one by `id`) and `redo` puts it back. It restores the rows
exactly, and refuses if someone changed them since; then fix it by hand with `rhen_save`. It covers
confirms, sessions, check-ins, catch-up settles and each row of a bulk edit (one undo per row). A deliverable move
(`rhen_deliverable`) is recorded as one write; its notes, email and an import are not. If you are unsure a change is what they want, ask. If you cannot, use
`rhen_propose` (only when you cannot ask them); check the outcome with `rhen_proposals` and stop proposing shapes they rejected.

## Recurrence

Three kinds: a recurring commitment (a rule), a recurring action (occurrences), and a cadence action (a repeat
interval, done outside the app). Read the `recurrence` topic of `rhen_guide` before creating one. End a
series by setting its end date; ending by status is refused. A commitment series: `rhen_recurrence`
`subcommand` `set` with `id` (the rule), `set` `endDate=YYYY-MM-DD` and `yes` true. A recurring action's own
goal: `subcommand` `end` with `target` (its id or exact title). Only on the owner's words. Log a cadence
completion with `rhen_cadence`.

## Spans

A trip or block of days that is not work and not a commitment: `rhen_span`. It is display only (it never
blocks time or moves work). A session is work you did; a commitment is time that must be protected.
