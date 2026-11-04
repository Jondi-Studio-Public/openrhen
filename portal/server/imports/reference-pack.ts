import ExcelJS from "exceljs";
import type { PortalState } from "@/state/portal-state";
import {
  IMPORT_SHEET_NAMES,
  importColumnFormat,
  importCsvEntities,
  importSpecForType,
  importSpecHeaders,
  importSpecs,
  importTemplateHeaders,
  type ImportTabSpec
} from "@/features/imports/import-spec";
import { addColumnDropdowns } from "@/features/imports/import-xlsx";
import type { ReferenceKeyCandidate, ReferenceKeyMap } from "./reference-keys";

export { fallbackReferenceKey } from "./reference-keys";
export type { ReferenceKeyCandidate, ReferenceKeyMap } from "./reference-keys";

import type {
  ReferencePackMode,
  ReferencePackScope,
  ReferencePackScopes,
  ReferencePackScopeType
} from "@/features/imports/reference-pack-types";
export type {
  ReferencePackMode,
  ReferencePackScope,
  ReferencePackScopes,
  ReferencePackScopeType
} from "@/features/imports/reference-pack-types";

const SCOPE_TYPES = new Set<ReferencePackScopeType>([
  "all",
  "plan",
  "area",
  "outcome",
  "project",
  "deliverable",
  "action",
  "fixed_commitments",
  "fixed_commitment"
]);
const ID_SCOPE_TYPES = new Set<ReferencePackScopeType>([
  "area",
  "outcome",
  "project",
  "deliverable",
  "action",
  "fixed_commitment"
]);

export interface ReferenceSelection {
  scopeLabel: string;
  slug: string;
  areas: PortalState["areas"];
  outcomes: PortalState["outcomes"];
  projects: PortalState["projects"];
  deliverables: PortalState["deliverables"];
  actions: PortalState["actions"];
  commitments: PortalState["commitments"];
  routineSteps: PortalState["routineSteps"];
  settings: PortalState["settings"];
  currentEnergy: PortalState["currentEnergy"];
  conditionDefinitions: PortalState["conditionDefinitions"];
}

/** Both packs say the same thing about where a commitment happens, so both read from one line. */
const COMMITMENT_PLACE_INSTRUCTION =
  "location_key on Fixed Commitments and Recurring Commitments names a place from the Conditions sheet — a location condition, by its import_key — so the planner can work out the journey to it. The free-text location column stays for display and is unaffected.";

const REFERENCE_SHEETS: Record<string, string> = {
  areas: "Reference Areas",
  outcomes: "Reference Outcomes",
  projects: "Reference Projects",
  deliverables: "Reference Deliverables",
  deliverable_dependencies: "Reference Deliverable Dependencies",
  actions: "Reference Actions",
  dependencies: "Reference Dependencies",
  entity_prerequisites: "Reference Entity Prerequisites",
  fixed_commitments: "Reference Fixed Commitments",
  fixed_commitment_recurrences: "Reference Recurring Commitments",
  conditions: "Reference Conditions"
};

export function parseReferencePackMode(searchParams: URLSearchParams): ReferencePackMode {
  return searchParams.get("mode") === "roundtrip" ? "roundtrip" : "add";
}

/** Both files of a pack are named from here, so the workbook can point at the guide beside it. */
function packSlug(slug: string, mode: ReferencePackMode) {
  return `openrhen-${mode === "roundtrip" ? "roundtrip" : "reference"}-${slug}`;
}

export function referencePackWorkbookFilename(slug: string, mode: ReferencePackMode = "add") {
  return `${packSlug(slug, mode)}.xlsx`;
}

export function referencePackGuideFilename(slug: string, mode: ReferencePackMode = "add") {
  return `${packSlug(slug, mode)}-tool-guide.md`;
}

export function referencePackArchiveFilename(slug: string, mode: ReferencePackMode = "add") {
  return `${packSlug(slug, mode)}.zip`;
}

export function parseReferencePackScopes(searchParams: URLSearchParams): ReferencePackScopes {
  const repeated = searchParams.getAll("scope").map((value) => {
    const separator = value.indexOf(":");
    const type = (separator < 0 ? value : value.slice(0, separator)) as ReferencePackScopeType;
    const id = separator < 0 ? "" : value.slice(separator + 1).trim();
    return validateScope(type, id);
  });
  if (repeated.length) return normalizeScopes(repeated);

  // Legacy links selected one scope and used `all` to include every reference group.
  const legacyType = (searchParams.get("scopeType") ?? "all") as ReferencePackScopeType;
  const legacyId = searchParams.get("scopeId")?.trim() ?? "";
  return [validateScope(legacyType, legacyId)];
}

