import type { FlowEntry } from "../types.js";
import { flow } from "./define.js";

const planned = (
  id: string,
  name: string,
  potential: string,
  landsAs: string,
  method: FlowEntry["method"]
): FlowEntry =>
  flow({
    id,
    name,
    role: "source",
    category: "device",
    method,
    trigger: { kind: "none" },
    planned: { landsAs: { activitySource: landsAs } },
    value: { potential },
    health: { kind: "none", reason: "not built" }
  });

/** Generic ideas for sources that do not exist yet. Anything naming a person's own setup is the extension's list. */
export const PLANNED_ENTRIES: readonly FlowEntry[] = [
  planned(
    "planned-public-holidays",
    "Public holidays and school terms",
    "free days and busy weeks known ahead",
    "public-holidays",
    "api-pull"
  ),
  planned("planned-daylight", "Daylight", "when light and dark start, for outdoor plans", "daylight", "api-pull"),
  planned(
    "planned-browser-history",
    "Local browser history",
    "what the browser showed, hour by hour",
    "browser-history",
    "device-agent"
  ),
  planned(
    "planned-notification-history",
    "Desktop notification history",
    "what interrupted the day",
    "notification-history",
    "device-agent"
  ),
  planned(
    "planned-pc-retro-history",
    "PC usage history",
    "app use before the activity agent was installed",
    "pc-retro-history",
    "device-agent"
  ),
  planned("planned-dwell-time", "Dwell time from pings", "how long each place held you", "dwell", "derived"),
  planned("planned-home-dns-log", "Home DNS log", "which devices were awake at home", "home-dns", "api-pull"),
  planned("planned-router-presence", "Router presence", "who and what was at home", "router-presence", "api-pull"),
  planned(
    "planned-calendar-change-log",
    "Calendar change log",
    "how plans moved after they were made",
    "calendar-changes",
    "derived"
  ),
  planned("planned-photo-exif", "Photo metadata", "where and when photos were taken", "photo-exif", "file-import"),
  planned("planned-live-transit", "Live transit", "delays on the way", "transit", "api-pull")
];
