/**
 * The five places, the pages each one owns, and every destination the Go to palette can reach. Kept
 * free of React so the highlighting rule can be tested as a table, and so the phone tab bar, the desk
 * rail, the place sub-tabs and the palette read one list rather than several that drift apart.
 */
import { calendarSinkConnection, connectionRegistry } from "@openrhen/contracts";
import { withExtensionDestinations, withExtensionOwnership } from "./nav-extensions";
import "./addon-nav";
import "./private/index";

/** Palette keywords naming the shared-calendar connection, when one is registered (the registry supplies the name). */
const sinkKeyword = calendarSinkConnection()?.id ?? "";
/** Palette keywords naming each registered model provider, so a provider added by a manifest is findable without editing this list. */
const modelProviderKeywords = connectionRegistry()
  .filter((manifest) => manifest.capabilities.includes("model_provider"))
  .map((manifest) => manifest.id)
  .join(" ");
const withSink = (words: string) => [words, sinkKeyword].filter(Boolean).join(" ");

export type PrimaryTab = "now" | "day" | "plan" | "inbox" | "you";

export interface NavItem {
  tab: PrimaryTab;
  href: string;
  label: string;
}

/** The same five on a phone and a desk. Day is Today and the week; Plan holds its own tabs; You holds
 * records, people, connections and settings. */
export const primaryTabs: readonly NavItem[] = [
  { tab: "now", href: "/", label: "Now" },
  { tab: "day", href: "/today", label: "Day" },
  { tab: "plan", href: "/plan", label: "Plan" },
  { tab: "inbox", href: "/inbox", label: "Inbox" },
  { tab: "you", href: "/you", label: "You" }
];

/** A tab inside a place, drawn under the page's own header strip. */
export interface PlaceTab {
  href: string;
  label: string;
  /** Other path prefixes this tab owns (a commitment's detail belongs to the week). */
  owns?: readonly string[];
}

/** Places that split into tabs. Day's are a Day/Week switch; Plan's are its four sections. */
export const placeTabs: Readonly<Partial<Record<PrimaryTab, readonly PlaceTab[]>>> = {
  day: [
    { href: "/today", label: "Day" },
    { href: "/schedule", label: "Week", owns: ["/commitments"] }
  ],
  plan: [
    { href: "/plan", label: "Areas" },
    { href: "/deliverables", label: "Deliverables" },
    { href: "/map", label: "Map" },
    { href: "/review", label: "Review" }
  ]
};

/** One place the palette can open, with the words it also answers to. */
export interface Destination {
  href: string;
  label: string;
  /** Where it lives, shown beside it: "You › Settings". */
  where: string;
  keywords?: string;
  /** Set on an action: the capture sheet half it opens instead of navigating. */
  action?: "capture" | "disruption";
  /** Words that put this entry above every page when they are the first thing typed. */
  firstFor?: readonly string[];
}

/**
 * Things the palette does rather than opens. They open the capture sheet, so Ctrl K then "capture"
 * lands in a box to type in, not on a list. They rank above any page for the words people reach for.
 */
export const paletteActions: readonly Destination[] = [
  {
    href: "action:capture",
    label: "Capture a thought",
    where: "Add",
    keywords: "capture add note task thought idea remember",
    action: "capture",
    firstFor: ["capture", "add", "note", "task"]
  },
  {
    href: "action:disruption",
    label: "Something came up",
    where: "Add",
    keywords: "capture add note task disruption came up late cancelled",
    action: "disruption",
    firstFor: ["capture", "add", "note", "task"]
  }
];

/**
 * Everything reachable by name. Pages that used to sit in the rail's groups are here, so nothing is
 * lost by the rail only listing the five places.
 */
