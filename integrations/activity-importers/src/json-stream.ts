import { textChunks } from "./chunks.js";
import type { ByteSource } from "./types.js";

export interface JsonElement {
  /** The parsed element, or undefined when its text was not valid JSON. */
  value: unknown;
  ok: boolean;
}

/** The largest single element read into memory. A real history row is a few KB; anything past this is not one. */
const MAX_ELEMENT_CHARS = 8 * 1024 * 1024;

/**
 * Streams the object elements of the first array that is the document or a direct value of its top-level object in a JSON document without loading the document:
 * `[{...}, {...}]` (Spotify, My Activity, Discord) or `{"Browser History": [{...}]}` (Chrome). Each element is
 * parsed on its own, so one bad row is reported and the rest still flow. `onEnd` says whether the document ended
 * inside a structure (a cut-off file). Elements that are not objects are not yielded.
 */
export async function* jsonArrayObjects(
  source: ByteSource,
  onEnd: (info: { truncated: boolean; sawArray: boolean }) => void = () => undefined
): AsyncGenerator<JsonElement> {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let outerArrayDepth = -1;
  let capturing = false;
  let pending = "";
  let sawArray = false;
  let aborted = false;
  for await (const chunk of textChunks(source)) {
    let from = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      const code = chunk.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (code === 0x5c) escaped = true;
        else if (code === 0x22) inString = false;
        continue;
      }
      if (code === 0x22) {
        inString = true;
        continue;
      }
      if (code === 0x5b || code === 0x7b) {
        // [ or {
        if (code === 0x5b && outerArrayDepth === -1 && stack.length <= 1) {
          outerArrayDepth = stack.length;
          sawArray = true;
        }
        if (code === 0x7b && !capturing && outerArrayDepth !== -1 && stack.length === outerArrayDepth + 1) {
          capturing = true;
          from = i;
          pending = "";
        }
        stack.push(code === 0x5b ? "[" : "{");
      } else if (code === 0x5d || code === 0x7d) {
        stack.pop();
        if (capturing && stack.length === outerArrayDepth + 1) {
          const text = pending + chunk.slice(from, i + 1);
          capturing = false;
          pending = "";
          if (text.length > MAX_ELEMENT_CHARS) yield { value: undefined, ok: false };
          else {
            try {
              yield { value: JSON.parse(text), ok: true };
            } catch {
              yield { value: undefined, ok: false };
            }
          }
        } else if (code === 0x5d && stack.length === outerArrayDepth) {
          outerArrayDepth = -2; // the outer array closed; ignore anything after it
        }
      }
    }
    if (capturing) {
      pending += chunk.slice(from);
      from = 0;
      if (pending.length > MAX_ELEMENT_CHARS) {
        aborted = true;
        break;
      }
    }
  }
  onEnd({ truncated: aborted || stack.length > 0 || inString, sawArray });
}
