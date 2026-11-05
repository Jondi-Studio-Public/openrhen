# User guide

OpenRhen answers one practical question: **what should I work on right now?**

It combines your areas, outcomes, projects and concrete actions; how much work remains and how uncertain each estimate is; deadlines, dependencies, energy and the conditions work needs; your capacity and fixed commitments; and what you have already done. It then recommends one action that fits this moment, and says why. The recommendation is not a command: you can block it or choose an alternative, and the reason is recorded.

OpenRhen is pre-1.0 and built for one person per installation. It sends nothing anywhere you have not configured.

## The guides

- [Living the day](living-the-day.md): Now, Day, History.
- [Building the plan](building-the-plan.md): Inbox, Plan, deliverables and Review.
- [Settings and connections](settings-and-connections.md): Settings, Connections, Reports and the command line.

## Your daily path

Four habits cover most days. Each one is detailed in the guide linked.

1. **Capture as things come up.** Tap the **+** (or **Capture** on a desk) and type the thought. It waits in **Inbox > Captured** as a proposal and changes nothing until you press **Add to plan** or **Change first**. See [Building the plan](building-the-plan.md#inbox).
2. **Open Now and do what it says.** Check your place and energy, then press **Start** on the recommendation. **Done** or **Pause** ends the segment, and **How did it go?** asks what happened and what effort remains. If nothing fits, **Not now** and **Something else...** are there; the choice is recorded. See [Living the day](living-the-day.md#now).
3. **Catch up after time away.** When you have been away, Now shows a **Welcome back** line and a catch-up. For each occurrence nobody recorded, pick Done, Skipped, Dropped or Keep open, then use **Settle and close**; the plan recalculates.
4. **Do the weekly review.** Open **Review** (**Weekly review** in **Go to**; it shows **Due** when it is time). It walks through **Clear blockers**, **Wake up stale projects** and **Choose this week's undated focus**. See [Building the plan](building-the-plan.md#review).

Something that has already taken your time goes in as a **Disruption**, straight into the day.

## Beginning

1. Open **Settings** and confirm your timezone, planning horizon, energy meanings and conditions: the places you work, the equipment you use, the people you need. On **Now**, say where you are and what you have with you.
2. Add work with **Capture**, **Import**, or the forms in **Plan**.
3. Open **Settings > Planning** to say how much of your free time is realistically usable, and add fixed commitments from **Day**.
4. Return to **Now**. If an action fits, start it and use the session controls while you work.
5. When you stop, report what happened and how much effort remains.
6. Use **Review** to find planning problems and **History** to inspect recorded sessions.

If **Now** says nothing fits, expand **Why nothing fits**. Usually you need more usable free time, a corrected condition or energy requirement on an action, or a missing dependency resolved.

On a phone, use the browser's **Add to Home Screen** to open OpenRhen full screen. It still needs the server to be reachable; nothing is cached for offline use, and off localhost it needs https.

## Getting around

Five places carry the work: **Now**, **Day**, **Plan**, **Inbox** and **You**. On a phone they are a tab bar with a floating **+**; on a desk they are a rail with **Go to** and a **Capture** button.

- **Inbox** is where everything arrives and waits, in one queue with a chip for each kind of item.
- **You** lists your records (History, Sleep log, Photo check-ins, Reported issues), Connections and the settings groups.
- **Go to** (Ctrl+K, or Cmd+K on a Mac) is one box over every page and setting.
- The **+** opens the capture sheet from any screen. **Capture** saves a thought as a proposal that changes nothing until reviewed. **Disruption** is for something that has already taken the time; it is written straight into the day.

## How planning is organised

Four levels:

1. **Area**: an ongoing part of life, such as Health, Study or Home.
2. **Outcome**: a meaningful result with a definition of done.
3. **Project**: a bounded piece of work contributing to an outcome.
4. **Action**: the next concrete thing that can be worked on in a session.

Only concrete actions are recommended on Now. Other important records:

- **Fixed commitment**: time already occupied, such as a class, appointment or meeting.
- **Dependency**: another item that must finish first.
- **Capture**: unprocessed information that does not affect the plan until reviewed.
- **Import draft**: records proposed from a workbook, CSV, text or images. A draft affects nothing until the whole valid batch is committed.

## Reporting problems

When something looks wrong, use **Report issue** on Now. It saves the plan, the engine's input and result, and the page you were looking at as one snapshot you can replay later, so a problem can be investigated after the plan has moved on. When filing a bug, say what you expected, what happened, which screen and button, roughly when, and whether refreshing changed it. Never include private data in a public issue.

## Boundaries

A background worker keeps the plan, check-ins and any configured connections running while the portal is closed. Out of the box there is no login and the portal listens only on the machine it runs on; read [Locking down the API](../operations/locking-down.md) before reaching it from other devices.
