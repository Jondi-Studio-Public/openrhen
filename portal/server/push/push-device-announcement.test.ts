import { describe, expect, it } from "vitest";
import { leaveByPushPayloadSchema } from "@openrhen/contracts";
import { announcedLabel, DEVICE_ADDED_DEDUPE_PREFIX, deviceAddedPayload } from "./push-device-announcement";
import { subscriptionsForRow } from "./push-drain";

describe("deviceAddedPayload", () => {
  const now = new Date("2026-10-18T09:42:00.000Z");

  it("names the device and the local time and says how to remove it", () => {
    const payload = deviceAddedPayload("iPhone", now, "Australia/Sydney", "device_added:s1", "en-AU");
    expect(payload.body).toBe(
      "New device added for OpenRhen notifications: iPhone, 18 Oct, 8:42 pm. Not yours? Remove it in Settings > Notifications."
    );
    expect(payload.url).toBe("/settings/notifications");
    expect(payload.tag).toBe("device_added:s1");
    expect(leaveByPushPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("says Unnamed device when there is no label", () => {
    expect(announcedLabel(undefined)).toBe("Unnamed device");
    expect(announcedLabel(null)).toBe("Unnamed device");
    expect(announcedLabel("  \n\t ")).toBe("Unnamed device");
  });

  it("keeps a hostile label to one short line", () => {
    const label = `iPhone\n\nYour phone is fine.${"x".repeat(200)}`;
    const clean = announcedLabel(label);
    expect(clean).not.toMatch(/[\n\r]/);
    expect(clean.length).toBeLessThanOrEqual(40);
    expect(leaveByPushPayloadSchema.safeParse(deviceAddedPayload(label, now, "UTC", "k")).success).toBe(true);
  });
});

describe("subscriptionsForRow", () => {
  const subs = [{ id: "old-1" }, { id: "old-2" }, { id: "new-1" }];

  it("sends an ordinary row to every subscription", () => {
    expect(subscriptionsForRow("leave_by:c1:t:lead", subs)).toEqual(subs);
    expect(subscriptionsForRow("test:abc", subs)).toEqual(subs);
  });

  it("sends a new-device announcement to every subscription except the new one", () => {
    expect(subscriptionsForRow(`${DEVICE_ADDED_DEDUPE_PREFIX}new-1`, subs)).toEqual([{ id: "old-1" }, { id: "old-2" }]);
  });

  it("leaves nobody to send to when the new device is the only one", () => {
    expect(subscriptionsForRow(`${DEVICE_ADDED_DEDUPE_PREFIX}new-1`, [{ id: "new-1" }])).toEqual([]);
  });
});
