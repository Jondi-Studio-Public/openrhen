// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { SecretsSection } from "./secrets-section";

const status = (over: Record<string, unknown> = {}) => ({
  masterKeyConfigured: true,
  ownerAuthRequired: true,
  canWrite: true,
  secrets: [{ name: "youtube_data_api_key", isSet: false, updatedAt: null, state: "unset" }],
  ...over
});
const setStatus = (state: "set" | "unreadable", updatedAt = "2026-11-06T03:00:00.000Z") => ({
  secrets: [{ name: "youtube_data_api_key", isSet: true, updatedAt, state }]
});

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("SecretsSection", () => {
  it("shows an unset key as Not set, in a password field with a Save button", async () => {
    stubFetch(() => Response.json(status()));
    render(<SecretsSection />);
    expect(await screen.findByText("Not set")).toBeTruthy();
    const field = screen.getByLabelText("YouTube Data API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("off");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("shows only the date once saved, offers Replace and Remove, and never puts a value in the field", async () => {
    stubFetch(() => Response.json(status(setStatus("set"))));
    render(<SecretsSection />);
    expect(await screen.findByText(/^Saved \d/)).toBeTruthy();
    expect((screen.getByLabelText("YouTube Data API key") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("says a key that cannot be opened is saved but unreadable and must be entered again", async () => {
    stubFetch(() => Response.json(status(setStatus("unreadable"))));
    render(<SecretsSection />);
    expect(await screen.findByText("Saved but unreadable: re-enter")).toBeTruthy();
  });

  it("saves what was typed with PUT, clears the field, and never shows the value again", async () => {
    let saved = false;
    const mock = stubFetch((url, init) => {
      if (init?.method === "PUT") {
        saved = true;
        return Response.json({
          name: "youtube_data_api_key",
          isSet: true,
          updatedAt: "2026-11-06T03:00:00.000Z",
          state: "set"
        });
      }
      return Response.json(status(saved ? setStatus("set") : {}));
    });
    render(<SecretsSection />);
    const field = (await screen.findByLabelText("YouTube Data API key")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "AIza-typed-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: "Replace" })).toBeTruthy();
    const put = mock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(put[0]).toBe("/api/settings/secrets/youtube_data_api_key");
    expect(JSON.parse(String(put[1]!.body))).toEqual({ value: "AIza-typed-secret" });
    expect(field.value).toBe("");
    expect(document.body.textContent).not.toContain("AIza-typed-secret");
  });

  it("removes a saved key", async () => {
    let removed = false;
    const mock = stubFetch((_url, init) => {
      if (init?.method === "DELETE") {
        removed = true;
        return Response.json({
          name: "youtube_data_api_key",
          isSet: false,
          updatedAt: null,
          state: "unset",
          removed: true
        });
      }
      return Response.json(status(removed ? {} : setStatus("set")));
    });
    render(<SecretsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Not set")).toBeTruthy();
    expect(mock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("explains exactly what to set when the master key is missing, and does not let a key be saved", async () => {
    stubFetch(() => Response.json(status({ masterKeyConfigured: false, canWrite: false })));
    render(<SecretsSection />);
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("OPENRHEN_SECRETS_KEY");
    expect(note.textContent).not.toContain("OPENRHEN_OWNER_AUTH=require");
    expect((screen.getByLabelText("YouTube Data API key") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("still lets a saved key be removed when the master key is missing but owner sign-in is on", async () => {
    stubFetch(() =>
      Response.json({ ...status({ masterKeyConfigured: false, canWrite: false }), ...setStatus("unreadable") })
    );
    render(<SecretsSection />);
    const remove = (await screen.findByRole("button", { name: "Remove" })) as HTMLButtonElement;
    expect(remove.disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Replace" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Remove when owner sign-in is off", async () => {
    stubFetch(() => Response.json({ ...status({ ownerAuthRequired: false, canWrite: false }), ...setStatus("set") }));
    render(<SecretsSection />);
    expect(((await screen.findByRole("button", { name: "Remove" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains how to turn on owner sign-in when it is off", async () => {
    stubFetch(() => Response.json(status({ ownerAuthRequired: false, canWrite: false })));
    render(<SecretsSection />);
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("OPENRHEN_OWNER_AUTH=require");
    expect(note.textContent).toContain("init-env.mjs --lockdown");
  });

  it("shows the server's explanation when a save is refused", async () => {
    stubFetch((_url, init) =>
      init?.method === "PUT"
        ? Response.json({ error: "Passwords and keys cannot be saved yet. Set X." }, { status: 409 })
        : Response.json(status())
    );
    render(<SecretsSection />);
    fireEvent.change(await screen.findByLabelText("YouTube Data API key"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Passwords and keys cannot be saved yet. Set X.");
  });

  it("states the honest limits of the encryption", async () => {
    stubFetch(() => Response.json(status()));
    render(<SecretsSection />);
    await screen.findByText("Not set");
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/never shown again/i);
    expect(text).toMatch(/database dump|backup/i);
    expect(text).toMatch(/not.*(compromised|someone who controls)/i);
  });

  it("says when the status could not be read", async () => {
    stubFetch(() => new Response("{}", { status: 500 }));
    render(<SecretsSection />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/could not be read/));
  });

  it("disables Save while empty", async () => {
    stubFetch(() => Response.json(status()));
    render(<SecretsSection />);
    await screen.findByText("Not set");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true)
    );
  });
});
