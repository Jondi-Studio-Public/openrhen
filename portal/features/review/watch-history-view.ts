import { formatMinutes, type WatchEstimate, type WatchLengths } from "@openrhen/contracts";

/** The estimate as one honest sentence: a range that leans high, with the watches it could not bound. */
export function estimateLine(estimate: WatchEstimate): string {
  if (estimate.videos === 0) return "";
  const range =
    estimate.highMin === 0
      ? "Too few close-together watches to estimate time."
      : estimate.lowMin === 0
        ? // No known lengths: the low end is zero by construction, so a midpoint would be an invented figure.
          `Estimated time: up to ${formatMinutes(estimate.highMin)}, probably less (range ${formatMinutes(estimate.lowMin)} to ${formatMinutes(estimate.highMin)}).`
        : // Lengths narrow the range: show it plainly, with the midpoint after it.
          `Estimated time: between ${formatMinutes(estimate.lowMin)} and ${formatMinutes(estimate.highMin)} (about ${formatMinutes(estimate.midMin)}).`;
  const unknown =
    estimate.unknownCount > 0
      ? ` ${estimate.unknownCount} ${estimate.unknownCount === 1 ? "video" : "videos"} ended a session, so their length is not counted.`
      : "";
  return `${range}${unknown}`;
}

/** Why the estimate is a range, by whether any video length went into it. */
export function estimateCaveat(knownLengths: number): string {
  return knownLengths > 0
    ? "Takeout records when each video started, not how long you watched. Each video is credited the shorter of the gap to the next video and its length (a gap over 2 hours ends a session), and the last video of a session counts up to its length, so it leans high."
    : "Takeout records when each video started, not how long you watched. The estimate counts the gap to the next video (up to 2 hours), so it leans high.";
}

export const ADD_KEY_LINE =
  "Add a YouTube API key in Settings > Passwords and keys to estimate time from video lengths.";

/** How far the length lookup has got, as one sentence; empty when there is nothing to say. */
export function lengthsLine(lengths: WatchLengths): string {
  const total = lengths.known + lengths.missing + lengths.unavailable;
  if (lengths.keyState === "unreadable" && lengths.missing > 0)
    return "The saved YouTube key can no longer be opened. Enter it again in Settings > Passwords and keys.";
  if (lengths.keyState === "unset" && lengths.missing > 0) return ADD_KEY_LINE;
  if (total === 0 || (lengths.known === 0 && lengths.missing === 0 && lengths.unavailable === 0)) return "";
  const parts = [`Video lengths known for ${lengths.known} of ${total} videos`];
  if (lengths.missing > 0) parts.push(`${lengths.missing} not looked up yet`);
  if (lengths.unavailable > 0) parts.push(`${lengths.unavailable} private, deleted or without a length`);
  const line = `${parts.join("; ")}.`;
  return lengths.quotaPaused && lengths.missing > 0
    ? `${line} YouTube's daily quota is used up; lookups resume after midnight Pacific time.`
    : line;
}

/** Said when videos are held but none fall in the window shown. */
export function emptyWindowLine(held: number, days: number): string {
  return `${held} ${held === 1 ? "watch" : "watches"} held, none in the last ${days} days.`;
}

/** "6 Nov" for a plain `YYYY-MM-DD`, read in UTC so no time zone shifts it a day. */
export function shortDate(date: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "short" }).format(
    new Date(`${date}T00:00:00Z`)
  );
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** The base64 body of a file, without the data-URL prefix. */
export async function fileToBase64(file: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
  return url.slice(url.indexOf(",") + 1);
}

/** Whether the bytes start with the zip signature `PK`, so a renamed file is still told apart. */
export async function looksLikeZip(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b;
}