export const destinations: readonly Destination[] = withExtensionDestinations([
  { href: "/", label: "Now", where: "Now", keywords: "home next recommendation session" },
  { href: "/catch-up", label: "Catch up", where: "Now", keywords: "away break back" },
  { href: "/today", label: "Today", where: "Day", keywords: "timeline day plan" },
  { href: "/today#direction", label: "Today's direction", where: "Day", keywords: "wins defer focus" },
  { href: "/schedule", label: "This week", where: "Day", keywords: "week calendar schedule recurring commitments" },
  { href: "/plan", label: "Areas", where: "Plan", keywords: "outcomes projects capacity time ahead" },
  { href: "/deliverables", label: "Deliverables", where: "Plan", keywords: "breakdown work" },
  { href: "/map", label: "Plan map", where: "Plan", keywords: "links connections graph subjects" },
  { href: "/review", label: "Weekly review", where: "Plan", keywords: "review weekly monthly stale agent changes" },
  {
    href: "/review/closed",
    label: "Closed items",
    where: "Plan › Review",
    keywords: "closed archived cancelled restore undo"
  },
  { href: "/review/focus", label: "Undated project focus", where: "Plan › Review", keywords: "undated focus" },
  { href: "/inbox", label: "Inbox", where: "Inbox", keywords: "decide review proposals" },
  { href: "/inbox/captured", label: "Captured", where: "Inbox", keywords: "capture thoughts" },
  { href: "/inbox/calendar", label: "Calendar", where: "Inbox", keywords: "import imports calendar events batches" },
  { href: "/inbox/map", label: "Links", where: "Inbox", keywords: "suggested links plan map findings" },
  { href: "/inbox/kept", label: "Kept for later", where: "Inbox", keywords: "someday reference" },
  { href: "/you", label: "You", where: "You", keywords: "more" },
  {
    href: "/doctor",
    label: "Data check",
    where: "You",
    keywords: "doctor data quality stale fix check"
  },
  {
    href: "/data",
    label: "Data",
    where: "You",
    keywords: "data map flow sources feeds collectors late unused where from to gives"
  },
  { href: "/history", label: "History", where: "You › Records", keywords: "sessions evidence" },
  { href: "/sleep", label: "Sleep log", where: "You › Records", keywords: "sleep nights" },
  { href: "/photo-checkins", label: "Photo check-ins", where: "You › Records", keywords: "photos" },
  { href: "/reports", label: "Reported issues", where: "You › Records", keywords: "reports issues snapshots" },
  {
    href: "/connections",
    label: "Connections",
    where: "You",
    keywords: withSink("status engine planner calendar")
  },
  { href: "/settings", label: "Settings", where: "You", keywords: "preferences" },
  { href: "/settings/sleep", label: "Sleep and wake", where: "You › Settings", keywords: "bedtime wake" },
  {
    href: "/settings/routines",
    label: "Routines",
    where: "You › Settings",
    keywords: "sleep bedtime wake preparation steps"
  },
  { href: "/settings/planning", label: "Planning", where: "You › Settings", keywords: "time zone horizon capacity" },
  { href: "/settings/planning/buffers", label: "Buffers", where: "You › Settings", keywords: "transition setup" },
  { href: "/settings/planning/estimates", label: "Estimates", where: "You › Settings", keywords: "durations" },
  { href: "/settings/catalogues/energy", label: "Energy levels", where: "You › Settings", keywords: "energy" },
  {
    href: "/settings/catalogues/conditions",
    label: "Places and conditions",
    where: "You › Settings",
    keywords: "locations home contacts"
  },
  {
    href: "/settings/notifications",
    label: "Notifications",
    where: "You › Settings",
    keywords: "push leave by alerts"
  },
  { href: "/settings/disruptions", label: "Disruptions", where: "You › Settings", keywords: "disruption presets" },
  {
    href: "/settings/family-calendar",
    label: "Family calendar sharing",
    where: "You › Settings",
    keywords: [sinkKeyword, "share"].filter(Boolean).join(" ")
  },
  { href: "/settings/pulse", label: "Pulse", where: "You › Settings", keywords: "pulse" },
  {
    href: "/settings/ai",
    label: "AI and add-ons",
    where: "You › Settings",
    keywords: `models ${modelProviderKeywords} agent tokens map add-ons mcp`
  },
  {
    href: "/settings/advanced",
    label: "Sign-in and devices",
    where: "You › Settings",
    keywords: "devices owner browser phone sign in token"
  }
]);

/** Destinations whose label, place or keywords contain every word typed, best match first. */
export function searchDestinations(query: string, list: readonly Destination[] = destinations): Destination[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  const scored = list
    .map((item) => {
      const label = item.label.toLowerCase();
      const haystack = `${label} ${item.where.toLowerCase()} ${item.keywords ?? ""}`;
      if (!words.every((word) => haystack.includes(word))) return null;
      const score = item.firstFor?.includes(words[0]!)
        ? -1
        : label.startsWith(words[0]!)
          ? 0
          : label.includes(words[0]!)
            ? 1
            : 2;
      return { item, score };
    })
    .filter((entry): entry is { item: Destination; score: number } => entry !== null);
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.item);
}

/** What Ctrl K lists: the capture actions, then every page. */
export function searchPalette(query: string): Destination[] {
  return searchDestinations(query, [...paletteActions, ...destinations]);
}

const normalise = (pathname: string) => pathname.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Sub-routes highlight the place that owns them, so Settings reads as part of You and an old Capture
 * or Import URL still reads as Inbox. Prefix matching is on whole path segments: `/plan` owns
 * `/plan/anything` but not `/planning`.
 */
const ownership: readonly (readonly [PrimaryTab, string])[] = withExtensionOwnership([
  ["now", "/catch-up"],
  ["day", "/today"],
  ["day", "/schedule"],
  ["day", "/commitments"],
  ["plan", "/plan"],
  ["plan", "/review"],
  ["plan", "/deliverables"],
  ["plan", "/map"],
  ["inbox", "/inbox"],
  ["inbox", "/capture"],
  ["inbox", "/import"],
  ["you", "/you"],
  ["you", "/more"],
  ["you", "/doctor"],
  ["you", "/data"],
  ["you", "/settings"],
  ["you", "/sleep"],
  ["you", "/history"],
  ["you", "/reports"],
  ["you", "/connections"],
  ["you", "/photo-checkins"]
]);

export function activeTab(pathname: string | null | undefined): PrimaryTab | null {
  if (!pathname) return null;
  const path = normalise(pathname);
  if (path === "/") return "now";
  for (const [tab, prefix] of ownership) if (under(path, prefix)) return tab;
  return null;
}

/** The place tab a path belongs to, or undefined on a page outside a tabbed place. The most specific
 * match wins, so /review/focus lights Review. */
export function activePlaceTab(pathname: string | null | undefined): { tab: PrimaryTab; href: string } | undefined {
  if (!pathname) return undefined;
  const place = activeTab(pathname);
  const tabs = place ? placeTabs[place] : undefined;
  if (!place || !tabs) return undefined;
  const path = normalise(pathname);
  const match = tabs
    .flatMap((item) => [item.href, ...(item.owns ?? [])].map((prefix) => ({ href: item.href, prefix })))
    .filter((entry) => under(path, entry.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return match ? { tab: place, href: match.href } : undefined;
}
