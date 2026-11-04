// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, fireEvent, render, screen, within } from "@/test/render";
import { TypedConditionManager } from "@/features/settings/components/typed-context-manager";
import type { ConditionDefinition } from "@/features/settings/context-summary";
import type { PortalState } from "@/state/portal-state";
import { closeEntityCommandSchema } from "@openrhen/contracts";
import { resultFor } from "@/test/close-fixtures";

// The Archive / Restore control reads the row from portal state and posts to the close route; stand in for both.
let portalDefinitions: ConditionDefinition[] = [];
const closeEntityCommand = vi.fn(async (command: unknown) =>
  resultFor(closeEntityCommandSchema.parse(command), { version: 3 })
);
vi.mock("@/state/portal-provider", () => ({
  usePortal: () => ({ state: { conditionDefinitions: portalDefinitions }, closeEntityCommand })
}));

type SaveMock = (entity: Record<string, unknown>, expectedVersion: number | null) => Promise<void>;

const definition = (overrides: Partial<ConditionDefinition> & { id: string; name: string }): ConditionDefinition => ({
  kind: "capability",
  status: "active",
  pathways: [],
  portability: "fixed",
  grants: [],
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  channels: [],
  ...overrides
});

const section = (title: string) =>
  within(screen.getByRole("heading", { name: title }).closest("section") as HTMLElement);

function renderManager(
  definitions: ConditionDefinition[],
  onSave: Mock<SaveMock> = vi.fn<SaveMock>(),
  home: { homeLocationId?: string | undefined; onHomeLocationChange?: (id: string | undefined) => void } = {},
  linked: {
    commitmentRecurrenceRules?: PortalState["commitmentRecurrenceRules"];
    commitments?: PortalState["commitments"];
  } = {}
) {
  portalDefinitions = definitions.map((entry) => ({ ...entry, version: 3 }));
  render(
    <TypedConditionManager
      definitions={definitions}
      actions={[] as PortalState["actions"]}
      routinePresets={[]}
      commitmentRecurrenceRules={linked.commitmentRecurrenceRules ?? []}
      commitments={linked.commitments ?? []}
      saving={false}
      homeLocationId={home.homeLocationId}
      onHomeLocationChange={home.onHomeLocationChange ?? (() => {})}
      onSave={onSave}
    />
  );
  return onSave;
}

const HARBOR_MART_MATCH = { label: "Harbor Mart, Riverside", latitude: -36.12345, longitude: 146.88 };

const stubGeocode = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ matches: [HARBOR_MART_MATCH] }) }))
  );

/** Edit the nth place, search, and take the one match — the path the address bleed was reported on. */
async function findAndSelect(cardIndex: number, query: string) {
  const cards = section("Locations").getAllByRole("article");
  fireEvent.click(within(cards[cardIndex] as HTMLElement).getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByPlaceholderText(/^Type a place/), { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: HARBOR_MART_MATCH.label }));
}

const places = () => [
  definition({
    id: "harbor-mart",
    name: "Harbor Mart",
    kind: "location",
    latitude: -36.1,
    longitude: 146.9,
    version: 2
  }),
  definition({ id: "campus", name: "Campus", kind: "location", latitude: -36.5, longitude: 146.4, version: 7 })
];

