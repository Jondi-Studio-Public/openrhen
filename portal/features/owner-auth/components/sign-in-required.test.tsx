// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@/test/render";
import { PortalProvider } from "@/state/portal-provider";
import { browserLabel, SignInRequired } from "./sign-in-required";

afterEach(() => {
  window.localStorage.clear();
  cleanup();
  vi.unstubAllGlobals();
});

const refused = () =>
  ({
    ok: false,
    status: 401,
    headers: new Headers({ "x-owner-reason": "read-anonymous" }),
    json: async () => ({})
  }) as Response;

describe("sign in screen", () => {
  it("says the sign-in expired and where the recovery token is kept", () => {
    render(<SignInRequired expired />);
    expect(screen.getByText(/sign-in has expired/)).toBeTruthy();
    expect(screen.getByText(/recovery token you stored when you turned sign-in on/)).toBeTruthy();
  });

  it("keeps the first-visit wording for a browser that was never signed in", () => {
    render(<SignInRequired />);
    expect(screen.getByText(/isn't signed in yet/)).toBeTruthy();
    expect(screen.queryByText(/expired/)).toBeNull();
  });

  it("says it could not reach OpenRhen, not that the token was wrong, when the request fails", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    render(<SignInRequired />);
    fireEvent.change(screen.getByLabelText("Sign-in token"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText(/Could not reach OpenRhen to sign in/)).toBeTruthy();
  });

  it("replaces the app when /api/state answers 401 for owner auth, and asks for nothing else", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(url);
      return Promise.resolve(refused());
    });
    render(
      <PortalProvider>
        <p>private page</p>
      </PortalProvider>
    );
    expect(await screen.findByRole("heading", { name: "Sign in to OpenRhen" })).toBeTruthy();
    expect(screen.queryByText("private page")).toBeNull();
    expect(calls).toEqual(["/api/state"]);
  });

  it("shows no page before the first read answers, so nothing flashes up ahead of the sign-in screen", async () => {
    let answer: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => (answer = resolve)));
    render(
      <PortalProvider>
        <p>private page</p>
      </PortalProvider>
    );
    await waitFor(() => expect(answer).toBeDefined());
    const hidden = screen.queryByText("private page");
    expect(hidden === null || hidden.style.display === "none").toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    answer!(refused());
    expect(await screen.findByRole("heading", { name: "Sign in to OpenRhen" })).toBeTruthy();
    expect(screen.queryByText("private page")).toBeNull();
  });

  it("shows the page once the first read answers with the plan", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ state: null })
      } as Response)
    );
    render(
      <PortalProvider>
        <p>private page</p>
      </PortalProvider>
    );
    await waitFor(() => expect(screen.getByText("private page").style.display).not.toBe("none"));
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("posts the token to /api/owner/enroll and reloads when it is accepted", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(<SignInRequired />);
    fireEvent.change(screen.getByLabelText("Sign-in token"), { target: { value: " pri_own_x " } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    // Remembered, so a cookie the browser later drops still reads as an expired sign-in.
    expect(window.localStorage.getItem("openrhen.signedInBefore")).toBe("1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/owner/enroll",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ secret: "pri_own_x", label: browserLabel(navigator.userAgent) })
      })
    );
  });

  it("explains the screen, names the device after the browser, and sends a name the person typed", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(<SignInRequired />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sign in to OpenRhen");
    expect(
      screen.getByText("This browser isn't signed in yet. Paste a sign-in token once and it stays signed in.")
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Use the recovery token you stored when you turned sign-in on, or one made with `rhen owner-token create --label <device>`. The guide Locking down the API has the steps."
      )
    ).toBeTruthy();
    expect((screen.getByLabelText("Name this device") as HTMLInputElement).value).toBe(
      browserLabel(navigator.userAgent)
    );
    fireEvent.change(screen.getByLabelText("Name this device"), { target: { value: "Owner's iPhone" } });
    fireEvent.change(screen.getByLabelText("Sign-in token"), { target: { value: "pri_own_x" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/owner/enroll",
      expect.objectContaining({ body: JSON.stringify({ secret: "pri_own_x", label: "Owner's iPhone" }) })
    );
  });

  it("shows the refusal and does not reload when the token is wrong", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.stubGlobal(
      "fetch",
      async () => ({ ok: false, status: 401, json: async () => ({ error: "Not recognised." }) }) as Response
    );
    render(<SignInRequired />);
    fireEvent.change(screen.getByLabelText("Sign-in token"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not recognised.");
    expect(reload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("openrhen.signedInBefore")).toBeNull();
  });

  it("names the browser from its user agent so signed-in devices can be told apart", () => {
    expect(
      browserLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
      )
    ).toBe("Safari on iPhone");
    expect(
      browserLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"
      )
    ).toBe("Edge on Windows");
    expect(browserLabel("curl/8.0")).toBe("Browser");
  });
});
