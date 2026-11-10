// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { fireEvent, render, screen } from "@/test/render";
import { ApproveDeviceCode } from "./approve-device-code";

afterEach(() => vi.unstubAllGlobals());

const waiting = {
  name: "Phone",
  device: { installId: "c0ffee00-1234-4abc-8def-0123456789ab", platform: "ios" },
  requestedAt: "2026-11-10T09:00:00.000Z",
  from: "198.51.100.7"
};

function server(handler: (body: { userCode: string; decision?: string }) => Response) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    handler(JSON.parse(String(init?.body)) as { userCode: string; decision?: string })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ApproveDeviceCode", () => {
  it("looks the typed code up, shows who is asking, and approves only on the tap", async () => {
    const fetchMock = server((body) =>
      body.decision ? Response.json({ decision: body.decision, device: waiting }) : Response.json({ pending: waiting })
    );
    render(<ApproveDeviceCode />);
    fireEvent.change(screen.getByLabelText("The code the device is showing"), { target: { value: "bcdf-ghjk" } });
    fireEvent.click(screen.getByText("Look up"));
    expect(await screen.findByText(/Approve only a code shown on a device in your hand/)).toBeTruthy();
    expect(screen.getByText(/asked to sign in from 198\.51\.100\.7/)).toBeTruthy();
    // Looking up approved nothing.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ userCode: "bcdf-ghjk" });
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(screen.getByText(/is signed in/)).toBeTruthy());
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      userCode: "bcdf-ghjk",
      decision: "approve"
    });
  });

  it("can deny, and says so", async () => {
    server((body) =>
      body.decision ? Response.json({ decision: body.decision, device: waiting }) : Response.json({ pending: waiting })
    );
    render(<ApproveDeviceCode />);
    fireEvent.change(screen.getByLabelText("The code the device is showing"), { target: { value: "BCDF-GHJK" } });
    fireEvent.click(screen.getByText("Look up"));
    fireEvent.click(await screen.findByText("Deny"));
    expect(await screen.findByText(/was turned away/)).toBeTruthy();
  });

  it("shows the server's message for a wrong, used or expired code and stays on the entry form", async () => {
    server(() => Response.json({ error: "That code is not valid, has expired or was already used." }, { status: 404 }));
    render(<ApproveDeviceCode />);
    fireEvent.change(screen.getByLabelText("The code the device is showing"), { target: { value: "BBBB-BBBB" } });
    fireEvent.click(screen.getByText("Look up"));
    expect(await screen.findByText(/not valid, has expired or was already used/)).toBeTruthy();
    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.getByLabelText("The code the device is showing")).toBeTruthy();
  });

  it("takes the code only from what is typed, never from the address", () => {
    server(() => Response.json({}));
    window.history.pushState({}, "", "/settings/advanced/approve?code=BCDF-GHJK");
    render(<ApproveDeviceCode />);
    expect((screen.getByLabelText("The code the device is showing") as HTMLInputElement).value).toBe("");
    window.history.pushState({}, "", "/");
  });
});
