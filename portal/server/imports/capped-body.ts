/** A request body longer than the cap. */
export class BodyTooLargeError extends Error {}

/**
 * Reads a request body as UTF-8 text, counting bytes as they arrive and cancelling the stream the moment the cap
 * is passed. `Content-Length` is only a cheap early refusal: it can be absent (chunked) or wrong, so the cap is
 * enforced on the bytes actually read, and an oversized body is never held whole in memory.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