export function selectReferencePack(state: PortalState, scopes: ReferencePackScopes): ReferenceSelection {
  const normalizedScopes = removeCoveredScopes(state, normalizeScopes(scopes));
  if (!normalizedScopes.length) throw new Error("Choose at least one reference-pack scope.");
  const areaIds = new Set<string>();
  const outcomeIds = new Set<string>();
  const projectIds = new Set<string>();
  const deliverableIds = new Set<string>();
  const actionIds = new Set<string>();
  const labels: string[] = [];
  let includeAllCommitments = false;
  const commitmentIds = new Set<string>();

  for (const scope of normalizedScopes) {
    if (scope.type === "all" || scope.type === "plan") {
      labels.push(scope.type === "all" ? "Entire reference set" : "Entire plan");
      state.areas.forEach((item) => areaIds.add(item.id));
      state.outcomes.forEach((item) => outcomeIds.add(item.id));
      state.projects.forEach((item) => projectIds.add(item.id));
      state.deliverables.forEach((item) => deliverableIds.add(item.id));
      state.actions.forEach((item) => actionIds.add(item.id));
      if (scope.type === "all") {
        includeAllCommitments = true;
      }
    } else if (scope.type === "area") {
      const area = required(
        state.areas.find((item) => item.id === scope.id),
        "area"
      );
      labels.push(`Area: ${area.name}`);
      areaIds.add(area.id);
      state.outcomes.filter((item) => item.areaId === area.id).forEach((item) => outcomeIds.add(item.id));
      state.projects.filter((item) => outcomeIds.has(item.outcomeId)).forEach((item) => projectIds.add(item.id));
      state.deliverables
        .filter((item) => projectIds.has(item.projectId))
        .forEach((item) => deliverableIds.add(item.id));
      state.actions.filter((item) => projectIds.has(item.projectId)).forEach((item) => actionIds.add(item.id));
    } else if (scope.type === "outcome") {
      const outcome = required(
        state.outcomes.find((item) => item.id === scope.id),
        "outcome"
      );
      labels.push(`Outcome: ${outcome.title}`);
      outcomeIds.add(outcome.id);
      areaIds.add(outcome.areaId);
      state.projects.filter((item) => item.outcomeId === outcome.id).forEach((item) => projectIds.add(item.id));
      state.deliverables
        .filter((item) => projectIds.has(item.projectId))
        .forEach((item) => deliverableIds.add(item.id));
      state.actions.filter((item) => projectIds.has(item.projectId)).forEach((item) => actionIds.add(item.id));
    } else if (scope.type === "project") {
      const project = required(
        state.projects.find((item) => item.id === scope.id),
        "project"
      );
      labels.push(`Project: ${project.title}`);
      projectIds.add(project.id);
      state.deliverables.filter((item) => item.projectId === project.id).forEach((item) => deliverableIds.add(item.id));
      state.actions.filter((item) => item.projectId === project.id).forEach((item) => actionIds.add(item.id));
    } else if (scope.type === "deliverable") {
      const deliverable = required(
        state.deliverables.find((item) => item.id === scope.id),
        "deliverable"
      );
      labels.push(`Deliverable: ${deliverable.title}`);
      deliverableIds.add(deliverable.id);
    } else if (scope.type === "action") {
      const action = required(
        state.actions.find((item) => item.id === scope.id),
        "action"
      );
      labels.push(`Action: ${action.title}`);
      actionIds.add(action.id);
    } else if (scope.type === "fixed_commitments") {
      labels.push("All fixed commitments");
      includeAllCommitments = true;
    } else if (scope.type === "fixed_commitment") {
      const commitment = required(
        state.commitments.find((item) => item.id === scope.id),
        "fixed commitment"
      );
      labels.push(`Fixed commitment: ${commitment.title}`);
      commitmentIds.add(commitment.id);
    }
  }

  // Include prerequisite actions and their ancestors so relationship keys never point at missing reference rows.
  let changed = true;
  while (changed) {
    changed = false;
    for (const action of state.actions.filter((item) => actionIds.has(item.id))) {
      for (const dependencyId of action.dependencyIds ?? [])
        if (!actionIds.has(dependencyId) && state.actions.some((item) => item.id === dependencyId)) {
          actionIds.add(dependencyId);
          changed = true;
        }
    }
    for (const deliverable of state.deliverables.filter((item) => deliverableIds.has(item.id))) {
      for (const dependencyId of deliverable.dependencyIds ?? [])
        if (!deliverableIds.has(dependencyId) && state.deliverables.some((item) => item.id === dependencyId)) {
          deliverableIds.add(dependencyId);
          changed = true;
        }
    }
  }
  for (const action of state.actions.filter((item) => actionIds.has(item.id))) projectIds.add(action.projectId);
  for (const deliverable of state.deliverables.filter((item) => deliverableIds.has(item.id)))
    projectIds.add(deliverable.projectId);
  for (const project of state.projects.filter((item) => projectIds.has(item.id))) outcomeIds.add(project.outcomeId);
  for (const outcome of state.outcomes.filter((item) => outcomeIds.has(item.id))) areaIds.add(outcome.areaId);

  const commitments = state.commitments.filter((item) => includeAllCommitments || commitmentIds.has(item.id));
  const includedCommitmentIds = new Set(commitments.map((item) => item.id));
  const scopeLabel = normalizedScopes.length === 1 ? labels[0]! : `${normalizedScopes.length} selected scopes`;
  return {
    scopeLabel,
    slug: slugify(scopeLabel),
    areas: state.areas.filter((item) => areaIds.has(item.id)),
    outcomes: state.outcomes.filter((item) => outcomeIds.has(item.id)),
    projects: state.projects.filter((item) => projectIds.has(item.id)),
    deliverables: state.deliverables.filter((item) => deliverableIds.has(item.id)),
    actions: state.actions.filter((item) => actionIds.has(item.id)),
    commitments,
    // A sleep-anchored step carries no `commitmentId` at all, so it is never in scope here —
    // this pack is scoped by commitment/project/area, which a bedtime/wake routine has no part of.
    routineSteps: state.routineSteps.filter(
      (item) => item.commitmentId && includedCommitmentIds.has(item.commitmentId)
    ),
    settings: state.settings,
    currentEnergy: state.currentEnergy,
    // The context catalogue is global, not scoped to areas/outcomes/projects, so every pack carries
    // it whole — the same way settings does.
    conditionDefinitions: state.conditionDefinitions
  };
}

