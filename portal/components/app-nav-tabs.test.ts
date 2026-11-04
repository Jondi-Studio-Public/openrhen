import { describe, expect, it } from "vitest";
import {
  activePlaceTab,
  activeTab,
  destinations,
  paletteActions,
  placeTabs,
  primaryTabs,
  searchDestinations,
  searchPalette
} from "./app-nav-tabs";

describe("palette names", () => {
  it("calls the disruption entry what Now and the capture tab call it, and the review page Weekly review", () => {
    expect(paletteActions.find((item) => item.action === "disruption")?.label).toBe("Something came up");
    expect(searchDestinations("weekly")[0]?.label).toBe("Weekly review");
    expect(searchDestinations("review")[0]?.label).toBe("Weekly review");
  });
});

describe("primaryTabs", () => {
  it("lists the five places, the same on a phone and a desk", () => {
    expect(primaryTabs.map((item) => [item.label, item.href])).toEqual([
      ["Now", "/"],
      ["Day", "/today"],
      ["Plan", "/plan"],
      ["Inbox", "/inbox"],
      ["You", "/you"]
    ]);
  });

  it("gives Day and Plan their own tabs", () => {
    expect(placeTabs.day?.map((item) => item.label)).toEqual(["Day", "Week"]);
    expect(placeTabs.plan?.map((item) => item.label)).toEqual(["Areas", "Deliverables", "Map", "Review"]);
  });
});

describe("activeTab", () => {
  it.each([
    ["/", "now"],
    ["/catch-up", "now"],
    ["/today", "day"],
    ["/schedule", "day"],
    ["/commitments/abc", "day"],
    ["/plan", "plan"],
    ["/plan/area-1", "plan"],
    ["/deliverables", "plan"],
    ["/map", "plan"],
    ["/review/focus", "plan"],
    ["/review/closed", "plan"],
    ["/inbox/emails", "inbox"],
    ["/capture", "inbox"],
    ["/import", "inbox"],
    ["/you", "you"],
    ["/more", "you"],
    ["/settings/routines", "you"],
    ["/history", "you"],
    ["/sleep", "you"],
    ["/connections", "you"],
    ["/doctor", "you"],
    ["/today/", "day"],
    ["/today?date=2026-10-28", "day"]
  ])("lights the place that owns %s", (path, tab) => {
    expect(activeTab(path)).toBe(tab);
  });

  it("finds the Data check by its keywords", () => {
    expect(searchDestinations("stale fix").map((item) => item.href)).toContain("/doctor");
    expect(searchDestinations("data check")[0]?.where).toBe("You");
  });

  it("matches whole path segments only", () => {
    expect(activeTab("/planning")).toBeNull();
    expect(activeTab("/todayish")).toBeNull();
    expect(activeTab(null)).toBeNull();
  });
});

describe("activePlaceTab", () => {
  it.each([
    ["/today", "day", "/today"],
    ["/schedule", "day", "/schedule"],
    ["/commitments/abc", "day", "/schedule"],
    ["/plan/area-1", "plan", "/plan"],
    ["/deliverables", "plan", "/deliverables"],
    ["/review/focus", "plan", "/review"]
  ])("puts %s under the %s tab %s", (path, tab, href) => {
    expect(activePlaceTab(path)).toEqual({ tab, href });
  });

  it("is undefined in places without tabs", () => {
    expect(activePlaceTab("/")).toBeUndefined();
    expect(activePlaceTab("/inbox")).toBeUndefined();
    expect(activePlaceTab("/settings")).toBeUndefined();
  });
});

describe("searchDestinations", () => {
  it("returns everything for an empty query", () => {
    expect(searchDestinations("  ")).toHaveLength(destinations.length);
  });

  it("finds by label first, then by keyword", () => {
    const hits = searchDestinations("sleep").map((item) => item.label);
    expect(hits.slice(0, 2)).toEqual(["Sleep log", "Sleep and wake"]);
    expect(hits).toContain("Routines");
  });

  it("needs every word typed", () => {
    expect(searchDestinations("agent tokens").map((item) => item.href)).toEqual(["/settings/ai"]);
    expect(searchDestinations("zzz nothing")).toEqual([]);
  });

  it("only lists destinations that belong to a place", () => {
    for (const item of destinations) expect(activeTab(item.href), item.href).not.toBeNull();
  });
});

describe("searchPalette", () => {
  it("leads with the capture actions for capture, add, note and task", () => {
    for (const word of ["capture", "add", "note", "task", "Capture"]) {
      const hits = searchPalette(word);
      expect(hits[0]!.action, word).toBe("capture");
      expect(hits[1]!.action, word).toBe("disruption");
    }
  });

  it("lists the actions before every page when nothing is typed", () => {
    const hits = searchPalette("");
    expect(hits.slice(0, paletteActions.length).map((item) => item.action)).toEqual(["capture", "disruption"]);
    expect(hits).toHaveLength(paletteActions.length + destinations.length);
  });

  it("still finds pages by their names, with no action in the way", () => {
    expect(
      searchPalette("sleep")
        .map((item) => item.label)
        .slice(0, 2)
    ).toEqual(["Sleep log", "Sleep and wake"]);
    expect(searchPalette("sleep").some((item) => item.action)).toBe(false);
  });
});
