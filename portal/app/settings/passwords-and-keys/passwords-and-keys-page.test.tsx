// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";

afterEach(() => vi.unstubAllGlobals());

describe("Passwords and keys settings page", () => {
  it("is the page its settings row opens, with the section and its explanation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            masterKeyConfigured: true,
            ownerAuthRequired: true,
            canWrite: true,
            secrets: [{ name: "youtube_data_api_key", isSet: false, updatedAt: null, state: "unset" }]
          })
        )
      )
    );
    const { default: Page } = await import("./page");
    render(<Page />);
    expect(screen.getByRole("heading", { level: 1, name: "Passwords and keys" })).toBeTruthy();
    expect(await screen.findByLabelText("YouTube Data API key")).toBeTruthy();
  });
});
