// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { render, screen } from "@/test/render";
import SignInSettingsPage from "./page";

afterEach(() => vi.unstubAllGlobals());

describe("Sign-in and devices settings page", () => {
  it("is the Sign-in and devices row, with a way back to You and the signed-in devices", async () => {
    const fetchMock = vi.fn(async (_url: string) => Response.json({ mode: "require", credentials: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SignInSettingsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Sign-in and devices" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "You" }).getAttribute("href")).toBe("/you");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/owner/session")).toBe(true));
    // Agent tokens and the map add-ons moved to AI and add-ons.
    expect(screen.queryByLabelText("Needs-reply list mode")).toBeNull();
  });
});
