import { formatMinutes, type WatchEstimate } from "@openrhen/contracts";

/** The estimate as one honest sentence: a range that leans high, with the watches it could not bound. */
export function estimateLine(estimate: WatchEstimate): string {
  if (estimate.videos === 0) return "";
  const range =
    estimate.highMin === 0
      ? "Too few close-together watches to estimate time."
      : estimate.lowMin === 0
        ? // No known lengths: the low end is zero by construction, so a midpoint would be an invented figure.
          `Estimated time: up to ${formatMinutes(estimate.highMin)}, probably less (range ${formatMinutes(estimate.lowMin)} to ${formatMinutes(estimate.highMin)}).`
        : `Estimated time: about ${formatMinutes(estimate.midMin)} (between ${formatMinutes(estimate.lowMin)} and ${formatMinutes(estimate.highMin)}).`;
  const unknown =
    estimate.unknownCount > 0
      ? ` ${estimate.unknownCount} ${estimate.unknownCount === 1 ? "video" : "videos"} ended a session, so their length is not counted.`
      : "";
  return `${range}${unknown}`;
}

export const ESTIMATE_CAVEAT =
  "Takeout records when each video started, not how long you watched. The estimate counts the gap to the next video (up to 2 hours), so it leans high.";

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