function validateScope(type: ReferencePackScopeType, id: string): ReferencePackScope {
  if (!SCOPE_TYPES.has(type)) throw new Error("Unsupported reference-pack scope.");
  if (ID_SCOPE_TYPES.has(type) && !id) throw new Error("Choose a record for this reference-pack scope.");
  if (!ID_SCOPE_TYPES.has(type) && id) throw new Error("This reference-pack scope does not accept a record ID.");
  return { type, ...(id ? { id } : {}) };
}

function normalizeScopes(scopes: ReferencePackScopes): ReferencePackScopes {
  const unique = new Map<string, ReferencePackScope>();
  for (const scope of scopes) {
    const validated = validateScope(scope.type, scope.id?.trim() ?? "");
    unique.set(`${validated.type}:${validated.id ?? ""}`, validated);
  }
  return [...unique.values()];
}

function removeCoveredScopes(state: PortalState, scopes: ReferencePackScopes): ReferencePackScopes {
  return scopes.filter(
    (scope, index) =>
      !scopes.some((candidate, candidateIndex) => candidateIndex !== index && scopeCovers(state, candidate, scope))
  );
}

function scopeCovers(state: PortalState, parent: ReferencePackScope, child: ReferencePackScope): boolean {
  if (parent.type === "all") return true;
  if (parent.type === "plan" && ["area", "outcome", "project", "deliverable", "action"].includes(child.type))
    return true;
  if (parent.type === "fixed_commitments" && child.type === "fixed_commitment") return true;
  const action = child.type === "action" ? state.actions.find((item) => item.id === child.id) : undefined;
  const deliverable =
    child.type === "deliverable" ? state.deliverables.find((item) => item.id === child.id) : undefined;
  const project =
    child.type === "project"
      ? state.projects.find((item) => item.id === child.id)
      : action
        ? state.projects.find((item) => item.id === action.projectId)
        : deliverable
          ? state.projects.find((item) => item.id === deliverable.projectId)
          : undefined;
  const outcome =
    child.type === "outcome"
      ? state.outcomes.find((item) => item.id === child.id)
      : project
        ? state.outcomes.find((item) => item.id === project.outcomeId)
        : undefined;
  if (parent.type === "area") return child.type !== "area" && outcome?.areaId === parent.id;
  if (parent.type === "outcome")
    return ["project", "deliverable", "action"].includes(child.type) && outcome?.id === parent.id;
  if (parent.type === "project") return ["deliverable", "action"].includes(child.type) && project?.id === parent.id;
  return false;
}

export function referenceKeyCandidates(selection: ReferenceSelection): ReferenceKeyCandidate[] {
  return [
    ...selection.areas.map((item) => ({ entityType: "area" as const, entityId: item.id, label: item.name })),
    ...selection.outcomes.map((item) => ({ entityType: "outcome" as const, entityId: item.id, label: item.title })),
    ...selection.projects.map((item) => ({ entityType: "project" as const, entityId: item.id, label: item.title })),
    ...selection.deliverables.map((item) => ({
      entityType: "deliverable" as const,
      entityId: item.id,
      label: item.title
    })),
    ...selection.actions.map((item) => ({ entityType: "action" as const, entityId: item.id, label: item.title })),
    ...selection.commitments.map((item) => ({
      entityType: "fixed_commitment" as const,
      entityId: item.id,
      label: item.title
    }))
  ];
}

