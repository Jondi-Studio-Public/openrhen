import { createHash } from "node:crypto";
import type { Fields } from "./demo-data-planning.js";
import type { Shifter } from "./demo-dates.js";

/**
 * Inbox content: raw captures, kept (someday/reference) items, the email_change captures the Emails
 * tab renders, agent proposals, a previewed calendar import and any private-feature rows. Dates are
 * anchored to the fictional "today" of Tue 2026-10-27; text that names a day is built from the
 * shifter so the weekday matches the date it shows.
 */

/** RFC 4122 version 5 UUID, to mint the same ids the portal would for a name. */
export function uuidV5(name: string, namespace = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(name)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type PlainCapture = { text: string; area?: string };

/** Plain captures made with `capture`; `key` is the stable start of the text used to spot an earlier run. */
export function plainCaptures(shifter: Shifter): (PlainCapture & { key: string })[] {
  const swim = `Mia's swimming lessons start ${shifter.label("2026-11-05", "long")} at 4pm?`;
  return [
    { text: "Ring plumber about the dripping laundry tap", area: "Home", key: "Ring plumber" },
    { text: "Noah's school hat is missing - check lost property", area: "Home", key: "Noah's school hat" },
    {
      text: "Idea: use the college lab to test VLANs on the real switch before the report",
      area: "Study",
      key: "Idea: use the college lab"
    },
    { text: "Ask Dana if I can swap my Saturday for Sunday", area: "Work", key: "Ask Dana if I can swap" },
    { text: "Dad's birthday present - something for the garden?", key: "Dad's birthday present" },
    { text: "Look into a UPS for the home server", area: "Projects", key: "Look into a UPS" },
    { text: "Dentist said flossing more - set a daily reminder?", area: "Health", key: "Dentist said flossing" },
    { text: swim, area: "Home", key: "Mia's swimming lessons start" }
  ];
}

export type SavedCapture = { key: string; payload: Fields };

const kept = (text: string, proposalType: "someday" | "reference", at: string): SavedCapture => ({
  key: text,
  payload: {
    text,
    proposalType,
    proposedFields: { title: text },
    sourceType: "manual_capture",
    status: "confirmed",
    createdAt: at,
    reviewedAt: at
  }
});

/** Saved with `save capture --from`. `projectId` is the stored id of "House and car admin". */
export function classifiedCapture(houseProjectId: string): SavedCapture {
  const text = "Renew volunteer background check before it expires on Nov 30";
  return {
    key: text,
    payload: {
      text,
      proposalType: "action",
      proposedFields: {
        title: "Renew volunteer background check",
        projectId: houseProjectId,
        estimatedMinutes: 30,
        deadlineAt: "2026-11-27T17:00:00-05:00"
      },
      questions: [
        {
          field: "energy",
          question: "How much energy does this need?",
          suggestions: ["low", "medium"],
          input: "text"
        }
      ],
      sourceType: "manual_capture",
      status: "pending",
      createdAt: "2026-10-27T09:55:00-04:00"
    }
  };
}

export const KEPT_CAPTURES: SavedCapture[] = [
  kept("Someday: build a Raspberry Pi weather station for the veggie patch", "someday", "2026-10-20T20:00:00-04:00"),
  kept("Someday: learn Rust properly", "someday", "2026-10-18T21:00:00-04:00"),
  kept("Someday: family trip to the national parks over the summer break", "someday", "2026-10-12T19:30:00-04:00"),
  kept("Reference: home server static IP 192.0.2.10 and router admin notes", "reference", "2026-10-15T21:10:00-04:00"),
  kept("Reference: college student ID and Canvas help desk phone", "reference", "2026-10-10T08:00:00-04:00")
];

export type Proposal = { key: string; summary: string; payload: Fields };

function proposedAction(
  id: string,
  projectId: string,
  title: string,
  minutes: number,
  deadlineAt: string,
  importance: number
): Fields {
  return {
    id,
    projectId,
    title,
    status: "planned",
    optimisticMinutes: Math.max(5, Math.floor(minutes / 2)),
    expectedMinutes: minutes,
    pessimisticMinutes: Math.floor(minutes * 1.6),
    remainingMinutes: minutes,
    energy: "low",
    minimumSessionMinutes: Math.min(minutes, 15),
    maximumSessionMinutes: minutes,
    splittable: false,
    setupMinutes: 0,
    importance,
    consequence: 3,
    contexts: ["cap-phone"],
    dependencyIds: [],
    deadlineAt
  };
}

/** Agent proposals for `propose entity_command`; `--coalesce-key` makes a repeat run a no-op. */
export function proposals(shifter: Shifter, houseProjectId: string, dentalProjectId: string): Proposal[] {
  return [
    {
      key: "prop-plumber",
      summary: "Add action: Call plumber about the dripping laundry tap (from your capture this morning)",
      payload: {
        command: "save_action",
        body: {
          expectedVersion: null,
          action: proposedAction(
            "a-prop-plumber",
            houseProjectId,
            "Call plumber about the dripping laundry tap",
            15,
            "2026-10-30T17:00:00-04:00",
            3
          )
        }
      }
    },
    {
      key: "prop-floss",
      summary: "Add action: Book a hygienist visit in 6 months (dentist note from your capture)",
      payload: {
        command: "save_action",
        body: {
          expectedVersion: null,
          action: proposedAction(
            "a-prop-hygienist",
            dentalProjectId,
            "Book a hygienist visit for April",
            5,
            "2026-11-13T17:00:00-05:00",
            2
          )
        }
      }
    },
    {
      key: "prop-swim",
      summary: `Add commitment: Mia's swimming lesson, ${shifter.label("2026-11-05")} 4:00-4:45pm`,
      payload: {
        command: "save_entity",
        body: {
          expectedVersion: null,
          type: "save_entity",
          entityType: "commitment",
          entity: {
            id: "cm-prop-swim",
            title: "Mia's swimming lesson",
            startsAt: "2026-11-05T16:00:00-05:00",
            endsAt: "2026-11-05T16:45:00-05:00",
            status: "tentative",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 10,
            presence: "blocking",
            shareToCalendar: true
          }
        }
      }
    }
  ];
}
