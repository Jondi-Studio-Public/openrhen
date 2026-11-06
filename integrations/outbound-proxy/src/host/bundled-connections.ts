import { calendarFeedConnection } from "../connections/calendar-feed/connection.js";
import { deepinfraConnection } from "../connections/deepinfra/connection.js";
import { googleCalendarConnection } from "../connections/google-calendar/connection.js";
import { googleRoutesConnection } from "../connections/google-routes/connection.js";
import { openaiConnection } from "../connections/openai/connection.js";
import { pulseConnection } from "../connections/pulse/connection.js";
import { youtubeDataConnection } from "../connections/youtube-data/connection.js";
import "../drop-ins.js";
import type { BoundConnection } from "./connection-api.js";
import { registeredConnections } from "./connection-registry.js";

/** The connections every build serves. Anything else arrives through a drop-in folder (`connection-registry.ts`). */
export const CORE_CONNECTIONS: readonly BoundConnection[] = [
  googleCalendarConnection,
  googleRoutesConnection,
  pulseConnection,
  openaiConnection,
  deepinfraConnection,
  calendarFeedConnection,
  youtubeDataConnection
];

/** Every connection this host serves: the core list, then each registered drop-in connection. */
export function bundledConnections(): BoundConnection[] {
  return [...CORE_CONNECTIONS, ...registeredConnections()];
}