export async function createReferencePackWorkbook(
  selection: ReferenceSelection,
  keys: ReferenceKeyMap,
  mode: ReferencePackMode = "add"
): Promise<Uint8Array> {
  const guideFilename = referencePackGuideFilename(selection.slug, mode);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "OpenRhen";
  workbook.created = new Date();
  const instructions = workbook.addWorksheet("Instructions", { views: [{ state: "frozen", ySplit: 1 }] });
  instructions.columns = [{ width: 28 }, { width: 100 }];
  instructions.addRows(
    mode === "roundtrip"
      ? [
          ["OpenRhen editing pack", selection.scopeLabel],
          [
            "Purpose",
            "Correct the typed context catalogue and every action's requirements by hand. Every addition sheet is pre-filled with current records, so the whole workbook previews as update."
          ],
          [
            "Reference sheets",
            "Sheets beginning with Reference are snapshots only. OpenRhen ignores them during import."
          ],
          [
            "Addition sheets",
            `${additionSheetList()} are importable. They start pre-filled with current data, keyed by import_key.`
          ],
          [
            "Deliverable shells",
            "Deliverable rows contain shell metadata only. They never create or replace BCR criteria, steps, evidence, reviews, or sessions. Existing started deliverables keep their lifecycle state when shell metadata is updated."
          ],
          [
            "Round-trip rule",
            "This is an add-and-update pack, not add-only. Every row should preview as update. An unexpected create means a key mismatch — do not add new import_key values here unless you intend to create a new record."
          ],
          [
            "Conditions sheet",
            "Auto-classified from the flat contexts list as a starting guess: locations, capabilities, and contacts split as best as the words allow. This is a guess to correct, not an answer to accept — check every row, especially any flagged cell."
          ],
          [
            "Actions: requirements",
            "requirements replaces contexts as what gates eligibility. Syntax: AND within a route with +, OR across routes with |. Example: desktop+online | campus means either the desktop while online, or being on campus. Auto-filled from each action's current contexts as a single required route; add alternatives or split it apart."
          ],
          [
            "Actions: prefers",
            "prefers is a plain | list of contexts that are nice to have but never block eligibility, for example home|quiet. Starts empty — there is no legacy equivalent to draw from."
          ],
          [
            "Actions: contexts",
            "The old flat contexts column is kept alongside requirements for reference and is preserved as-is unless you edit it directly. Prefer editing requirements and prefers instead."
          ],
          [
            "Intentional updates",
            "Updates are not patches. A blank cell on an update clears the stored value (a list becomes empty). A column you delete from the sheet is left out of the update entirely, so the stored value stands — delete columns you do not mean to touch, and leave a pre-filled cell alone to keep its current value."
          ],
          ["Omitted records", "Existing records absent from an import are not deleted or changed."],
          [
            "Relationships",
            "Columns ending in _key must use exact import_key values from the reference sheets or from another row in this workbook."
          ],
          [
            "Companion guide",
            `Read ${guideFilename} before editing. It contains every field, allowed value, validation rule, and operating instruction.`
          ],
          [
            "Routine steps",
            "Reference Routine Steps is context only. Routine-step import is not supported yet; add those steps in Today after committing a fixed commitment."
          ],
          ["Commitment places", COMMITMENT_PLACE_INSTRUCTION],
          ["Generated", new Date().toISOString()]
        ]
      : [
          ["OpenRhen add-only pack", selection.scopeLabel],
          [
            "Purpose",
            "Give a person or external tool authoritative context, then place only new records in the normal import sheets."
          ],
          [
            "Reference sheets",
            "Sheets beginning with Reference are snapshots only. OpenRhen ignores them during import."
          ],
          [
            "Addition sheets",
            `${additionSheetList()} are the importable sheets. They intentionally contain headers but no existing rows.`
          ],
          [
            "Deliverable shells",
            "Use Deliverables for enduring work that must enter Breakdown, Carry out, Review when the engine schedules it. Import creates only the shell and planning metadata, never BCR criteria or steps. A project may contain actions, deliverables, or both."
          ],
          [
            "Safe add-only rule",
            "Create a new unique import_key for every new record. Before commit, every intended addition must preview as create. Stop if an unexpected update appears."
          ],
          [
            "Intentional updates",
            "Reusing an entity type and import_key updates the record. A blank cell clears the stored value; a column absent from the sheet leaves it unchanged. Updates are not partial patches within the columns you supply."
          ],
          ["Omitted records", "Existing records absent from an import are not deleted or changed."],
          [
            "Relationships",
            "Columns ending in _key must use exact import_key values from the reference sheets or from another new row in this workbook."
          ],
          [
            "Companion guide",
            `Read ${guideFilename} before generating additions. It contains every field, allowed value, validation rule, and operating instruction.`
          ],
          [
            "Routine steps",
            "Reference Routine Steps is context only. Routine-step import is not supported yet; add those steps in Today after committing a fixed commitment."
          ],
          ["Commitment places", COMMITMENT_PLACE_INSTRUCTION],
          ["Generated", new Date().toISOString()]
        ]
  );
  styleHeader(instructions.getRow(1), "reference");
  instructions.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  addReferenceSheet(workbook, "Reference Settings", ["setting", "value"], settingsRows(selection));
  const rows = entityRows(selection, keys);
  const importRows = mode === "roundtrip" ? entityRows(selection, keys, true) : {};
  for (const entity of importCsvEntities)
    addReferenceSheet(workbook, REFERENCE_SHEETS[entity]!, importTemplateHeaders(entity), rows[entity] ?? []);
  addReferenceSheet(
    workbook,
    "Reference Routine Steps",
    [
      "commitment_key",
      "title",
      "duration_minutes",
      "sequence",
      "timing_rule",
      "max_lead_minutes",
      "wait_after_minutes",
      "must_start_by_minutes",
      "preferred_bands",
      "energy",
      "phase",
      "contexts",
      "status",
      "scheduled_start_at",
      "scheduled_end_at"
    ],
    routineRows(selection, keys)
  );

  for (const entity of importCsvEntities) addAdditionSheet(workbook, entity, importRows[entity] ?? []);
  if (mode === "roundtrip")
    flagAmbiguousPortability(workbook.getWorksheet(IMPORT_SHEET_NAMES.conditions), flaggedConditionKeys());
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

/** Marks the portability cell of an auto-classified, ambiguous row so it gets a deliberate look. */
function flagAmbiguousPortability(sheet: ExcelJS.Worksheet | undefined, flagged: Set<string>) {
  if (!sheet || !flagged.size) return;
  const headers = importTemplateHeaders("conditions");
  const keyColumn = headers.indexOf("import_key") + 1;
  const portabilityColumn = headers.indexOf("portability") + 1;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const key = String(row.getCell(keyColumn).value ?? "");
    if (!flagged.has(key)) return;
    row.getCell(portabilityColumn).note =
      "Auto-guessed as fixed. A phone hotspot or similar could make this portable instead — verify before trusting it.";
  });
}

