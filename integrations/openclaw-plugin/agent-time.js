// Reports OpenClaw conversations to OpenRhen as agent time: when the
// agent was working and nothing else, never conversation text. Activity comes from model calls, a metadata hook
// that needs no conversation access. It is cut into bursts with the portal's own 30-minute idle gap, so a session
// left open overnight counts the minutes it was used, not the night.

const IDLE_GAP_MS = 30 * 60_000;
const MAX_SESSION_MS = 24 * 60 * 60_000; // the ingest refuses longer sessions; a longer burst starts a new one
const FLUSH_DELAY_MS = 60_000; // one post a minute at most per burst while the agent is busy
const TIMEOUT_MS = 10_000;

/** The ingest's id rule: 1 to 128 of `A-Z a-z 0-9 . _ : -`, unique per agent. */
function sessionRecordId(sessionId, startMs) {
  const safe = String(sessionId)
    .replace(/[^A-Za-z0-9._:-]/g, "-")
    .slice(0, 96);
  return `oc-${safe}-${startMs}`;
}

/** Which session a hook is about: the event's own id, then the context's, then either session key. */
export function sessionKeyOf(event, ctx) {
  return event?.sessionId ?? ctx?.sessionId ?? event?.sessionKey ?? ctx?.sessionKey;
}

export function createAgentTimeReporter({
  portalUrl,
  token,
  fetchImpl = fetch,
  now = Date.now,
  setTimer = (callback, ms) => setTimeout(callback, ms).unref?.(),
  log
}) {
  if (typeof portalUrl !== "string" || portalUrl.length === 0) throw new Error("portalUrl is required");
  const endpoint = new URL("/api/agent-sessions", portalUrl).toString();
  const bursts = new Map();

  async function post(burst) {
    const body = {
      schemaVersion: 1,
      sessions: [
        {
          id: burst.id,
          startedAt: new Date(burst.startMs).toISOString(),
          endedAt: new Date(burst.endMs).toISOString(),
          kind: "conversation"
        }
      ]
    };
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-openrhen-token": token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      // A burst is re-posted under the same id as it grows, so a failed post is repaired by the next one.
      if (!response.ok) log?.warn(`OpenRhen agent time: ${endpoint} answered ${response.status}`);
    } catch (error) {
      log?.warn(`OpenRhen agent time: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function flush(burst) {
    if (!burst.dirty) return Promise.resolve();
    burst.dirty = false;
    return post(burst);
  }

  return {
    /** The agent finished `durationMs` of work in `sessionId` just now (one model call). */
    activity(sessionId, durationMs) {
      if (!sessionId) return;
      const endMs = now();
      // A bogus duration must not make a burst longer than the ingest accepts, or every re-post would be refused.
      const startMs = endMs - Math.min(MAX_SESSION_MS, Math.max(0, Number.isFinite(durationMs) ? durationMs : 0));
      // Sessions that went idle without a session_end are posted and dropped, so the map stays small.
      for (const [key, idle] of bursts)
        if (key !== sessionId && endMs - idle.endMs > IDLE_GAP_MS) {
          bursts.delete(key);
          void flush(idle);
        }
      let burst = bursts.get(sessionId);
      if (burst && (startMs - burst.endMs > IDLE_GAP_MS || endMs - burst.startMs > MAX_SESSION_MS)) {
        void flush(burst);
        burst = undefined;
      }
      if (!burst) {
        burst = { id: sessionRecordId(sessionId, startMs), startMs, endMs, dirty: false, timer: false };
        bursts.set(sessionId, burst);
      }
      burst.endMs = Math.max(burst.endMs, endMs);
      burst.dirty = true;
      if (!burst.timer) {
        burst.timer = true;
        const scheduled = burst;
        setTimer(() => {
          scheduled.timer = false;
          void flush(scheduled);
        }, FLUSH_DELAY_MS);
      }
    },
    /** The session closed: post what is left and forget it. */
    end(sessionId) {
      const burst = bursts.get(sessionId);
      bursts.delete(sessionId);
      return burst ? flush(burst) : Promise.resolve();
    },
    /** Post every burst with unsent activity (the Gateway is stopping). */
    flushAll() {
      return Promise.all([...bursts.values()].map(flush));
    }
  };
}
