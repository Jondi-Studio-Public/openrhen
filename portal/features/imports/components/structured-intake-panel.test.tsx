// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { importCsvEntities } from "@/features/imports/import-spec";
import { StructuredIntakePanel } from "./structured-intake-panel";

const state = createSeedState(new Date("2026-08-18T09:00:00.000Z"));
const props = {
  state,
  busy: false,
  referenceScopes: [],
  onReferenceScopesChange: vi.fn(),
  onDownloadReferenceFiles: vi.fn(),
  onSelectFiles: vi.fn()
};

describe("StructuredIntakePanel", () => {
  it("keeps both pack downloads inert until a scope is selected", () => {
    render(<StructuredIntakePanel {...props} />);
    for (const name of ["Download add-only pack", "Download editing pack"])
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers the two packs and nothing loose — no workbook or guide on its own", () => {
    render(<StructuredIntakePanel {...props} referenceScopes={[{ type: "area", id: "area-study" }]} />);
    for (const gone of ["Workbook only", "Tool guide only", "Round-trip workbook"])
      expect(screen.queryByText(gone)).toBeNull();
    expect(screen.queryAllByRole("link").every((link) => !link.getAttribute("href")?.includes("reference-pack"))).toBe(
      true
    );
  });

  it("asks for the pack the pressed button names, workbook and guide together", () => {
    const onDownloadReferenceFiles = vi.fn();
    render(
      <StructuredIntakePanel
        {...props}
        referenceScopes={[{ type: "plan" }]}
        onDownloadReferenceFiles={onDownloadReferenceFiles}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Download add-only pack" }));
    expect(onDownloadReferenceFiles).toHaveBeenLastCalledWith("add");
    fireEvent.click(screen.getByRole("button", { name: "Download editing pack" }));
    expect(onDownloadReferenceFiles).toHaveBeenLastCalledWith("roundtrip");
  });

  it("puts every CSV path in the fold: the archive, the field guide, and one file per entity", () => {
    const { container } = render(<StructuredIntakePanel {...props} />);
    const hrefs = [...container.querySelectorAll("details.csv-fold a")].map((link) => link.getAttribute("href"));
    expect(hrefs.slice(0, 2)).toEqual(["/api/imports/templates.zip", "/import-template-guide.md"]);
    expect(hrefs).toHaveLength(importCsvEntities.length + 2);
    expect(screen.getByRole("link", { name: "fixed commitments.csv" }).getAttribute("href")).toBe(
      "/api/imports/templates/fixed_commitments"
    );
  });

  it("leaves nothing to download above the folds", () => {
    const { container } = render(<StructuredIntakePanel {...props} />);
    expect(container.querySelector(".bulk-intake > .template-links")).toBeNull();
    expect(screen.queryByRole("link", { name: "Complete XLSX workbook" })).toBeNull();
    expect(container.querySelector<HTMLDetailsElement>("details.csv-fold")!.open).toBe(false);
  });

  it("hands a chosen file selection to the page", () => {
    const onSelectFiles = vi.fn();
    const { container } = render(<StructuredIntakePanel {...props} onSelectFiles={onSelectFiles} />);
    const input = container.querySelector<HTMLInputElement>(".file-drop input")!;
    fireEvent.change(input, { target: { files: [new File(["a"], "areas.csv", { type: "text/csv" })] } });
    expect(onSelectFiles).toHaveBeenCalledOnce();
  });

  it("puts the drop zone first and folds every template path away behind it", () => {
    const { container } = render(<StructuredIntakePanel {...props} />);
    const order = [...container.querySelectorAll(".file-drop, details.csv-fold, details.reference-fold")].map(
      (element) => element.className
    );
    expect(order).toEqual(["file-drop", "csv-fold", "reference-fold"]);
    for (const fold of ["csv-fold", "reference-fold"])
      expect(container.querySelector<HTMLDetailsElement>(`details.${fold}`)!.open).toBe(false);
  });

  it("says what each pack is for, and which way its preview should read", () => {
    render(<StructuredIntakePanel {...props} referenceScopes={[{ type: "plan" }]} />);
    expect(screen.getByText(/ignored Reference sheets beside empty import sheets/)).toBeTruthy();
    expect(screen.getByText(/pre-filled with your current records/)).toBeTruthy();
    expect(screen.getByText(/should preview as Create/)).toBeTruthy();
    expect(screen.getByText(/should preview as Update/)).toBeTruthy();
  });
});