/**
 * The briefing that travels with a pack. Both packs share the field reference and the formats; what
 * differs is the instruction — an add-only pack must never touch a key that already exists, an
 * editing pack reuses every one of them on purpose — so the two are written out rather than hedged
 * into a single wording that contradicts whichever pack it arrived with.
 */
export function createReferencePackGuide(scopeLabel = "Selected scope", mode: ReferencePackMode = "add") {
  const editing = mode === "roundtrip";
  const sheets = additionSheetList((name) => `\`${name}\``);
  const assignment = editing
    ? `You are correcting records that already exist in a OpenRhen planning hierarchy. The selected scope is **${scopeLabel}**. Read the \`Instructions\` sheet and every sheet beginning with \`Reference\` before editing. Those sheets are authoritative context: never rename them, edit them, or copy them into the normal sheets. OpenRhen ignores them on import.`
    : `You are extending an existing OpenRhen planning hierarchy. The selected scope is **${scopeLabel}**. Read the \`Instructions\` sheet and every sheet beginning with \`Reference\` before proposing additions. Those sheets are authoritative context and must never be renamed, edited, copied into the normal sheets, or returned as updates unless the user explicitly requests an update.`;
  const sheetInstruction = editing
    ? `The normal sheets — ${sheets} — arrive pre-filled with every current record in scope. Edit those rows in place. Never delete a row to remove a record: an omitted row is left unchanged, not deleted.`
    : `Write only new records into the normal sheets: ${sheets}. Leave unused normal sheets with their header row only.`;
  const rules = [
    "Every new row requires a unique, stable, human-readable `import_key` of at most 120 characters.",
    "A new key creates a record. Reusing the same entity type and key requests a complete-record update.",
    editing
      ? "This is an editing pack, not an add-only pack: every pre-filled row reuses its own key deliberately, so the whole workbook is expected to preview as an update. Do not introduce a new `import_key` unless the user asked you to create that record."
      : "This is an add-only pack: do not reuse existing keys unless the user explicitly asks to modify that exact record.",
    "Rows omitted from an import remain unchanged; omission never deletes an existing record.",
    "Updates are not patches. A blank cell on an update clears the stored value (a list becomes empty); a column that is not in the sheet at all leaves the stored value unchanged. Required fields may be omitted as whole columns on an update, never left blank.",
    ...(editing
      ? [
          "Delete whole columns you were not asked to change before returning the workbook. Leaving a pre-filled cell alone also keeps its value; it is emptying one that clears it."
        ]
      : []),
    "Columns ending in `_key` reference import keys, never database IDs or titles.",
    editing
      ? "References may point to a key in a Reference sheet or to another row in the normal sheets."
      : "References may point to a key in a Reference sheet or to a new key in another normal sheet.",
    "Do not invent missing dates, estimates, scores, statuses, contexts, relationships, or completion claims. Leave optional unknowns blank. Ask the user for required unknowns.",
    "Keep header names and normal sheet names exact. Do not add explanatory rows above headers.",
    editing
      ? "The user must preview the result. Every row you edited should show **update**. An unexpected **create** means a key was altered or retyped and must be corrected before commit."
      : "The user must preview the result. Intended additions should all show **create**. An unexpected **update** means a key collision and must be corrected before commit.",
    "Confirmation is atomic: if any active row is invalid, stale, cyclic, or unresolved, none of the batch is committed. The user may instead commit only the ready rows; the blocked rows are then moved, in the same step, into a new draft batch to fix later.",
    "One import carries at most 2,000 rows across all sheets and 5 MB of file. Split a larger body of work into several workbooks rather than returning one that cannot be uploaded."
  ];
  const checklist = editing
    ? [
        "Preserve every Reference sheet unchanged.",
        "Keep every pre-filled `import_key` exactly as it arrived.",
        "Edit values in place; append a row only to create a genuinely new record.",
        "Delete the columns you were not asked to change.",
        "Leave rows you were not asked to change untouched.",
        "Leave uncertainty blank only where optional; never fabricate required values.",
        "Return the completed XLSX without prose inserted into data sheets."
      ]
    : [
        "Preserve every Reference sheet unchanged.",
        "Populate only required normal sheets.",
        "Use new keys for additions.",
        "Reuse exact parent keys from reference rows.",
        "Include project rows before actions that reference them.",
        "Include project rows before deliverables that reference them.",
        "Include deliverable dependency rows only after both deliverables exist in reference or additions.",
        "Include dependency rows only after both actions exist in reference or additions.",
        "Include entity prerequisite rows only after both ends exist in reference or additions; same-kind action or deliverable edges go on their dependency sheets.",
        "Leave uncertainty blank only where optional; never fabricate required values.",
        "Return the completed XLSX without prose inserted into data sheets."
      ];
  const inferred = editing
    ? `
## What is filled in from a guess, not from stored data

Most pre-filled cells are the record as OpenRhen holds it today. These are not, and each needs a
deliberate look rather than being returned as it arrived:

- **Conditions \`kind\` and \`portability\`** are auto-classified from a flat legacy list of condition names.
  Location, capability and contact were split by word alone, and anything unrecognised was called a
  fixed capability. Check every row; a cell carrying a spreadsheet note was flagged as genuinely
  ambiguous.
- **Actions \`requirements\`** was auto-filled from each action's legacy \`contexts\` as a single required
  route, so it reproduces today's matching behaviour rather than being correct. Split it into
  alternative routes wherever the work really can be done more than one way.
- **Actions \`prefers\`** starts empty on every row. No legacy field maps onto it, so anything belonging
  there has to be added deliberately.
- **Actions \`contexts\`** is the superseded flat list, kept beside \`requirements\` for reference. Edit
  \`requirements\` and \`prefers\` instead, and leave this column alone or delete it.
`
    : "";
  return `# OpenRhen ${editing ? "editing" : "add-only"} pack instructions for external tools

## Assignment

${assignment}

${sheetInstruction}

## Safety and import behaviour

${rules.map((rule, index) => `${index + 1}. ${rule}`).join("\n")}
${inferred}
## Formats

- UTF-8 text.
- ISO date: \`YYYY-MM-DD\`.
- ISO timestamp with timezone offset: \`2026-08-20T17:00:00+10:00\`. A timestamp written without an offset is read in the importing user's own timezone, so always write the offset.
- Lists use \`|\`, for example \`home|laptop\`.
- Requirement and pathway routes use \`+\` for AND within a route and \`|\` for OR across routes, for example \`desktop+online | campus\` means either the desktop while online, or being on campus. A route split by \`|\` that ends up with no contexts (an accidental double \`|\`) is invalid — every route must name at least one context.
- Booleans use \`true\` or \`false\`.
- Scores are integers from 1 to 5.

## Exact entity fields

${referenceEntityFields()}
\`*\` means required.

## Output checklist

${checklist.map((item) => `- ${item}`).join("\n")}
`;
}

