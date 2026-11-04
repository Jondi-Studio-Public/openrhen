// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { Field } from "@/components/field";

describe("Field", () => {
  it("labels the single control it wraps so it can be found by name", () => {
    render(
      <Field label="Usable percentage">
        <input type="number" defaultValue={85} />
      </Field>
    );
    expect((screen.getByLabelText("Usable percentage") as HTMLInputElement).value).toBe("85");
  });

  it("spans the editor grid only when asked to", () => {
    const { container } = render(
      <Field label="Notes" wide>
        <input />
      </Field>
    );
    expect(container.querySelector("label")!.className).toBe("field wide");
  });

  it("names a group with a legend and leaves each checkbox its own name", () => {
    const { container } = render(
      <Field label="Where can this be done?" group wide>
        <label>
          <input type="checkbox" />
          <span>At home</span>
        </label>
        <label>
          <input type="checkbox" />
          <span>Outdoors</span>
        </label>
      </Field>
    );
    const fieldset = container.querySelector("fieldset")!;
    expect(fieldset.className).toBe("field wide");
    expect(container.querySelector("label")!.className).toBe("");
    expect(screen.getByRole("group", { name: "Where can this be done?" })).toBe(fieldset);
    expect(screen.getByRole("checkbox", { name: "At home" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Outdoors" })).toBeTruthy();
  });
});
