import { describe, expect, it } from "vitest";
import { emptyWindowLine, estimateCaveat, estimateLine, hourLabel, lengthsLine, shortDate } from "./watch-history-view";
import type { WatchLengths } from "@openrhen/contracts";

describe("watch history view", () => {
  it("with lengths known shows the range plainly, then the midpoint, and the videos it could not bound", () => {
    expect(estimateLine({ lowMin: 60, highMin: 130, midMin: 95, videos: 20, sessions: 4, unknownCount: 4 })).toBe(
      "Estimated time: between 1h and 2h 10m (about 1h 35m). 4 videos ended a session, so their length is not counted."
    );
  });

  it("uses the 'up to, probably less' wording only when the low end is zero", () => {
    expect(estimateLine({ lowMin: 0, highMin: 20, midMin: 10, videos: 3, sessions: 1, unknownCount: 0 })).toMatch(
      /up to 20m, probably less/
    );
    expect(estimateLine({ lowMin: 5, highMin: 20, midMin: 13, videos: 3, sessions: 1, unknownCount: 0 })).not.toMatch(
      /probably less/
    );
  });

  it("describes the empty window by what is held", () => {
    expect(emptyWindowLine(12, 30)).toBe("12 watches held, none in the last 30 days.");
    expect(emptyWindowLine(1, 30)).toBe("1 watch held, none in the last 30 days.");
    expect(emptyWindowLine(3, 7)).toBe("3 watches held, none in the last 7 days.");
  });

  it("explains the estimate by whether any length was used", () => {
    expect(estimateCaveat(0)).toContain("the gap to the next video (up to 2 hours)");
    expect(estimateCaveat(5)).toContain("shorter of the gap to the next video and its length");
  });

  describe("lengths line", () => {
    const base: WatchLengths = { keyState: "set", known: 0, missing: 0, unavailable: 0, quotaPaused: false };
    it("tells the person to add a key when none is saved and lengths are missing", () => {
      expect(lengthsLine({ ...base, keyState: "unset", missing: 4 })).toBe(
        "Add a YouTube API key in Settings > Passwords and keys to estimate time from video lengths."
      );
    });
    it("asks for the key again when it can no longer be opened", () => {
      expect(lengthsLine({ ...base, keyState: "unreadable", missing: 4 })).toMatch(/enter it again/i);
    });
    it("counts what is known and what is still missing, and says when the quota paused it", () => {
      expect(lengthsLine({ ...base, known: 8, missing: 2, unavailable: 1 })).toBe(
        "Video lengths known for 8 of 11 videos; 2 not looked up yet; 1 private, deleted or without a length."
      );
      expect(lengthsLine({ ...base, known: 8, missing: 2, quotaPaused: true })).toContain("daily quota");
    });
    it("says nothing when there is nothing to look up and nothing known", () => {
      expect(lengthsLine(base)).toBe("");
    });
  });

  it("with no known lengths gives only an upper figure, never a midpoint", () => {
    expect(estimateLine({ lowMin: 0, highMin: 130, midMin: 65, videos: 20, sessions: 4, unknownCount: 4 })).toBe(
      "Estimated time: up to 2h 10m, probably less (range 0m to 2h 10m). 4 videos ended a session, so their length is not counted."
    );
  });

  it("does not pretend when nothing can be estimated, and says nothing for no videos", () => {
    expect(estimateLine({ lowMin: 0, highMin: 0, midMin: 0, videos: 1, sessions: 1, unknownCount: 1 })).toMatch(
      /^Too few close-together watches/
    );
    expect(estimateLine({ lowMin: 0, highMin: 0, midMin: 0, videos: 0, sessions: 0, unknownCount: 0 })).toBe("");
  });

  it("formats a plain date without a zone shift, and an hour", () => {
    expect(shortDate("2026-11-01", "en-GB")).toBe("1 Nov");
    expect(hourLabel(7)).toBe("07:00");
  });
});