/** Prose about an entity that no column carries: invariants, what a row is, what it must not do. */
const REFERENCE_NOTES: Record<string, string[]> = {
  areas: ["area names must be unique"],
  projects: ["internal deadline cannot be after external deadline"],
  deliverables: [
    "creates a deliverable shell only; never add completion criteria, BCR steps, evidence, reviews, or sessions here",
    "internal deadline cannot be after external deadline",
    "Breakdown begins only when the engine recommends the deliverable and the user opens it",
    "projects may contain actions, deliverables, or both"
  ],
  deliverable_dependencies: ["no self-dependencies or cycles"],
  actions: [
    "title: concrete next physical or cognitive action, not a vague project label",
    "effort must satisfy optimistic <= expected <= pessimistic",
    "remaining must be between 0 and pessimistic",
    "minimum session must be positive and no greater than maximum session",
    "every condition named in requirements or prefers must exist in the Conditions sheet or the existing catalogue",
    "repeat_every_days makes the row a cadence — suggested every N days when time allows and ranked by importance, never scheduled as an appointment. Leave it blank for ordinary one-off work; 0 turns an existing cadence action back into one",
    "notes are shown collapsed behind a dropdown during review"
  ],
  dependencies: ["no self-dependencies or cycles"],
  entity_prerequisites: [
    "kinds are project, deliverable or action; no self-dependencies or cycles",
    "action-to-action and deliverable-to-deliverable edges belong on Dependencies and Deliverable Dependencies; project-to-project edges belong here",
    "an omitted row leaves the stored edge as it is; nothing here removes one"
  ],
  fixed_commitments: [
    "each row is one dated occurrence; a repeating appointment belongs in Recurring Commitments",
    "setup and transition are simple buffers, not ordered preparation routines"
  ],
  fixed_commitment_recurrences: [
    "one row is one repeating rule; occurrences are generated for the planning horizon and keep being generated as it rolls forward",
    "end_date may be blank for an open-ended series, but it must not fall before start_date",
    "a class on Tuesdays and Thursdays is one row: interval_unit weeks, interval_weeks 1, weekdays `Tue, Thu`; start_date must fall on one of the listed days",
    "re-import the same import_key as a delete row to end a series without removing past occurrences"
  ],
  conditions: [
    "import_key is the condition's own id — it is what requirements, prefers, and grants reference elsewhere in the pack",
    "portability applies to capabilities only and is ignored for locations and contacts",
    "a blank status is stored as active and a blank portability as fixed",
    "a composite must not reference itself, directly or through another composite — that is a circular definition and will be rejected",
    "capabilities are instances, not classes: `desktop` means that specific machine, not any computer. There is deliberately no generic `computer` entry."
  ]
};

/**
 * The per-sheet field list of the guide, from the import spec: every header with its required mark,
 * then a line per column that has a format or allowed values, then the entity's own notes.
 */
function referenceEntityFields(): string {
  return importCsvEntities.map((entity) => referenceEntitySection(entity, importSpecs[entity]!)).join("\n");
}

