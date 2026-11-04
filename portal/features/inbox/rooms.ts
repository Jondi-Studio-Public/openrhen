/**
 * The Inbox's rooms: each kind of waiting item, shown as a filter chip over the one queue (see
 * the design notes and the 2026-10-27 portal redesign). Kept free of React so the order,
 * the badge sum and the path lookup can be tested as tables, and so the shell's tab badge and the
 * Inbox's own chips read one definition.
 */
import { mailSource } from "@/state/extensions";

export type RoomId = "emails" | "people" | "captured" | "calendar" | "map" | "kept";

export interface Room {
  id: RoomId;
  /** The chip's address: the queue filtered to this room. Old room addresses keep working this way. */
  href: string;
  label: string;
  /** Whether the room's count says something needs deciding. Kept items are filed, not waiting. */
  badged: boolean;
}

/** Chip order, and the order the unfiltered queue lists its items in. */
export const rooms: readonly Room[] = [
  { id: "emails", href: "/inbox/emails", label: "Emails", badged: true },
  { id: "people", href: "/inbox/people", label: "From people", badged: true },
  { id: "captured", href: "/inbox/captured", label: "Captured", badged: true },
  { id: "calendar", href: "/inbox/calendar", label: "Calendar", badged: true },
  { id: "map", href: "/inbox/map", label: "Links", badged: true },
  { id: "kept", href: "/inbox/kept", label: "Kept for later", badged: false }
];

/** The rooms to show: the Emails room only while a mail provider is installed (it would always be empty otherwise). */
export const visibleRooms = (): readonly Room[] =>
  mailSource() === undefined ? rooms.filter((room) => room.id !== "emails") : rooms;

/** What the queue shows: every waiting item, or one room's. */
export type InboxFilter = "all" | RoomId;

export type RoomCounts = Record<RoomId, number>;

export const emptyRoomCounts: RoomCounts = { emails: 0, people: 0, captured: 0, calendar: 0, map: 0, kept: 0 };

export const roomById = (id: RoomId): Room => rooms.find((room) => room.id === id)!;

/** The address of a filter: `/inbox` for everything, the room's own address otherwise. */
export const filterHref = (filter: InboxFilter): string => (filter === "all" ? "/inbox" : roomById(filter).href);

/**
 * What the Inbox tab badge counts: every room that needs a decision, so the rail, the phone's tab bar
 * and the Inbox's All chip show one total.
 */
export function inboxBadge(counts: RoomCounts): number {
  return rooms.reduce((sum, room) => (room.badged ? sum + counts[room.id] : sum), 0);
}

/** The room a path belongs to, or null for `/inbox` itself and anything outside the Inbox. */
export function roomForPath(pathname: string | null | undefined): Room | null {
  if (!pathname) return null;
  const path = pathname.split(/[?#]/)[0]!.replace(/\/+$/, "");
  return rooms.find((room) => path === room.href || path.startsWith(`${room.href}/`)) ?? null;
}
