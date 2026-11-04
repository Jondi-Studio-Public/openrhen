import "@/test/example-calendar-sources";
import { describe, expect, it } from "vitest";
import { commitmentFieldsFromSnapshot, linkImportKey } from "./commitment-source-commands";
import { registerImportExtension } from "./imports/import-extensions";
import { googleEventKey } from "./imports/calendar-profiles/calendar";

describe("commitmentFieldsFromSnapshot", () => {
  it("rebuilds a commitment from a Example Shared-shaped snapshot", () => {
    const fields = commitmentFieldsFromSnapshot({
      externalEventId: "s1",
      title: "  Dentist ",
      startsAt: "2026-09-30T00:00:00.000Z",
      endsAt: "2026-09-30T01:00:00.000Z",
      location: " Riverside ",
      status: "confirmed"
    });
    expect(fields).toEqual({
      title: "Dentist",
      startsAt: new Date("2026-09-30T00:00:00.000Z"),
      endsAt: new Date("2026-09-30T01:00:00.000Z"),
      location: "Riverside"
    });
  });

  it("treats a missing or blank location as none", () => {
    const base = { title: "Dentist", startsAt: "2026-09-30T00:00:00.000Z", endsAt: "2026-09-30T01:00:00.000Z" };
    expect(commitmentFieldsFromSnapshot({ ...base, location: null })?.location).toBeNull();
    expect(commitmentFieldsFromSnapshot({ ...base, location: "  " })?.location).toBeNull();
    expect(commitmentFieldsFromSnapshot(base)?.location).toBeNull();
  });

  it("gives up on a snapshot that cannot describe a commitment", () => {
    const good = { title: "Dentist", startsAt: "2026-09-30T00:00:00.000Z", endsAt: "2026-09-30T01:00:00.000Z" };
    expect(commitmentFieldsFromSnapshot(null)).toBeNull();
    expect(commitmentFieldsFromSnapshot([])).toBeNull();
    expect(commitmentFieldsFromSnapshot({})).toBeNull();
    expect(commitmentFieldsFromSnapshot({ ...good, title: " " })).toBeNull();
    expect(commitmentFieldsFromSnapshot({ ...good, startsAt: "not a date" })).toBeNull();
    expect(commitmentFieldsFromSnapshot({ ...good, endsAt: good.startsAt })).toBeNull();
    expect(commitmentFieldsFromSnapshot({ ...good, endsAt: undefined })).toBeNull();
  });
});

// A key an import extension gives its own provider's links (see import-extensions.ts).
registerImportExtension({
  id: "example",
  sourceTypes: ["example"],
  linkImportKey: (_provider, frame, event) => `example:${frame}:${event}`
});

describe("linkImportKey", () => {
  it("derives the key each diff writes for its event", () => {
    expect(linkImportKey("example", "frame-1", "evt")).toBe("example:frame-1:evt");
    expect(linkImportKey("google_calendar", "cal@example.com", "g1")).toBe(
      `google_calendar:event:${googleEventKey("cal@example.com", "g1")}`
    );
  });

  it("has none for a provider no diff keys", () => {
    expect(linkImportKey("email", "f", "t1")).toBeNull();
  });
});