function referenceEntitySection(entity: string, spec: ImportTabSpec): string {
  const mark = (header: string, required: boolean | undefined) => `\`${header}${required ? "*" : ""}\``;
  const fields = [
    mark("import_key", true),
    ...spec.relations.map((relation) => mark(relation.header, relation.required)),
    ...spec.columns.map((column) => mark(column.header, column.required))
  ].join(", ");
  const bullets = [
    ...spec.relations.map(
      (relation) =>
        `- ${relation.header}: exact ${importSpecForType(relation.targetType)?.sheetName ?? relation.targetType} import_key`
    ),
    ...spec.columns.map((column) => `- ${column.header}: ${importColumnFormat(column)}`),
    ...(REFERENCE_NOTES[entity] ?? []).map((note) => `- ${note}`)
  ];
  return [`### ${spec.sheetName}`, "", fields, "", ...bullets, ""].join("\n");
}

/** The inverse of parsePathwayGroups: [["desktop","online"],["laptop"]] -> "desktop+online | laptop". */
function formatPathwaySyntax(groups: string[][]): string {
  return groups.map((group) => group.join("+")).join(" | ");
}

/**
 * An action that already has real requirementPathways (a prior round trip already corrected it) uses
 * those. One with none yet falls back to its legacy flat contexts as a single AND-group, so the sheet
 * starts from the same matching behaviour the action has today rather than from nothing.
 */
function requirementsCell(item: PortalState["actions"][number]): string {
  if (item.requirementPathways.length)
    return formatPathwaySyntax(item.requirementPathways.map((pathway) => pathway.contextIds));
  return item.contexts.length ? item.contexts.join("+") : "";
}

/** import_key for a condition definition is its id — there is no separate uuid identity to map through. */
function conditionRows(selection: ReferenceSelection): Array<Array<string | number | boolean>> {
  return selection.conditionDefinitions.map((item) => [
    item.id,
    item.name,
    item.kind,
    item.status,
    item.portability,
    item.grants.join("|"),
    formatPathwaySyntax(item.pathways),
    item.travelMinutes ?? "",
    item.setupBeforeMinutes,
    item.transitionAfterMinutes,
    item.channels.join("|")
  ]);
}

/**
 * import_keys whose portability guess is ambiguous and needs a deliberate look, not silent trust.
 * this used to also guess rows from the flat context catalogue when no typed condition existed
 * yet; that catalogue is retired, so there is nothing left to guess from.
 */
function flaggedConditionKeys(): Set<string> {
  return new Set();
}

function entityRows(
  selection: ReferenceSelection,
  keys: ReferenceKeyMap,
  forImport = false
): Record<string, Array<Array<string | number | boolean>>> {
  const key = (type: keyof ReferenceKeyMap, id: string) => keys[type]?.[id] ?? "";
  return {
    areas: selection.areas.map((item) => [
      key("area", item.id),
      item.name,
      item.description ?? "",
      item.status,
      item.sortOrder
    ]),
    outcomes: selection.outcomes.map((item) => [
      key("outcome", item.id),
      key("area", item.areaId),
      item.title,
      item.definitionOfDone,
      item.value,
      item.status,
      item.deadlineAt ?? "",
      item.reviewOn ?? ""
    ]),
    projects: selection.projects.map((item) => [
      key("project", item.id),
      key("outcome", item.outcomeId),
      item.title,
      item.status,
      item.uncertainty,
      item.consequence,
      item.internalDeadlineAt ?? "",
      item.externalDeadlineAt ?? "",
      item.remainingEffortOverrideMinutes ?? ""
    ]),
    deliverables: selection.deliverables.map((item) => [
      key("deliverable", item.id),
      key("project", item.projectId),
      item.title,
      item.details ?? "",
      forImport ? "needs_breakdown" : item.status,
      item.uncertainty,
      item.importance,
      item.consequence,
      item.internalDeadlineAt ?? "",
      item.externalDeadlineAt ?? ""
    ]),
    deliverable_dependencies: selection.deliverables.flatMap((item) =>
      (item.dependencyIds ?? [])
        .filter((id) => selection.deliverables.some((candidate) => candidate.id === id))
        .map((dependencyId) => {
          const deliverableKey = key("deliverable", item.id);
          const dependencyKey = key("deliverable", dependencyId);
          return [`${deliverableKey}-after-${dependencyKey}`.slice(0, 120), deliverableKey, dependencyKey];
        })
    ),
    actions: selection.actions.map((item) => [
      key("action", item.id),
      key("project", item.projectId),
      item.title,
      item.status,
      item.optimisticMinutes ?? item.expectedMinutes ?? item.remainingMinutes,
      item.expectedMinutes ?? item.remainingMinutes,
      item.pessimisticMinutes,
      item.remainingMinutes,
      item.energy,
      item.minimumSessionMinutes,
      item.maximumSessionMinutes,
      item.splittable ?? true,
      item.setupMinutes ?? 0,
      item.importance,
      item.consequence,
      // Only a cadence has an interval to show; a windowed recurring action's is not this column's.
      item.schedulingMode === "cadence" ? (item.recurrence?.intervalDays ?? "") : "",
      item.contexts.join("|"),
      requirementsCell(item),
      item.preferences.join("|"),
      item.availableFrom ?? "",
      item.deadlineAt ?? "",
      item.latestStartAt ?? "",
      item.notes ?? ""
    ]),
    dependencies: selection.actions.flatMap((item) =>
      (item.dependencyIds ?? [])
        .filter((id) => selection.actions.some((candidate) => candidate.id === id))
        .map((dependencyId) => {
          const actionKey = key("action", item.id);
          const dependencyKey = key("action", dependencyId);
          return [`${actionKey}-after-${dependencyKey}`.slice(0, 120), actionKey, dependencyKey];
        })
    ),
    // Only edges the sheets above cannot hold, and only when both ends are in this pack.
    entity_prerequisites: [
      ...selection.projects.map((item) => ["project", item.id, item.prerequisites] as const),
      ...selection.deliverables.map((item) => ["deliverable", item.id, item.prerequisites] as const),
      ...selection.actions.map((item) => ["action", item.id, item.prerequisites] as const)
    ].flatMap(([kind, id, prerequisites]) =>
      (prerequisites ?? [])
        .filter((ref) => selection[`${ref.kind}s` as const].some((candidate) => candidate.id === ref.id))
        .map((ref) => {
          const entityKey = key(kind, id);
          const requiresKey = key(ref.kind, ref.id);
          return [
            `${kind}-${entityKey}-after-${ref.kind}-${requiresKey}`.slice(0, 120),
            kind,
            entityKey,
            ref.kind,
            requiresKey
          ];
        })
    ),
    // A condition's import_key is its own id, so a commitment's saved place is written as it stands.
    fixed_commitments: selection.commitments.map((item) => [
      key("fixed_commitment", item.id),
      item.locationId ?? "",
      item.title,
      item.startsAt,
      item.endsAt,
      item.status,
      item.location ?? "",
      item.setupBeforeMinutes,
      item.transitionAfterMinutes
    ]),
    conditions: conditionRows(selection)
  };
}

