// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { MailUnderstandingSection } from "./mail-understanding-section";

const settings = {
  ollamaUrl: "http://192.168.1.20:11434",
  t2Model: "qwen3:8b",
  t3Model: "Qwen/Qwen3-14B",
  t3DailyMessageCap: 50,
  t3DailyTokenCap: 200_000,
  backfillDays: 90,
  updatedAt: "2026-11-08T00:00:00.000Z"
};
const loaded = (over: Record<string, unknown> = {}) => ({
  settings,
  usage: { messages: 7, tokens: 4200 },
  note: "The hosted key is under Passwords and keys.",
  ...over
});
const secrets = (isSet: boolean) => ({
  masterKeyConfigured: true,
  ownerAuthRequired: true,
  canWrite: true,
  secrets: [
    {
      name: "hosted_model_api_key",
      isSet,
      updatedAt: isSet ? "2026-11-06T00:00:00.000Z" : null,
      state: isSet ? "set" : "unset"
    }
  ]
});

afterEach(() => vi.unstubAllGlobals());

function stubFetch(routes: Record<string, (init?: RequestInit) => unknown>) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const handler = routes[key];
    if (!handler) return Promise.reject(new Error(`unexpected ${key}`));
    return Promise.resolve(Response.json(handler(init)));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
const baseRoutes = (key = true) => ({
  "GET /api/derived-settings": () => loaded(),
  "GET /api/settings/secrets": () => secrets(key)
});

