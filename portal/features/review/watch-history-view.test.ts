import { describe, expect, it } from "vitest";
import { estimateLine, hourLabel, shortDate } from "./watch-history-view";

describe("watch history view", () => {
  it("states a range with a known low end as about the midpoint, and the videos it could not bound", () => {
    expect(estimateLine({ lowMin: 60, highMin: 130, midMin: 95, videos: 20, sessions: 4, unknownCount: 4 })).toBe(
      "Estimated time: about 1h 35m (between 1h and 2h 10m). 4 videos ended a session, so their length is not counted."
    );
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
