// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { EvidenceDetails } from "./evidence-details";

describe("EvidenceDetails", () => {
  it("lists every fact under the summary the panel chose", () => {
    render(<EvidenceDetails summary="Why work is paused" evidence={["Dinner is confirmed", "Buffers apply"]} />);
    expect(screen.getByText("Why work is paused")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Dinner is confirmed",
      "Buffers apply"
    ]);
  });

  it("keeps extra detail a panel supplies alongside the list", () => {
    render(
      <EvidenceDetails summary="How calculated" evidence={["Deadline pressure"]}>
        <p>score breakdown</p>
      </EvidenceDetails>
    );
    expect(screen.getByText("score breakdown")).toBeTruthy();
  });
});
