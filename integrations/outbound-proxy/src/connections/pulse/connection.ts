import { connectionManifest, publicPulseV1Schema } from "@openrhen/contracts";
import type { BoundConnection, OpResult } from "../../host/connection-api.js";
import { publishPulse, pulsePublishConfigFromEnv } from "./pulse-publish.js";

function manifest() {
  const found = connectionManifest("pulse");
  if (!found) throw new Error("The pulse manifest is missing from the registry.");
  return found;
}

/** The public pulse tracker: `PULSE_PUBLISH_URL` and `PULSE_PUBLISH_SECRET` exist only in this process. */
export const pulseConnection: BoundConnection = {
  manifest: manifest(),
  create: () => ({
    status_publish: {
      config: {
        kind: "json",
        async run(call): Promise<OpResult> {
          const config = pulsePublishConfigFromEnv(call.env);
          return { status: 200, body: { configured: Boolean(config), host: config?.host ?? null } };
        }
      },
      publish: {
        kind: "json",
        async run(call): Promise<OpResult> {
          const config = pulsePublishConfigFromEnv(call.env);
          if (!config) return { status: 503, body: { error: "The pulse tracker is not configured." } };
          // `.strict()` at every level of this schema is what makes this op refuse an extra field
          // instead of quietly forwarding it to the tracker.
          const parsed = publicPulseV1Schema.safeParse(call.body);
          if (!parsed.success) return { status: 400, body: { error: "The pulse object failed validation." } };
          try {
            return { status: 200, body: await publishPulse(parsed.data, config, call.fetch) };
          } catch (error) {
            // A timeout or a gone client aborted the call: the host answers that (504 or nothing).
            if (call.signal.aborted) throw error;
            return {
              status: 502,
              body: { error: error instanceof Error ? error.message : "The pulse publish failed." }
            };
          }
        }
      }
    }
  })
};
