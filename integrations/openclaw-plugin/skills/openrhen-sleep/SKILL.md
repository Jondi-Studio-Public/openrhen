---
name: openrhen-sleep
description: Logging a night's sleep, a lone wake or a bedtime in the owner's OpenRhen, correcting or removing a night, and what a short night does and does not change. Read whenever they mention sleeping, waking, or a missed night.
metadata: {"openclaw":{"emoji":"🧭"}}
---

# Sleep

- "I slept 11:40 pm to 7:30 am" is a night: `rhen_save` with `entityType` `sleep-log-entry` and `set`
  `sleepAt=...` and `wakeAt=...`, each with their UTC offset (for example `2026-10-26T23:40:00<offset>`; `rhen_status`
  names their `timezone`, so take the offset from it). The wake cannot be in the future.
- "I woke at 7:30" is a wake: `rhen_wake` with `at=<time>`, and `slept-at` if they say when they went to
  sleep. It finishes a sleep still running or completes last night's planned one, and with neither it records
  only the wake. Do not invent a bedtime to make the wake a night.
- To correct a night, update that night; never save a second one. Find its `id` with `rhen_list`
  (`sleep-plans`), then `rhen_save` `sleep-log-entry` with that `id` and the right `sleepAt` and
  `wakeAt`. A night that did not happen: that `id` with `set` `remove=true`.
- A night that overlaps one already recorded, or a sleep still running, is refused with that night's id in the
  error. Nights that touch (one ends as the next starts) are fine. A running sleep ends with
  `rhen_activity` (`finish`), not with a logged wake.
- A missed night can be corrected after the fact; ask them the times rather than estimating.
- A short night does not reduce the capacity the plan assumes or add sleep debt. Do not warn them to do less
  or offer to cut the day; the goal is fewer short nights, and after one they still do as much.
- Bedtime, wake time, desired and minimum sleep are plan preferences (`rhen_save` `settings`); they apply
  directly and undo covers them.
