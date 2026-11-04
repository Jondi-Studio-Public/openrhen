// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { closeCaptureSheet, useCaptureSheet } from "@/shared/use-capture-sheet";

vi.mock("next/navigation", () => ({ usePathname: () => "/inbox/captured" }));

const { AddSheet } = await import("./add-sheet");

function SheetProbe() {
  const sheet = useCaptureSheet();
  return <p>{sheet.open ? `sheet open: ${sheet.mode}` : "sheet closed"}</p>;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/inbox/captured");
});
afterEach(() => act(() => closeCaptureSheet()));

describe("AddSheet", () => {
  it("is a button that opens the shell's one sheet", () => {
    render(
      <>
        <AddSheet />
        <SheetProbe />
      </>
    );
    expect(screen.getByText("sheet closed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add or import" }));
    expect(screen.getByText("sheet open: capture")).toBeTruthy();
  });

  it("opens the sheet from the old /inbox#capture address and drops the hash", async () => {
    window.history.replaceState(null, "", "/inbox/captured#capture");
    render(
      <>
        <AddSheet />
        <SheetProbe />
      </>
    );
    await waitFor(() => expect(screen.getByText("sheet open: capture")).toBeTruthy());
    expect(window.location.hash).toBe("");
  });
});
