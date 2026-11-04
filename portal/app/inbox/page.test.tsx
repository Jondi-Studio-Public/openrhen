// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import { registerFakeMailSource } from "@/test/fake-mail-source";
import { mailSource } from "@/state/extensions";

// The core rules hold with the seam empty, as in the OpenRhen export; a fake provider stands in below.
vi.mock("@/state/private/index", () => ({}));

vi.mock("@/features/inbox/components/inbox-queue", () => ({
  InboxQueue: ({ filter }: { filter: string }) => <div data-testid="queue" data-filter={filter} />
}));

const { default: InboxPage } = await import("./page");
const { default: EmailsPage } = await import("./emails/page");
const { default: PeoplePage } = await import("./people/page");
const { default: CapturedPage } = await import("./captured/page");
const { default: CalendarPage } = await import("./calendar/page");
const { default: MapPage } = await import("./map/page");
const { default: KeptPage } = await import("./kept/page");

describe("/inbox", () => {
  it("has no Emails address while no mail provider is installed, and one once it is", () => {
    expect(mailSource()).toBeUndefined();
    expect(() => render(<EmailsPage />)).toThrow();
    registerFakeMailSource();
    render(<EmailsPage />);
    expect(screen.getByTestId("queue").getAttribute("data-filter")).toBe("emails");
  });

  it.each([
    ["/inbox", InboxPage, "all"],
    ["/inbox/emails", EmailsPage, "emails"],
    ["/inbox/people", PeoplePage, "people"],
    ["/inbox/captured", CapturedPage, "captured"],
    ["/inbox/calendar", CalendarPage, "calendar"],
    ["/inbox/map", MapPage, "map"],
    ["/inbox/kept", KeptPage, "kept"]
  ] as const)("%s shows the one queue filtered to %s", (_path, Page, filter) => {
    render(<Page />);
    expect(screen.getByTestId("queue").getAttribute("data-filter")).toBe(filter);
  });
});
