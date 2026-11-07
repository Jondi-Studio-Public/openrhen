# Building the plan

This guide covers how work arrives and is shaped: Inbox, Plan, the deliverable workspace and Review.

## Inbox

Inbox is where things arrive and wait for a decision, in one queue. Nothing in it changes your plan until you confirm it. Chips along the top narrow the queue to one kind, each with its count:

- **Captured**: new thoughts, and changes an agent or tool proposed. A new capture opens with a guess already made (a task, or "at a time" when its text names a clock time) so **Add to plan** is one tap. **Change first** opens every field.
- **Calendar**: events read from a calendar connection and imports waiting for review.
- **Links**: suggested links between records and plan findings.
- **Kept for later**: someday and reference items, filed but not planned. **Review again** sends one back to Captured.

An item can ask a question first, inside its card; it waits until every question is answered. After a decision a note offers **Undo** (for an ignore) or a link to the record it created. **Ignore** keeps the record but never makes planning data.

### Add

The **+**, Inbox **Add or import** and **Go to > Capture a thought** open one sheet: **Capture**, **Paste or photo**, **Workbook or CSV**, **Disruption**. A thought is a proposal in Captured; the rest waits under Calendar. Nothing applies unreviewed.

### Capture

**Change first** offers every classification: Outcome, Project, Action (without a due date it is open work, offered when there is slack and never overdue), Fixed commitment, Deliverable, and Someday or Reference. **Confirm** validates the edited proposal and creates the selected record; **Confirm as tentative** saves a commitment as a "maybe".

### Import

Import is for large amounts of information. AI-assisted and structured imports share one editable review, and every preview waits as a batch until committed.

- **Text and images**: a model proposes records and relationships from pasted text or photos. It preserves uncertainty: a value it cannot tell stays blank and blocks confirmation until you fill it.
- **Workbook and CSV**: columns map onto the importable entities; the Import page can download a template and a field guide.
- **Reference pack**: export your current plan as a reference for an external tool to continue it. Reference sheets are context only and are ignored as import changes.

In review, each row shows its operation (create, update, link), evidence, warnings and errors. Repeating an import with the same keys previews updates, not duplicates. An event you already have from another calendar arrives as **Link to** the existing commitment rather than a second copy. The whole valid batch commits in one transaction, so a failure never writes a partial hierarchy.

## Plan

Plan is where you build the hierarchy and check whether projects mathematically fit. It opens on one sentence saying whether the math works and how many decisions wait.

### Project forecast cards

Each active project can show:

- **Health**: on track, at risk, behind, ahead, or not forecast (too little deadline or scheduling information).
- **Min of work left**, allowing for estimates that run over.
- **Min free before deadline**, and **Min for earlier deadlines** already claimed by projects due sooner.
- **Min left for this**, **Min a week needed** and **Min set aside later**.

A pace line (for example "40% done, 65% of time used") compares what is finished with how far the run to the deadline has gone. A project made only of habits shows how well the habit is kept instead. **Time ahead** shows five bands from the next 7 days to days 91 to 180, with the arithmetic behind each.

### Fields

- **Area**: name, description, status, and **Private**.
- **Outcome**: parent area, title, definition of done, value 1 to 5, optional deadline and review date, status.
- **Project**: parent outcome, title, internal deadline (when you want it finished), external deadline (the true outside date), uncertainty (known, some, high), an optional remaining-effort override, consequence 1 to 5, status, and **Private**.
- **Action**: parent project, title, details, scheduling (once, recurrence, or cadence), optimistic, expected and pessimistic minutes (ascending), remaining minutes, required energy, **requirements** as one or more routes (everything inside a route is needed together; any one route is enough), **preferences** that shade ranking without ever blocking, minimum and maximum session length, whether it is splittable, setup minutes, importance and consequence, availability, due date and latest useful start, **prerequisites** (loops are refused), and status.

Saving uses record-version checks, so an older page cannot silently overwrite a newer edit. Use the remaining-effort override only when you have a better project-level estimate than the sum of actions.

### Archive and cancel

Every plan item has one **Archive** or **Cancel** button instead of a status choice: a finished or retired area, outcome, project, action or deliverable is archived, and abandoned work is cancelled. Closing something that has open items under it asks whether to close them all too. A ten-second **Undo** follows every close, and **Review > Closed** lists everything closed, who closed it and why, with a **Restore** on each.

### The map

**Map** shows areas, outcomes, projects and subjects as a canvas you can re-centre, with derived links (tree, dependencies, shared source, place, contact) between them.

### Deliverable workspace

