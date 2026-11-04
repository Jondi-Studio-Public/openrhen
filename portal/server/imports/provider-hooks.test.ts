import { describe, expect, it, vi } from "vitest";
import {
  calendarSyncAdapterFor,
  providerConnectionHandlers,
  registerCalendarSyncAdapter,
  registerProviderConnectionHandlers,
  registerPublishRequester,
  requestCalendarPublish
} from "./provider-hooks";

describe("provider hooks", () => {
  it("asks every registered requester to publish, once each however often it is registered", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerPublishRequester(first);
    registerPublishRequester(first);
    registerPublishRequester(second);
    requestCalendarPublish();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("looks connection handlers and sync adapters up by id and by diff profile", () => {
    expect(providerConnectionHandlers("example_unregistered")).toBeUndefined();
    const handlers = { proof: async () => ({ status: "ok" }) };
    registerProviderConnectionHandlers("example_registered", handlers);
    expect(providerConnectionHandlers("example_registered")).toBe(handlers);
    expect(calendarSyncAdapterFor("example_profile")).toBeUndefined();
    const adapter = { provider: "example", sourceType: "example", ownSourceType: "example_event", read: vi.fn() };
    registerCalendarSyncAdapter("example_profile", adapter as never);
    expect(calendarSyncAdapterFor("example_profile")).toBe(adapter);
  });
});
