/**
 * Incremental server-sent-events parsing, shared by the chat route (reading OpenAI's stream through
 * the sidecar) and the chat panel (reading the route's own stream). Chunk boundaries land anywhere —
 * mid-line, mid-multibyte — so the caller feeds decoded text in whatever pieces arrive and gets one
 * callback per complete `data:` payload. The `[DONE]` sentinel some streams end with is swallowed.
 */
export function createSseParser(onData: (data: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let boundary: number;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data && data !== "[DONE]") onData(data);
    }
  };
}

/** One SSE frame carrying a JSON payload, ready to enqueue. */
export function sseFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * One SSE frame with an explicit `event:` name — the chat route above never names its events (every
 * frame is read as the default `message`), but `/api/events` (`portal/app/api/events/route.ts`) has
 * more than one event type on the same stream (`hello`, `changed`) and the client tells them apart by
 * name via `EventSource.addEventListener`.
 */
export function sseEventFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A `retry:` directive, telling `EventSource` how long to wait before its own auto-reconnect. */
export function sseRetryFrame(ms: number): string {
  return `retry: ${ms}\n\n`;
}

/** A comment line — ignored by `EventSource` but enough to keep an idle connection (and any proxy in
 *  front of it) from deciding nothing is coming and closing it. */
export function sseCommentFrame(comment: string): string {
  return `: ${comment}\n\n`;
}