function routineRows(selection: ReferenceSelection, keys: ReferenceKeyMap) {
  return selection.routineSteps.map((item) => [
    keys.fixed_commitment?.[item.commitmentId ?? ""] ?? "",
    item.title,
    item.durationMinutes,
    item.sequence,
    item.timingRule,
    item.maxLeadMinutes ?? "",
    item.waitAfterMinutes ?? "",
    item.mustStartByMinutes ?? "",
    (item.preferredBands ?? []).join("|"),
    item.energy,
    item.phase,
    item.contexts.join("|"),
    item.status,
    item.scheduledStartAt ?? "",
    item.scheduledEndAt ?? ""
  ]);
}

function settingsRows(selection: ReferenceSelection): Array<Array<string | number>> {
  const settings = selection.settings;
  return [
    ["timezone", settings.timezone],
    ["current_energy", selection.currentEnergy],
    ["preferred_bedtime", settings.preferredBedtime],
    ["preferred_wake_time", settings.preferredWakeTime],
    ["desired_sleep_minutes", settings.desiredSleepMinutes],
    ["minimum_sleep_minutes", settings.minimumSleepMinutes],
    ["maximum_awake_hours", settings.maxAwakeHours],
    ["default_usable_fraction", settings.defaultUsableFraction],
    ["submission_buffer_minutes", settings.submissionBufferMinutes],
    ["submission_buffer_percent", settings.submissionBufferPercent]
  ];
}

function addReferenceSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: Array<Array<string | number | boolean>>
) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row.map((value) => (value === "" ? null : value))));
  styleHeader(sheet.getRow(1), "reference");
  styleColumns(sheet, headers, rows);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  sheet.getRow(1).height = 24;
}

function addAdditionSheet(
  workbook: ExcelJS.Workbook,
  entity: string,
  rows: Array<Array<string | number | boolean>> = []
) {
  const spec = importSpecs[entity]!;
  const headers = importSpecHeaders(spec);
  const sheet = workbook.addWorksheet(spec.sheetName, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row.map((value) => (value === "" ? null : value))));
  styleHeader(sheet.getRow(1), "addition");
  styleColumns(sheet, headers, rows);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  addColumnDropdowns(sheet, spec);
}

/** "Areas, Outcomes, ..., and Conditions" — every importable sheet, in template order. */
function additionSheetList(format: (name: string) => string = (name) => name) {
  const names = importCsvEntities.map((entity) => format(IMPORT_SHEET_NAMES[entity]!));
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function styleHeader(row: ExcelJS.Row, kind: "reference" | "addition") {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: kind === "reference" ? "FF315F4E" : "FF9A6A24" } };
  row.alignment = { vertical: "middle", wrapText: true };
}

function styleColumns(sheet: ExcelJS.Worksheet, headers: string[], rows: Array<Array<string | number | boolean>>) {
  headers.forEach((header, index) => {
    const longest = Math.max(header.length, ...rows.slice(0, 200).map((row) => String(row[index] ?? "").length));
    sheet.getColumn(index + 1).width =
      header === "import_key" || header.endsWith("_key")
        ? Math.min(60, Math.max(22, longest + 2))
        : Math.min(42, Math.max(14, longest + 2));
    sheet.getColumn(index + 1).alignment = { vertical: "top", wrapText: longest > 36 };
  });
}

function required<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`The selected ${label} no longer exists.`);
  return value;
}

function slugify(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "reference-pack"
  );
}
