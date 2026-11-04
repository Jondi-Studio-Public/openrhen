// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { AiModelSection, DEFAULT_AI_MODEL } from "@/features/settings/components/ai-model-section";
import { defaultPlanningSettings } from "@/state/portal-state";

describe("AiModelSection", () => {
  it("defaults every tool to unset", () => {
    render(<AiModelSection draft={defaultPlanningSettings()} onChange={vi.fn()} />);
    const select = screen.getByLabelText(/^Deliverable workspace chat/) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getAllByText(`Default (${DEFAULT_AI_MODEL})`)).toHaveLength(2);
  });

  it("picks a known model from the dropdown", () => {
    const onChange = vi.fn();
    render(<AiModelSection draft={defaultPlanningSettings()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/^Deliverable workspace chat/), { target: { value: "gpt-5" } });
    expect(onChange).toHaveBeenCalledWith({ deliverableChatModel: "gpt-5" });
  });

  it("reveals a text field for a custom model id and reports it", () => {
    const onChange = vi.fn();
    render(<AiModelSection draft={defaultPlanningSettings()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/^Import extraction/), { target: { value: "custom" } });
    const custom = screen.getByLabelText("Custom model id for Import extraction");
    fireEvent.change(custom, { target: { value: "gpt-4.1-mini" } });
    expect(onChange).toHaveBeenCalledWith({ importExtractorModel: "gpt-4.1-mini" });
  });

  it("shows the custom field pre-filled when the stored value is not in the known list", () => {
    render(
      <AiModelSection
        draft={{ ...defaultPlanningSettings(), deliverableChatModel: "gpt-4.1-mini" }}
        onChange={vi.fn()}
      />
    );
    const select = screen.getByLabelText(/^Deliverable workspace chat/) as HTMLSelectElement;
    expect(select.value).toBe("custom");
    expect((screen.getByLabelText("Custom model id for Deliverable workspace chat") as HTMLInputElement).value).toBe(
      "gpt-4.1-mini"
    );
  });

  it("clears back to default when Default is chosen", () => {
    const onChange = vi.fn();
    render(
      <AiModelSection draft={{ ...defaultPlanningSettings(), deliverableChatModel: "gpt-5" }} onChange={onChange} />
    );
    fireEvent.change(screen.getByLabelText(/^Deliverable workspace chat/), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith({ deliverableChatModel: undefined });
  });
});