Use a deliverable for work that needs a completion contract and a step plan, such as an assessment or report. Register the shell in Plan. Work happens only inside a session the engine allocates: when **Now** recommends the deliverable, **Start** opens a timed, editable workspace. The first phase is Breakdown: you and the assistant propose and approve a step plan and completion criteria. Until approved, the deliverable's total effort is unknown rather than zero. The Deliverables tab lists every deliverable with its phase, progress and due date. Ordinary small tasks remain actions.

## Review

Review is a weekly review in three steps, each ticked off when empty: **Clear blockers**, **Wake up stale projects** (nothing done in a week: keep, pause or drop each), and **Choose this week's undated focus**.

- **Proposals**: for a project with a passed internal date the engine names the earliest the remaining effort fits. A project that is behind or at risk lists the smallest changes that would fix it, smallest first: narrow an uncertain estimate, let work split, add time, then move the date.
- **Week ahead**: what the forecast sets aside this week for each project against the pace its deadline needs.
- **Check-ins**: how sampling went, recorded only.
- **Monthly check**: recorded time by area over four weeks, flagging an area with active work but no recorded time as neglected (a signal, never a ranking input).
- **Watch history**: import a Google Takeout YouTube history and Review shows videos watched per day and per hour over the last 30 days (days and hours in your time zone), with a time estimate. See [Watch history](#watch-history).
- **Focus**: which undated projects receive capacity this week and month. Projects with a deadline need no selection.

### Watch history

At [takeout.google.com](https://takeout.google.com) choose only **YouTube and YouTube Music**, then **History**, and set the format to **JSON**. In Review, **Watch history** > **Import Takeout** takes the zip or the `watch-history.json` inside it; the file is read in your browser and sent to your own server. Importing the same file again adds nothing. **Delete this import** removes exactly the entries that file added: an entry two files share stays with whichever was imported first, so deleting the later file keeps it and deleting the earlier one removes it. The history file may be up to 50 MB (inside a zip, 50 MB once unpacked); if yours is larger, export a shorter date range.

- Only YouTube watches are counted. Ads, community posts and YouTube Music plays are kept but listed as not counted. Shorts look the same as other videos in the export.
- Takeout records when a video started, not how long you watched, so the time is a range that leans high. Without lengths each video is credited the gap to the next one (up to two hours; a longer gap starts a new session) and the last video of a session counts for nothing. It is for you to look at; the planner never sees it, and an agent cannot read it.
- **Video lengths** come from the YouTube Data API. Save a key under [Settings > Passwords and keys](settings-and-connections.md#passwords-and-keys); the panel says *Add a YouTube API key in Settings > Passwords and keys to estimate time from video lengths* until you do. After an import, and whenever you press **Fetch video lengths**, the app asks YouTube (through the outbound proxy, 50 videos a call, one quota unit each) for the length of every watched video it does not know yet. With a length, a video is credited the shorter of the gap to the next one and its length, and the last video of a session counts up to its length (at most two hours), so the range narrows and is shown plainly. A private or deleted video, or a live one, has no length and stays in the unknown count. A live or upcoming video is recorded without a length and is not looked up again yet, so it stays unknown even after it ends. If Google's daily quota runs out (the app stops at 9,500 units a day) or the network fails, the run stops cleanly and the next run carries on; nothing is guessed. A key Google rejects, or one that can no longer be opened, is reported in the panel.
- The imports and events are in the backup (backup format 20); video lengths and the saved key are not (the JSON backup leaves them out, and a restore clears what was saved), so after a restore the lengths are fetched again and the key is entered again.

## Recurrence workflow

Choose **Recurrence** for an action that repeats in windows. The estimate is the duration of one occurrence. Set the series start and end and the morning and bedtime fallback clocks: the morning window runs from wake for three hours, and the bedtime window covers the three hours before planned sleep. A routine tile in **Settings > Routines** can link to a recurrence window; its duration then follows the action. Finish a routine with one checklist: checked items complete, unchecked ones stay pending. After the series ends, Review shows expected, completed, missed and unmaterialised counts with **Complete**, **Extend** and **Edit**.

## Cadence workflow

Choose **Cadence** for work where the habit matters more than a finish line: an hour of practice every day, a run every three days. The estimate is one session. **Suggest** offers an interval ("every N days"), a count within each block of days, or a count within the calendar month.

A cadence is never required at a time and never reserves capacity, so deadline work always goes first. It competes for what is left over, pressing harder the longer it goes undone, and **Importance** decides which due cadence wins. **Done for today** closes the cycle, resets remaining effort to the estimate and leaves the action active. **Review > Week ahead** shows how much free time the cadence wants against what fits.
