// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { RecoveryPanel } from "./recovery-panel";

describe("RecoveryPanel", () => {
  it("names recovery as the recommendation, not as leftover time", () => {
    render(
      <RecoveryPanel
        recommendedMinutes={40}
        explanation="Only recovery capacity is open."
        evidence={["No action matches recovery energy"]}
      />
    );
    expect(screen.getByText("For 40 minutes · protected recovery")).toBeTruthy();
    expect(screen.getByText(/Only recovery capacity is open./)).toBeTruthy();
    expect(screen.getByText("Why nothing else fits")).toBeTruthy();
  });

  it("drops the explanation list when there is no evidence to show", () => {
    render(<RecoveryPanel recommendedMinutes={40} explanation="Only recovery capacity is open." evidence={[]} />);
    expect(screen.queryByText("Why nothing else fits")).toBeNull();
  });
});
