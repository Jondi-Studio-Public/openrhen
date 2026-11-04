// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { EstimateBucketsSection } from "@/features/settings/components/estimate-buckets-section";

describe("EstimateBucketsSection", () => {
  it("keeps the raw text the page holds, so a half-typed list is not reformatted mid-edit", () => {
    const onChange = vi.fn();
    render(<EstimateBucketsSection value="5, 15, 30" onChange={onChange} />);
    const input = screen.getByLabelText("Minutes, smallest to largest") as HTMLInputElement;
    expect(input.value).toBe("5, 15, 30");
    fireEvent.change(input, { target: { value: "5, 15, 30, 6" } });
    expect(onChange).toHaveBeenCalledWith("5, 15, 30, 6");
  });
});
