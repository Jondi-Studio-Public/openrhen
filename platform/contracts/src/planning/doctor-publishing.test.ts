import { describe, expect, it } from "vitest";
import { publishingItems, type DoctorPublishingSlice } from "./doctor-publishing.js";

const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const empty: DoctorPublishingSlice = { calendarSink: null, pushDevices: [], pulse: null };

describe("publishingItems", () => {
  it("is silent when nothing is failing", () => {
    expect(publishingItems(empty, NOW)).toEqual([]);
  });

  it("tiers a Example Shared failure by age and by whether it will retry", () => {
    const base = {
      id: "example_shared",
      label: "Example Shared",
      failed: 2,
      failedPermanent: 0,
      remoteMissing: 0,
      maxAttempts: 3,
      missingSince: null
    };
    const fresh = publishingItems({ ...empty, calendarSink: { ...base, failingSince: hoursAgo(2) } }, NOW);
    expect(fresh[0]).toMatchObject({
      id: "calendar_publish_failing:example_shared",
      tier: "degrading",
      area: "integrations"
    });
    const old = publishingItems({ ...empty, calendarSink: { ...base, failingSince: hoursAgo(30) } }, NOW);
    expect(old[0]?.tier).toBe("blocking");
    const permanent = publishingItems(
      { ...empty, calendarSink: { ...base, failedPermanent: 1, failingSince: hoursAgo(1) } },
      NOW
    );
    expect(permanent[0]?.tier).toBe("blocking");
  });

  it("words the items with the golden Example Shared strings", () => {
    const items = publishingItems(
      {
        ...empty,
        calendarSink: {
          id: "example_shared",
          label: "Example Shared",
          failed: 1,
          failedPermanent: 0,
          remoteMissing: 2,
          maxAttempts: 1,
          failingSince: hoursAgo(1),
          missingSince: hoursAgo(1)
        }
      },
      NOW
    );
    expect(items.map((i) => [i.title, i.why, i.handles, i.fix])).toEqual([
      [
        "1 calendar event is failing to publish to Example Shared",
        "The family calendar on Example Shared no longer matches the plan, so shared events can be missing or stale.",
        ["integration:example_shared"],
        {
          who: "person",
          question: "Is Example Shared still signed in? Should it be signed in again so publishing can retry?"
        }
      ],
      [
        "2 published events were deleted from Example Shared",
        "Upcoming events the plan shared are gone from the family calendar, so the family will not see them.",
        ["integration:example_shared"],
        { who: "person", question: "Was that deletion on purpose? Publish them again, or stop sharing them?" }
      ]
    ]);
  });

  it("reports remote-missing rows as degrading", () => {
    const items = publishingItems(
      {
        ...empty,
        calendarSink: {
          id: "example_shared",
          label: "Example Shared",
          failed: 0,
          failedPermanent: 0,
          remoteMissing: 1,
          maxAttempts: 0,
          failingSince: null,
          missingSince: hoursAgo(5)
        }
      },
      NOW
    );
    expect(items.map((i) => [i.id, i.tier])).toEqual([["calendar_remote_missing:example_shared", "degrading"]]);
  });

  it("flags a push device only when failures post-date its last success", () => {
    const device = (over: object) => ({
      id: "d1",
      kind: "web_push",
      label: "browser",
      handleKind: "push_subscription",
      failureCount: 3,
      lastSuccessAt: hoursAgo(50),
      lastFailureAt: hoursAgo(1),
      createdAt: hoursAgo(500),
      ...over
    });
    const failing = publishingItems({ ...empty, pushDevices: [device({ failureCount: 6 })] }, NOW);
    expect(failing[0]).toMatchObject({ id: "push_failing:d1", tier: "blocking", handles: ["push_subscription:d1"] });
    // A few failures is degrading even when the last success was days ago.
    expect(publishingItems({ ...empty, pushDevices: [device({ failureCount: 1 })] }, NOW)[0]?.tier).toBe("degrading");
    // Many failures but not spanning a day.
    const burst = device({ failureCount: 9, lastSuccessAt: hoursAgo(3), lastFailureAt: hoursAgo(1) });
    expect(publishingItems({ ...empty, pushDevices: [burst] }, NOW)[0]?.tier).toBe("degrading");
    // Nothing delivered for over 30 days: likely retired.
    const retired = device({ failureCount: 50, lastSuccessAt: hoursAgo(24 * 40), lastFailureAt: hoursAgo(1) });
    expect(publishingItems({ ...empty, pushDevices: [retired] }, NOW)[0]?.tier).toBe("tidy");
    expect(publishingItems({ ...empty, pushDevices: [device({ lastSuccessAt: hoursAgo(0.5) })] }, NOW)).toEqual([]);
    const recent = publishingItems(
      {
        ...empty,
        pushDevices: [
          device({
            kind: "other",
            label: "phone app",
            handleKind: "other_device",
            lastSuccessAt: null,
            createdAt: hoursAgo(2)
          })
        ]
      },
      NOW
    );
    expect(recent[0]).toMatchObject({ tier: "degrading", handles: ["other_device:d1"] });
    expect(recent[0]?.title).toContain("a phone app device");
  });

  it("flags a failing pulse publish and treats rejection as blocking", () => {
    const failed = publishingItems({ ...empty, pulse: { outcome: "failed", lastPublishedAt: hoursAgo(2) } }, NOW);
    expect(failed[0]).toMatchObject({ id: "pulse_publish_failing:pulse", tier: "degrading" });
    const rejected = publishingItems({ ...empty, pulse: { outcome: "rejected", lastPublishedAt: hoursAgo(2) } }, NOW);
    expect(rejected[0]?.tier).toBe("blocking");
    expect(publishingItems({ ...empty, pulse: { outcome: "delivered", lastPublishedAt: hoursAgo(1) } }, NOW)).toEqual(
      []
    );
  });
});
