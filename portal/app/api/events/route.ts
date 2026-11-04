import { withRoute } from "@/server/logging";
import { readPlanningStatus } from "@/server/persistence/postgres/state-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import { stateChangedFanout } from "@/server/events/state-events";
import "@/server/private/index";
import { sseCommentFrame, sseEventFrame, sseRetryFrame } from "@/shared/sse";

/** How long `EventSource`'s own automatic reconnect should wait before it retries on its own. */
const RETRY_MS = 3_000;
/** Frequent enough to keep the household Caddy (and any other reverse proxy) from deciding an idle
 *  connection is dead and closing it out from under the browser — see the smoke-test note in
 *  the deploy report for how this was actually confirmed against production. */
const PING_INTERVAL_MS = 25_000;
/** The longest `hello` waits for the Postgres listener to come up; past it `hello` goes out anyway
 *  and a second one follows the moment the listener is live (see `GET`). */
const LISTENER_WAIT_MS = 5_000;

/**
 * One SSE stream per open tab, fed by the process-wide `StateChangedFanout`
 * (`portal/server/events/state-events.ts`), which is itself fed by one `LISTEN state_changed`
 * connection kept alive for the process. This route's own job is small: say hello with the plan's
 * current freshness, forward whatever the fan-out delivers as `changed`, keep the connection alive
 * with a `ping` comment, and unsubscribe the moment the browser goes away.
 *
 * Modelled on `/api/deliverables/[id]/chat`'s `POST` (`portal/app/api/deliverables/[id]/chat/route.ts`),
 * the portal's one other `text/event-stream` route, which already runs in production behind the same
 * reverse proxy this route will.
 */
export const GET = withRoute("/api/events", async (request) => {
  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let cancelLiveWait: (() => void) | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // A notification or ping landing in the gap between the abort event firing and this
          // stream's own cleanup running would otherwise throw on an already-closed controller.
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pingTimer) clearInterval(pingTimer);
        unsubscribe?.();
        cancelLiveWait?.();
        try {
          controller.close();
        } catch {
          // The runtime may already have closed it on its side of the same abort.
        }
      };

      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup);

      send(sseRetryFrame(RETRY_MS));

      // `hello` makes the client reconcile (reload state), so it must not go out before the Postgres
      // listener is live: `subscribe()` returns before the async `LISTEN` finishes, and a write that
      // committed in that gap would never notify this stream and never be reloaded. So subscribe
      // first (that starts the listener), hold any `changed` until `hello` is out, wait for the
      // listener, then read freshness and say hello. The wait is bounded so a Postgres outage still
      // gives the tab a `hello`; a second `hello` follows once the listener does come up.
      let helloSent = false;
      const held: string[] = [];
      const fanout = stateChangedFanout();
      const stopChanged = fanout.subscribe((notification) => {
        const frame = sseEventFrame("changed", { kind: notification.kind, at: notification.at });
        if (helloSent) send(frame);
        else held.push(frame);
      });

      // Best-effort: a tab should still get `hello` (with a null freshness) rather than nothing at
      // all if this one read fails, since the stream itself — and every `changed` event after it —
      // does not depend on it.
      const sendHello = async () => {
        const connectionString = databaseUrl();
        const lastSuccessfulAt = connectionString
          ? await readPlanningStatus(sqlPool(connectionString)).then(
              (status) => status.lastSuccessfulAt,
              () => null
            )
          : null;
        send(sseEventFrame("hello", { lastSuccessfulAt }));
      };

      // A silently dropped and repaired LISTEN loses whatever was notified meanwhile, so each repair
      // is a reconciliation boundary: say `hello` again so the client reloads state. Before the first
      // `hello` is out, that one is still to come and covers it.
      const stopRepaired = fanout.onRepaired(() => {
        if (helloSent) void sendHello();
      });
      unsubscribe = () => {
        stopChanged();
        stopRepaired();
      };

      let waitTimer: ReturnType<typeof setTimeout> | null = null;
      const live = await new Promise<boolean>((resolve) => {
        cancelLiveWait = fanout.onLive(() => resolve(true));
        waitTimer = setTimeout(() => resolve(false), LISTENER_WAIT_MS);
      });
      if (waitTimer) clearTimeout(waitTimer);
      cancelLiveWait?.();
      cancelLiveWait = null;
      if (closed) return;

      await sendHello();
      // The client may have gone while the freshness read ran; cleanup found no ping timer to clear.
      if (closed) return;
      helloSent = true;
      for (const frame of held.splice(0)) send(frame);
      if (!live && !closed) cancelLiveWait = fanout.onLive(() => void sendHello());

      pingTimer = setInterval(() => send(sseCommentFrame("ping")), PING_INTERVAL_MS);
    },
    cancel() {
      // The runtime calls this when the reader is released without the request having aborted first
      // (some proxies/runtimes take this path instead of firing `abort`); tearing down here too means
      // neither path can leak the subscription or the ping timer.
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      unsubscribe?.();
      cancelLiveWait?.();
    }
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" }
  });
});