describe("TypedConditionManager", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows one section per kind, each empty until something is defined", () => {
    renderManager([]);
    for (const title of ["Locations", "Capabilities", "Contacts"])
      expect(section(title).getByText("None yet.")).toBeTruthy();
  });

  it("files a definition under its own kind and describes what it will do", () => {
    renderManager([
      definition({ id: "home", name: "Home", kind: "location", grants: ["desk"] }),
      definition({ id: "desk", name: "Desk" })
    ]);
    expect(section("Locations").getByText("grants desk · 0 actions")).toBeTruthy();
    expect(section("Capabilities").getByText("belongs to a place · 0 actions")).toBeTruthy();
  });

  it("opens an empty editor for the kind whose Add was pressed", () => {
    renderManager([]);
    fireEvent.click(section("Contacts").getByRole("button", { name: "Add" }));
    expect(screen.getByText("in_person")).toBeTruthy();
    expect(screen.getByLabelText(/^Id/)).toBeTruthy();
  });

  it("insists on a name before it will save", () => {
    const onSave = renderManager([]);
    fireEvent.click(section("Capabilities").getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("status").textContent).toBe("Name it first.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("derives a usable id from the name and closes the editor once it is saved", async () => {
    const onSave = renderManager(
      [],
      vi.fn<SaveMock>(async () => {})
    );
    fireEvent.click(section("Capabilities").getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Standing Desk!  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(onSave).toHaveBeenCalledTimes(1);
    const [entity, expectedVersion] = onSave.mock.calls[0]!;
    expect(entity.id).toBe("standing-desk");
    expect(entity.name).toBe("Standing Desk!");
    expect(expectedVersion).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Saved “Standing Desk!”.");
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("refuses a name that cannot produce an id at all", () => {
    const onSave = renderManager([]);
    fireEvent.click(section("Capabilities").getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "!!!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("status").textContent).toBe(
      "That name does not produce a usable id. Use some letters or numbers."
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps the editor open and explains a rejected save", async () => {
    renderManager(
      [],
      vi.fn<SaveMock>(async () => {
        throw new Error("Someone else changed it.");
      })
    );
    fireEvent.click(section("Capabilities").getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Desk" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toBe("Someone else changed it.");
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  it("sends the stored version when an existing definition is edited", async () => {
    const onSave = renderManager(
      [definition({ id: "desk", name: "Desk", version: 4 })],
      vi.fn<SaveMock>(async () => {})
    );
    fireEvent.click(section("Capabilities").getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(onSave.mock.calls[0]![1]).toBe(4);
  });

  it("lists the places that have no actual location, and refuses to add another one", () => {
    const onSave = renderManager([
      definition({ id: "home", name: "Home", kind: "location", latitude: -36.1, longitude: 146.9 }),
      definition({ id: "harbor-mart", name: "Harbor Mart", kind: "location" })
    ]);
    const locations = section("Locations");
    const warning = locations.getByRole("alert");
    expect(warning.textContent).toContain("1 place has no actual location set");
    expect(warning.textContent).toContain("Harbor Mart");
    expect(warning.textContent).not.toContain("Home");
    fireEvent.click(locations.getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Woolworths" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("jumps straight into the editor for a place the audit named", () => {
    renderManager([definition({ id: "harbor-mart", name: "Harbor Mart", kind: "location" })]);
    fireEvent.click(within(section("Locations").getByRole("alert")).getByRole("button", { name: "Set location" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Harbor Mart");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says nothing when every place is placed", () => {
    renderManager([definition({ id: "home", name: "Home", kind: "location", latitude: -36.1, longitude: 146.9 })]);
    expect(section("Locations").queryByRole("alert")).toBeNull();
  });

  it("picks the home base from the active places only, and reports the choice back", () => {
    const onHomeLocationChange = vi.fn();
    renderManager(
      [
        definition({ id: "home", name: "Home", kind: "location" }),
        definition({ id: "campus", name: "Campus", kind: "location" }),
        definition({ id: "shed", name: "Old shed", kind: "location", status: "archived" }),
        definition({ id: "desk", name: "Desk" })
      ],
      vi.fn<SaveMock>(),
      { homeLocationId: "home", onHomeLocationChange }
    );
    const select = screen.getByLabelText(/^Home base/) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["— none —", "Home", "Campus"]);
    expect(select.value).toBe("home");
    fireEvent.change(select, { target: { value: "campus" } });
    expect(onHomeLocationChange).toHaveBeenCalledWith("campus");
    fireEvent.change(select, { target: { value: "" } });
    expect(onHomeLocationChange).toHaveBeenLastCalledWith(undefined);
  });

  it("marks the home base in the list and will not let its editor archive it", () => {
    renderManager(
      [
        definition({ id: "home", name: "Home", kind: "location" }),
        definition({ id: "campus", name: "Campus", kind: "location" })
      ],
      vi.fn<SaveMock>(),
      { homeLocationId: "home" }
    );
    const locations = section("Locations");
    const [homeCard, campusCard] = locations.getAllByRole("article");
    expect(within(homeCard as HTMLElement).getByText("Home", { selector: "span" })).toBeTruthy();
    expect(within(campusCard as HTMLElement).queryByText("Home", { selector: "span" })).toBeNull();

    fireEvent.click(within(homeCard as HTMLElement).getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("button", { name: /^Archive context/ })).toBeNull();
    expect(screen.getByText("This is your home base. Choose another home base first.")).toBeTruthy();
  });

  it("archives a place that is not home through the close route, not a status save", async () => {
    const onSave = renderManager(
      [
        definition({ id: "home", name: "Home", kind: "location" }),
        definition({ id: "campus", name: "Campus", kind: "location" })
      ],
      vi.fn<SaveMock>(),
      { homeLocationId: "home" }
    );
    closeEntityCommand.mockClear();
    const cards = section("Locations").getAllByRole("article");
    fireEvent.click(within(cards[1] as HTMLElement).getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("option", { name: "Archived" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Archive context/ }));
    });
    expect(closeEntityCommand).toHaveBeenCalledOnce();
    expect(closeEntityCommandSchema.parse(closeEntityCommand.mock.calls[0]![0])).toMatchObject({
      type: "condition_definition",
      id: "campus",
      verb: "archive",
      do: "close",
      expectedVersion: 3
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("offers Restore, not Archive, for an archived place", () => {
    renderManager([definition({ id: "shed", name: "Old shed", kind: "location", status: "archived" })]);
    fireEvent.click(within(section("Locations").getByRole("article")).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: /^Restore/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Archive context/ })).toBeNull();
  });

  it("puts a chosen match on the place being edited and saves that place alone", async () => {
    stubGeocode();
    const onSave = renderManager(
      places(),
      vi.fn<SaveMock>(async () => {})
    );
    await findAndSelect(0, "Harbor Mart");
    expect((screen.getByPlaceholderText("latitude") as HTMLInputElement).value).toBe("-36.12345");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(onSave).toHaveBeenCalledTimes(1);
    const [entity, expectedVersion] = onSave.mock.calls[0]!;
    expect(entity.id).toBe("harbor-mart");
    expect(entity.latitude).toBe(HARBOR_MART_MATCH.latitude);
    expect(entity.longitude).toBe(HARBOR_MART_MATCH.longitude);
    expect(entity.address).toBe(HARBOR_MART_MATCH.label);
    expect(expectedVersion).toBe(2);
  });

  it("shows the address a saved place was found at, so its coordinates are not all there is to read", () => {
    renderManager([
      definition({
        id: "harbor-mart",
        name: "Harbor Mart",
        kind: "location",
        latitude: -36.12345,
        longitude: 146.88123,
        address: "Harbor Mart, Riverside"
      })
    ]);
    fireEvent.click(section("Locations").getByRole("button", { name: "Edit" }));
    expect(screen.getByText(/Set to Harbor Mart, Riverside \(-36\.12345, 146\.88123\)/)).toBeTruthy();
  });

  it("stops showing an address once the coordinates under it are changed or cleared", async () => {
    stubGeocode();
    renderManager(
      places(),
      vi.fn<SaveMock>(async () => {})
    );
    await findAndSelect(0, "Harbor Mart");
    expect(screen.getByText(new RegExp(HARBOR_MART_MATCH.label))).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("latitude"), { target: { value: "-37.5" } });
    expect(screen.queryByText(new RegExp(HARBOR_MART_MATCH.label))).toBeNull();
    expect(screen.getByText(/Set to -37\.50000, 146\.88000/)).toBeTruthy();

    await findAndSelect(0, "Harbor Mart");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(new RegExp(HARBOR_MART_MATCH.label))).toBeNull();
  });

  it("opens the next place with an empty search, so a saved address never reads as its own", async () => {
    stubGeocode();
    renderManager(
      places(),
      vi.fn<SaveMock>(async () => {})
    );
    await findAndSelect(0, "Harbor Mart");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    fireEvent.click(
      within(section("Locations").getAllByRole("article")[1] as HTMLElement).getByRole("button", { name: "Edit" })
    );
    expect((screen.getByPlaceholderText(/^Type a place/) as HTMLInputElement).value).toBe("");
    expect((screen.getByPlaceholderText("latitude") as HTMLInputElement).value).toBe("-36.5");
    expect((screen.getByPlaceholderText("longitude") as HTMLInputElement).value).toBe("146.4");
  });

  it("drops an abandoned search whether the editor was cancelled or simply switched", async () => {
    stubGeocode();
    renderManager(
      places(),
      vi.fn<SaveMock>(async () => {})
    );
    // Straight from one place's editor to another's, with nothing saved in between.
    await findAndSelect(0, "Harbor Mart");
    fireEvent.click(
      within(section("Locations").getAllByRole("article")[1] as HTMLElement).getByRole("button", { name: "Edit" })
    );
    expect((screen.getByPlaceholderText(/^Type a place/) as HTMLInputElement).value).toBe("");
    expect((screen.getByPlaceholderText("latitude") as HTMLInputElement).value).toBe("-36.5");

    await findAndSelect(0, "Harbor Mart");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      within(section("Locations").getAllByRole("article")[1] as HTMLElement).getByRole("button", { name: "Edit" })
    );
    expect((screen.getByPlaceholderText(/^Type a place/) as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: HARBOR_MART_MATCH.label })).toBeNull();
  });

  it("only offers a filter once a list is long enough to need one, and matches ids as well as names", () => {
    renderManager(Array.from({ length: 5 }, (_, index) => definition({ id: `cap-${index}`, name: `Thing ${index}` })));
    const capabilities = section("Capabilities");
    fireEvent.change(capabilities.getByRole("textbox"), { target: { value: "cap-3" } });
    expect(capabilities.getAllByRole("article")).toHaveLength(1);
    fireEvent.change(capabilities.getByRole("textbox"), { target: { value: "nothing" } });
    expect(capabilities.getByText("Nothing matches “nothing”.")).toBeTruthy();
  });

  it("names the recurring series or one-off a live condition tracks, in its own section", () => {
    renderManager(
      [
        definition({ id: "ctx-college", name: "Class time", kind: "live", recurrenceRuleId: "rule-1" }),
        definition({ id: "ctx-dentist", name: "Appointment time", kind: "live", commitmentId: "commitment-1" })
      ],
      vi.fn<SaveMock>(),
      {},
      {
        commitmentRecurrenceRules: [
          {
            id: "rule-1",
            title: "College class",
            timezone: "Australia/Sydney",
            startDate: "2026-01-01",
            intervalDays: 7,
            localStartTime: "14:00",
            localEndTime: "15:00",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 0,
            status: "active"
          }
        ] as unknown as PortalState["commitmentRecurrenceRules"],
        commitments: [
          {
            id: "commitment-1",
            title: "Dentist",
            startsAt: "2026-01-02T00:00:00.000Z",
            endsAt: "2026-01-02T00:30:00.000Z",
            status: "confirmed",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 0
          }
        ] as unknown as PortalState["commitments"]
      }
    );
    const commitments = section("Live (while a commitment runs)");
    expect(commitments.getByText(/College class · 0 actions/)).toBeTruthy();
    expect(commitments.getByText(/Dentist · 0 actions/)).toBeTruthy();
  });

  it("lets a live condition be created by picking a recurring series or a one-off commitment", async () => {
    const onSave = renderManager(
      [],
      vi.fn<SaveMock>(async () => {}),
      {},
      {
        commitmentRecurrenceRules: [
          {
            id: "rule-1",
            title: "College class",
            timezone: "Australia/Sydney",
            startDate: "2026-01-01",
            intervalDays: 7,
            localStartTime: "14:00",
            localEndTime: "15:00",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 0,
            status: "active"
          }
        ] as unknown as PortalState["commitmentRecurrenceRules"]
      }
    );
    fireEvent.click(section("Live (while a commitment runs)").getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "College class" } });
    fireEvent.change(screen.getByLabelText(/^Tracks/), { target: { value: "rule" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(onSave).toHaveBeenCalledTimes(1);
    const [entity] = onSave.mock.calls[0]!;
    expect(entity.kind).toBe("live");
    expect(entity.recurrenceRuleId).toBe("rule-1");
    expect(entity.commitmentId).toBeUndefined();
  });
});