describe("MailUnderstandingSection", () => {
  it("shows the saved values, today's hosted sends against the caps, and the key state", async () => {
    stubFetch(baseRoutes());
    render(<MailUnderstandingSection />);
    expect(((await screen.findByLabelText("Ollama address")) as HTMLInputElement).value).toBe(
      "http://192.168.1.20:11434"
    );
    expect((screen.getByLabelText("Local model") as HTMLInputElement).value).toBe("qwen3:8b");
    expect((screen.getByLabelText("Hosted model") as HTMLInputElement).value).toBe("Qwen/Qwen3-14B");
    expect(screen.getByText(/Leave the hosted model empty, or set the daily messages to 0/i)).toBeTruthy();
    expect((screen.getByLabelText("Hosted messages a day") as HTMLInputElement).value).toBe("50");
    expect((screen.getByLabelText("Hosted tokens a day") as HTMLInputElement).value).toBe("200000");
    expect((screen.getByLabelText("Days to look back") as HTMLInputElement).value).toBe("90");
    expect(screen.getByText(/7 of 50 messages/)).toBeTruthy();
    expect(screen.getByText(/4,200 of 200,000 tokens/)).toBeTruthy();
    expect(screen.getByText(/DeepInfra key: saved/)).toBeTruthy();
  });

  it("says the deny-list is reactive and where the retention policy comes from", async () => {
    stubFetch(baseRoutes());
    render(<MailUnderstandingSection />);
    await screen.findByLabelText("Ollama address");
    expect(screen.getByText(/first mail from a new sensitive sender/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /DeepInfra data privacy/i }) as HTMLAnchorElement;
    expect(link.href).toBe("https://docs.deepinfra.com/account/data-privacy");
    expect(screen.getByText(/no setting to turn on/i)).toBeTruthy();
    expect(screen.getByText(/Google or Anthropic/)).toBeTruthy();
  });

  it("points to Passwords and keys, with the restore warning, when no key is saved", async () => {
    stubFetch(baseRoutes(false));
    render(<MailUnderstandingSection />);
    expect(await screen.findByText(/DeepInfra key: not saved/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Passwords and keys" }).getAttribute("href")).toBe(
      "/settings/passwords-and-keys"
    );
    expect(screen.getByText(/restore.*empties/i)).toBeTruthy();
  });

  it("saves only the fields that changed, as numbers", async () => {
    const mock = stubFetch({
      ...baseRoutes(),
      "PUT /api/derived-settings": () => loaded({ settings: { ...settings, t3DailyMessageCap: 20 } })
    });
    render(<MailUnderstandingSection />);
    const cap = await screen.findByLabelText("Hosted messages a day");
    fireEvent.change(cap, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    const put = mock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({ t3DailyMessageCap: 20 });
  });

  it("shows the server's sentence when a save is refused", async () => {
    stubFetch({
      ...baseRoutes(),
      "PUT /api/derived-settings": () => ({ error: "backfillDays must be a whole number from 1 to 3650" })
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = vi.fn((url: string, init?: RequestInit) =>
      url === "/api/derived-settings" && init?.method === "PUT"
        ? Promise.resolve(
            Response.json({ error: "backfillDays must be a whole number from 1 to 3650" }, { status: 400 })
          )
        : Promise.resolve(Response.json(url === "/api/derived-settings" ? loaded() : secrets(true)))
    );
    vi.stubGlobal("fetch", mock);
    render(<MailUnderstandingSection />);
    fireEvent.change(await screen.findByLabelText("Days to look back"), { target: { value: "9999" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("1 to 3650");
  });

  it("tests the local model and shows success", async () => {
    const mock = stubFetch({
      ...baseRoutes(),
      "POST /api/derived-settings/test": () => ({
        result: { ok: true, tier: "t2", model: "qwen3:8b", ms: 1200, tokensIn: 30, tokensOut: 8 }
      })
    });
    render(<MailUnderstandingSection />);
    await screen.findByLabelText("Ollama address");
    fireEvent.click(screen.getByRole("button", { name: "Test local model" }));
    expect(await screen.findByText(/Local model answered in 1\.2 s/)).toBeTruthy();
    const post = mock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ tier: "t2" });
    expect(screen.queryByText(/SetEnvironmentVariable/)).toBeNull();
  });

  it("on a failed local test shows the reason and the exact PowerShell lines for the saved address", async () => {
    stubFetch({
      ...baseRoutes(),
      "POST /api/derived-settings/test": () => ({
        result: {
          ok: false,
          tier: "t2",
          outcome: "unreachable",
          message: "Could not connect to Ollama at 192.168.1.20:11434.",
          ms: 40
        }
      })
    });
    render(<MailUnderstandingSection />);
    await screen.findByLabelText("Ollama address");
    fireEvent.click(screen.getByRole("button", { name: "Test local model" }));
    expect(await screen.findByText(/Could not connect to Ollama at 192\.168\.1\.20:11434/)).toBeTruthy();
    expect(screen.getByText(/SetEnvironmentVariable\("OLLAMA_HOST", "192\.168\.1\.20:11434", "User"\)/)).toBeTruthy();
    expect(screen.getByText(/New-NetFirewallRule/)).toBeTruthy();
  });

  it("does not show the PowerShell lines for a failed hosted test", async () => {
    stubFetch({
      ...baseRoutes(),
      "POST /api/derived-settings/test": () => ({
        result: { ok: false, tier: "t3", outcome: "bad_key", message: "No DeepInfra key is saved.", ms: 2 }
      })
    });
    render(<MailUnderstandingSection />);
    await screen.findByLabelText("Ollama address");
    fireEvent.click(screen.getByRole("button", { name: "Test hosted model" }));
    expect(await screen.findByText(/No DeepInfra key is saved/)).toBeTruthy();
    expect(screen.queryByText(/SetEnvironmentVariable/)).toBeNull();
  });

  it("says the test uses made-up text and not mail", async () => {
    stubFetch(baseRoutes());
    render(<MailUnderstandingSection />);
    await screen.findByLabelText("Ollama address");
    expect(screen.getByText(/made-up text, never your mail/i)).toBeTruthy();
  });

  it("offers a retry when the settings cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("x", { status: 500 })))
    );
    render(<MailUnderstandingSection />);
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
