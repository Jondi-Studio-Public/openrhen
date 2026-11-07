import { connectionManifest, videoDurationsRequestSchema } from "@openrhen/contracts";
import type { BoundConnection } from "../../host/connection-api.js";
import { fetchVideoDurations } from "./youtube-data-client.js";

function manifest() {
  const found = connectionManifest("youtube_data");
  if (!found) throw new Error("The youtube_data manifest is missing from the registry.");
  return found;
}

/**
 * YouTube Data API: video lengths for watch history. The key is the person's own, typed into the app and sent in each
 * request's body (`apiKey`); this connection holds none and reads nothing from its environment. It goes to Google in a
 * header only, and no failure text that could quote it is returned or logged.
 */
export const youtubeDataConnection: BoundConnection = {
  manifest: manifest(),
  create: () => ({
    video_metadata: {
      durations: {
        kind: "json",
        async run(call) {
          const parsed = videoDurationsRequestSchema.safeParse(call.body);
          if (!parsed.success)
            return {
              status: 400,
              body: { error: "Send { apiKey, ids } with 1 to 50 eleven-character video ids." }
            };
          const result = await fetchVideoDurations(parsed.data, call.fetch, call.signal);
          if (result.ok) return { status: 200, body: { videos: result.videos } };
          return { status: result.status, body: { error: result.error, reason: result.reason } };
        }
      }
    }
  })
};
