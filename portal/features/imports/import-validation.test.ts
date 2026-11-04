import "@/test/example-calendar-sources";
import { describe, expect, it } from "vitest";
import type { ImportRecord } from "@openrhen/contracts";
import {
  STILL_CANCELLED_WARNING,
  absentField,
  explicitField,
  isAbsentColumn,
  validateImportRecords
} from "./import-validation";
import { parseImportCsv } from "./import-csv";

/**
 * How a required field is judged depends on where its emptiness came from. A blank cell is a value
 * the author chose; a column that is not in the file says nothing at all. Only the store knows
 * whether a record updates something that exists, so it tells the validator, and the browser —
 * which cannot know — keeps treating every record as a create.
 */
const actionColumns =
  "import_key,project_key,title,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,splittable,setup_minutes,importance,consequence";
const fullRow = "one,proj,One,active,20,30,45,30,medium,15,30,true,0,5,5";
const isExisting = () => true;
const isNew = () => false;

describe("column presence", () => {
  it("tells an absent column from a blank cell, and reads a field with no provenance as a cell", () => {
    expect(isAbsentColumn({ fields: { title: absentField() } }, "title")).toBe(true);
    expect(isAbsentColumn({ fields: { title: explicitField("") } }, "title")).toBe(false);
    expect(
      isAbsentColumn(
        { fields: { title: { value: null, basis: "missing", confidence: null, evidence: [], needsReview: true } } },
        "title"
      )
    ).toBe(false);
    // A field the source never emitted at all is as absent as a column it left out.
    expect(isAbsentColumn({ fields: {} }, "title")).toBe(true);
  });
});

describe("required fields", () => {
  it("still requires every required field on a create, whether the column is blank or absent", () => {
    const [record] = parseImportCsv("actions", "import_key,project_key,title,status\r\none,proj,One,");
    const errors = validateImportRecords([record!], { isExisting: isNew })[0]!.errors;
    expect(errors).toContain("status is required.");
    expect(errors).toContain("expectedMinutes is required.");
    // The browser has no store to ask and gets the same answer.
    expect(validateImportRecords([record!])[0]!.errors).toEqual(errors);
  });

  it("does not require a field whose column is absent when the record updates an existing one", () => {
    const [record] = parseImportCsv("actions", "import_key,project_key,title\r\none,proj,Renamed");
    const validated = validateImportRecords([record!], { isExisting })[0]!;
    expect(validated.errors).toEqual([]);
    expect(validated.operation).toBe("create");
  });

  it("still requires a field whose cell is blank on an update — a blank is a deliberate clear", () => {
    const [record] = parseImportCsv("actions", "import_key,project_key,title,status\r\none,proj,Renamed,");
    const errors = validateImportRecords([record!], { isExisting })[0]!.errors;
    expect(errors).toContain("status is required.");
    expect(errors).not.toContain("expectedMinutes is required.");
  });

  it("keeps requiring relationships on an update, since keys carry no column provenance", () => {
    const [record] = parseImportCsv("actions", "import_key,title\r\none,Renamed");
    expect(validateImportRecords([record!], { isExisting })[0]!.errors).toContain("projectKey is required.");
  });
});

describe("invariants over absent columns", () => {
  it("does not judge an effort or session invariant on an update when every field it reads is absent", () => {
    const [record] = parseImportCsv("actions", "import_key,project_key,title\r\none,proj,Renamed");
    const errors = validateImportRecords([record!], { isExisting })[0]!.errors;
    expect(errors).toEqual([]);
  });

  it("judges the invariant on an update as soon as one of its fields is present", () => {
    const [record] = parseImportCsv(
      "actions",
      "import_key,project_key,title,optimistic_minutes,expected_minutes,pessimistic_minutes\r\none,proj,Renamed,50,30,45"
    );
    expect(validateImportRecords([record!], { isExisting })[0]!.errors).toContain(
      "Effort must follow optimistic ≤ expected ≤ pessimistic."
    );
  });

  it("judges every invariant on a create regardless of provenance", () => {
    const [record] = parseImportCsv("actions", "import_key,project_key,title\r\none,proj,New");
    const errors = validateImportRecords([record!], { isExisting: isNew })[0]!.errors;
    expect(errors).toContain("Effort must follow optimistic ≤ expected ≤ pessimistic.");
    expect(errors).toContain("Session bounds are invalid.");
    expect(errors).toContain("splittable must be true or false.");
  });

  it("leaves a full row's validation exactly as before", () => {
    const [record] = parseImportCsv("actions", `${actionColumns}\r\n${fullRow}`);
    expect(validateImportRecords([record!], { isExisting })[0]!.errors).toEqual([]);
    expect(validateImportRecords([record!], { isExisting: isNew })[0]!.errors).toEqual([]);
  });

  it("applies the same rule to a recurring commitment's interval and buffers", () => {
    const [record] = parseImportCsv("fixed_commitment_recurrences", "import_key,title\r\ncook,Cooking");
    expect(validateImportRecords([record!], { isExisting })[0]!.errors).toEqual([]);
    const created = validateImportRecords([record!], { isExisting: isNew })[0]!.errors;
    expect(created).toContain("intervalDays must be a positive integer.");
    expect(created).toContain("setupBeforeMinutes is required.");
  });

  it("accepts a valid monthly recurrence and does not judge it by the days branch", () => {
    const [record] = parseImportCsv(
      "fixed_commitment_recurrences",
      "import_key,title,timezone,start_date,interval_unit,interval_months,month_anchor,local_start_time,local_end_time,setup_before_minutes,transition_after_minutes\r\ncook,Cooking,Australia/Sydney,2026-08-31,months,1,last_day,09:00,10:00,0,0"
    );
    expect(validateImportRecords([record!], { isExisting: isNew })[0]!.errors).toEqual([]);
  });
});

describe("weekly recurrence weekdays", () => {
  it("reads short or full names in any case into a sorted number list", () => {
    const [record] = parseImportCsv(
      "fixed_commitment_recurrences",
      'import_key,title,timezone,start_date,interval_unit,interval_weeks,weekdays,local_start_time,local_end_time,setup_before_minutes,transition_after_minutes\r\nr,R,Australia/Sydney,2026-09-29,weeks,1,"THU tuesday",09:00,10:00,0,0'
    );
    expect(record!.fields.weekdays?.value).toEqual([2, 4]);
    expect(validateImportRecords([record!], { isExisting: isNew })[0]!.errors).toEqual([]);
  });
});

describe("the note that a cancelled commitment stays cancelled", () => {
  it("survives validation of an update, which rebuilds every other warning", () => {
    const [base] = parseImportCsv(
      "fixed_commitments",
      "import_key,title,starts_at,ends_at,status\r\nk,Dentist,2026-10-10T09:00:00.000Z,2026-10-10T10:00:00.000Z,cancelled"
    );
    const withNote: ImportRecord = {
      ...base!,
      operation: "update",
      matchedEntityId: "c1",
      warnings: [STILL_CANCELLED_WARNING, "something the diff said"]
    };
    expect(validateImportRecords([withNote])[0]!.warnings).toEqual([STILL_CANCELLED_WARNING]);
  });
});

describe("removed and deleted records", () => {
  it("does not judge a removed record at all", () => {
    const [record] = parseImportCsv("actions", "import_key,project_key,title\r\none,proj,New");
    const removed: ImportRecord = { ...record!, removed: true };
    expect(validateImportRecords([removed])[0]!.errors).toEqual([]);
  });

  it("clears the warnings of a removed record too, since nothing about it will be written", () => {
    const [record] = parseImportCsv("actions", "import_key,project_key,title\r\none,proj,New");
    const removed: ImportRecord = { ...record!, removed: true, warnings: ["An inferred value needs review."] };
    expect(validateImportRecords([removed])[0]!.warnings).toEqual([]);
  });

  it("lets a delete through unjudged but keeps what was already said about it", () => {
    const [record] = parseImportCsv("actions", "import_key,project_key,title\r\none,proj,New");
    const deleted: ImportRecord = {
      ...record!,
      operation: "delete",
      errors: ["ignored"],
      warnings: ["This will remove the action."]
    };
    const validated = validateImportRecords([deleted])[0]!;
    expect(validated.errors).toEqual([]);
    expect(validated.warnings).toEqual(["This will remove the action."]);
  });

  it("keeps a Example Shared conflict's own errors and drops everything else it was carrying", () => {
    const [record] = parseImportCsv(
      "fixed_commitments",
      "import_key,title,starts_at,ends_at,status,setup_before_minutes,transition_after_minutes\r\nc,Class,2026-08-10T09:00:00+10:00,2026-08-10T11:00:00+10:00,confirmed,0,0"
    );
    const conflicted: ImportRecord = {
      ...record!,
      operation: "conflict",
      errors: ["title changed in both Example Shared and OpenRhen.", "some stale message"]
    };
    expect(validateImportRecords([conflicted])[0]!.errors).toEqual([
      "title changed in both Example Shared and OpenRhen."
    ]);
  });
});

describe("batch-wide rules", () => {
  it("refuses a row with no import key, and says so once", () => {
    const [record] = parseImportCsv("areas", "import_key,name\r\n,Study");
    expect(validateImportRecords([record!])[0]!.errors).toContain("import_key is required.");
  });

  it("refuses two kept rows of one entity sharing a key, whatever their case", () => {
    const records = parseImportCsv("areas", "import_key,name\r\nstudy,Study\r\nSTUDY,Study again");
    for (const validated of validateImportRecords(records))
      expect(validated.errors).toContain("Duplicate import key in this batch.");
  });

  it("lets the same key stand for two different entity types", () => {
    const records = [
      ...parseImportCsv("areas", "import_key,name\r\nsame,Same"),
      ...parseImportCsv("projects", "import_key,outcome_key,title\r\nsame,o,Same")
    ];
    for (const validated of validateImportRecords(records))
      expect(validated.errors).not.toContain("Duplicate import key in this batch.");
  });

  it("stops counting a duplicate once one of the pair is removed", () => {
    const records = parseImportCsv("areas", "import_key,name\r\nstudy,Study\r\nstudy,Study again");
    const kept = validateImportRecords([records[0]!, { ...records[1]!, removed: true }]);
    expect(kept[0]!.errors).not.toContain("Duplicate import key in this batch.");
  });

  it("refuses two areas with the same name, however it is spaced or cased", () => {
    const records = parseImportCsv("areas", "import_key,name\r\none, Study \r\ntwo,STUDY");
    for (const validated of validateImportRecords(records))
      expect(validated.errors).toContain("Area names must be unique.");
  });

  it("refuses a cycle among the batch's action dependencies", () => {
    const records = [
      ...parseImportCsv("dependencies", "import_key,action_key,depends_on_action_key\r\ne1,a,b"),
      ...parseImportCsv("dependencies", "import_key,action_key,depends_on_action_key\r\ne2,b,a")
    ];
    for (const validated of validateImportRecords(records))
      expect(validated.errors).toContain("Imported dependencies contain a cycle.");
  });

  it("refuses a cycle among the batch's deliverable dependencies", () => {
    const records = [
      ...parseImportCsv("deliverable_dependencies", "import_key,deliverable_key,depends_on_deliverable_key\r\ne1,a,b"),
      ...parseImportCsv("deliverable_dependencies", "import_key,deliverable_key,depends_on_deliverable_key\r\ne2,b,a")
    ];
    for (const validated of validateImportRecords(records))
      expect(validated.errors).toContain("Imported deliverable dependencies contain a cycle.");
  });

  it("accepts a chain of dependencies that does not come back on itself", () => {
    const records = [
      ...parseImportCsv("dependencies", "import_key,action_key,depends_on_action_key\r\ne1,a,b"),
      ...parseImportCsv("dependencies", "import_key,action_key,depends_on_action_key\r\ne2,b,c")
    ];
    for (const validated of validateImportRecords(records))
      expect(validated.errors).not.toContain("Imported dependencies contain a cycle.");
  });

  it("warns rather than refuses when a relationship names nothing in the batch", () => {
    const [record] = parseImportCsv("projects", "import_key,outcome_key,title\r\np,elsewhere,P");
    const validated = validateImportRecords([record!])[0]!;
    expect(validated.warnings).toContain("outcomeKey must resolve to an existing record or another row in this batch.");
    expect(validated.errors).not.toContain("outcomeKey is required.");
  });

  it("says nothing when the relationship names another row in the batch, or a key the store resolved", () => {
    const batch = [
      ...parseImportCsv("outcomes", "import_key,area_key,title\r\no,a,O"),
      ...parseImportCsv("projects", "import_key,outcome_key,title\r\np,o,P")
    ];
    expect(validateImportRecords(batch)[1]!.warnings).toEqual([]);
    const [resolved] = parseImportCsv("projects", "import_key,outcome_key,title\r\np,existing:abc,P");
    expect(validateImportRecords([resolved!])[0]!.warnings).toEqual([]);
  });

  it("refuses a field that claims to be missing while holding a value", () => {
    const [record] = parseImportCsv("areas", "import_key,name\r\nstudy,Study");
    const broken: ImportRecord = {
      ...record!,
      fields: { ...record!.fields, name: { ...record!.fields.name!, basis: "missing" } }
    };
    expect(validateImportRecords([broken])[0]!.errors).toContain("Missing fields must remain blank.");
  });

  it("warns about an inferred or defaulted value that still wants a look", () => {
    const [record] = parseImportCsv("areas", "import_key,name\r\nstudy,Study");
    const inferred: ImportRecord = {
      ...record!,
      fields: {
        ...record!.fields,
        name: { value: "Study", basis: "inferred", confidence: "low", evidence: [], needsReview: true }
      }
    };
    expect(validateImportRecords([inferred])[0]!.warnings).toContain("An inferred or default value needs review.");
  });

  it("marks an invalid record rejected and restores a fixed one to a create", () => {
    const [record] = parseImportCsv("areas", "import_key,name,status,sort_order\r\nstudy,Study,active,0");
    expect(validateImportRecords([{ ...record!, operation: "rejected" }])[0]!.operation).toBe("create");
    const [blank] = parseImportCsv("areas", "import_key,name,status,sort_order\r\nstudy,,active,0");
    expect(validateImportRecords([blank!])[0]!.operation).toBe("rejected");
  });
});

/**
 * One row per rule the validator can reach on a create: the CSV named by `entity` is judged as new,
 * and the message is expected or expected to be absent. Table-driven so that a rule added to the
 * spec without a case here shows up as an uncovered branch rather than as a passing suite.
 */
const cases: Array<{ entity: string; csv: string; error: string; expected?: boolean }> = [
  // Enum columns, one per entity that has them.
  { entity: "areas", csv: "import_key,name,status\r\na,A,pending", error: "status must be one of" },
  { entity: "areas", csv: "import_key,name,status\r\na,A,archived", error: "status must be one of", expected: false },
  { entity: "outcomes", csv: "import_key,area_key,title,status\r\no,a,O,pending", error: "status must be one of" },
  { entity: "projects", csv: "import_key,outcome_key,title,status\r\np,o,P,pending", error: "status must be one of" },
  {
    entity: "projects",
    csv: "import_key,outcome_key,title,uncertainty\r\np,o,P,maybe",
    error: "uncertainty must be one of"
  },
  {
    entity: "deliverables",
    csv: "import_key,project_key,title,status\r\nd,p,D,active",
    error: "status must be one of"
  },
  {
    entity: "deliverables",
    csv: "import_key,project_key,title,status\r\nd,p,D,needs_breakdown",
    error: "status must be one of",
    expected: false
  },
  {
    entity: "deliverables",
    csv: "import_key,project_key,title,uncertainty\r\nd,p,D,maybe",
    error: "uncertainty must be one of"
  },
  { entity: "actions", csv: "import_key,project_key,title,status\r\na,p,A,pending", error: "status must be one of" },
  { entity: "actions", csv: "import_key,project_key,title,energy\r\na,p,A,boundless", error: "energy must be one of" },
  {
    entity: "fixed_commitments",
    csv: "import_key,title,starts_at,ends_at,status\r\nf,F,2026-08-10T09:00:00Z,2026-08-10T11:00:00Z,maybe",
    error: "status must be one of"
  },
  { entity: "conditions", csv: "import_key,name,kind\r\nc,C,mood", error: "kind must be one of" },
  { entity: "conditions", csv: "import_key,name,kind,status\r\nc,C,location,retired", error: "status must be one of" },
  {
    entity: "conditions",
    csv: "import_key,name,kind,portability\r\nc,C,capability,mobile",
    error: "portability must be one of"
  },
  // Scores are integers from one to five.
  {
    entity: "outcomes",
    csv: "import_key,area_key,title,value\r\no,a,O,6",
    error: "value must be an integer from 1 to 5."
  },
  {
    entity: "outcomes",
    csv: "import_key,area_key,title,value\r\no,a,O,0",
    error: "value must be an integer from 1 to 5."
  },
  {
    entity: "outcomes",
    csv: "import_key,area_key,title,value\r\no,a,O,2.5",
    error: "value must be an integer from 1 to 5."
  },
  {
    entity: "outcomes",
    csv: "import_key,area_key,title,value\r\no,a,O,3",
    error: "value must be an integer from 1 to 5.",
    expected: false
  },
  {
    entity: "projects",
    csv: "import_key,outcome_key,title,consequence\r\np,o,P,9",
    error: "consequence must be an integer from 1 to 5."
  },
  {
    entity: "deliverables",
    csv: "import_key,project_key,title,importance\r\nd,p,D,9",
    error: "importance must be an integer from 1 to 5."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,importance\r\na,p,A,9",
    error: "importance must be an integer from 1 to 5."
  },
  // Whole-number columns and their floors.
  { entity: "areas", csv: "import_key,name,sort_order\r\na,A,-1", error: "sortOrder must be a non-negative integer." },
  { entity: "areas", csv: "import_key,name,sort_order\r\na,A,1.5", error: "sortOrder must be a non-negative integer." },
  {
    entity: "areas",
    csv: "import_key,name,sort_order\r\na,A,0",
    error: "sortOrder must be a non-negative integer.",
    expected: false
  },
  {
    entity: "projects",
    csv: "import_key,outcome_key,title,remaining_effort_override_minutes\r\np,o,P,-5",
    error: "remainingEffortOverrideMinutes must be a non-negative integer."
  },
  {
    entity: "conditions",
    csv: "import_key,name,kind,travel_minutes\r\nc,C,location,-3",
    error: "travel_minutes must be a non-negative integer."
  },
  {
    entity: "fixed_commitments",
    csv: "import_key,title,starts_at,ends_at,setup_before_minutes\r\nf,F,2026-08-10T09:00:00Z,2026-08-10T11:00:00Z,-1",
    error: "setupBeforeMinutes must be a non-negative integer."
  },
  {
    entity: "fixed_commitments",
    csv: "import_key,title,starts_at,ends_at,transition_after_minutes\r\nf,F,2026-08-10T09:00:00Z,2026-08-10T11:00:00Z,-1",
    error: "transitionAfterMinutes must be a non-negative integer."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,setup_minutes\r\na,p,A,-1",
    error: "setupMinutes must be a non-negative integer."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,repeat_every_days\r\na,p,A,-1",
    error: "repeatEveryDays must be a non-negative integer."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,repeat_every_days\r\na,p,A,1.5",
    error: "repeatEveryDays must be a non-negative integer."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,repeat_every_days\r\na,p,A,3",
    error: "repeatEveryDays must be a non-negative integer.",
    expected: false
  },
  // Zero is the one way a sheet ends a cadence, so it must not read as an invalid interval.
  {
    entity: "actions",
    csv: "import_key,project_key,title,repeat_every_days\r\na,p,A,0",
    error: "repeatEveryDays must be a non-negative integer.",
    expected: false
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,splittable\r\na,p,A,perhaps",
    error: "splittable must be true or false."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,splittable\r\na,p,A,false",
    error: "splittable must be true or false.",
    expected: false
  },
  // Deadline ordering, one pair per entity that carries two.
  {
    entity: "projects",
    csv: "import_key,outcome_key,title,internal_deadline_at,external_deadline_at\r\np,o,P,2026-09-02T00:00:00Z,2026-09-01T00:00:00Z",
    error: "Internal deadline cannot be after external deadline."
  },
  {
    entity: "projects",
    csv: "import_key,outcome_key,title,internal_deadline_at,external_deadline_at\r\np,o,P,2026-08-30T00:00:00Z,2026-09-01T00:00:00Z",
    error: "Internal deadline cannot be after external deadline.",
    expected: false
  },
  {
    entity: "deliverables",
    csv: "import_key,project_key,title,internal_deadline_at,external_deadline_at\r\nd,p,D,2026-09-02T00:00:00Z,2026-09-01T00:00:00Z",
    error: "Internal deadline cannot be after external deadline."
  },
  // Dates that are not dates, one per date-typed column family.
  {
    entity: "outcomes",
    csv: "import_key,area_key,title,deadline_at\r\no,a,O,someday",
    error: "deadlineAt must be a valid ISO date or timestamp."
  },
  {
    entity: "outcomes",
    csv: "import_key,area_key,title,review_on\r\no,a,O,whenever",
    error: "reviewOn must be a valid ISO date or timestamp."
  },
  {
    entity: "projects",
    csv: "import_key,outcome_key,title,external_deadline_at\r\np,o,P,soon",
    error: "externalDeadlineAt must be a valid ISO date or timestamp."
  },
  {
    entity: "deliverables",
    csv: "import_key,project_key,title,internal_deadline_at\r\nd,p,D,soon",
    error: "internalDeadlineAt must be a valid ISO date or timestamp."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,available_from\r\na,p,A,soon",
    error: "availableFrom must be a valid ISO date or timestamp."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,latest_start_at\r\na,p,A,soon",
    error: "latestStartAt must be a valid ISO date or timestamp."
  },
  // Effort and session invariants.
  {
    entity: "actions",
    csv: "import_key,project_key,title,optimistic_minutes,expected_minutes,pessimistic_minutes\r\na,p,A,0,30,45",
    error: "Effort must follow optimistic ≤ expected ≤ pessimistic."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,optimistic_minutes,expected_minutes,pessimistic_minutes\r\na,p,A,20,30,25",
    error: "Effort must follow optimistic ≤ expected ≤ pessimistic."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,remaining_minutes,pessimistic_minutes\r\na,p,A,60,45",
    error: "Remaining effort must be between zero and pessimistic effort."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,remaining_minutes,pessimistic_minutes\r\na,p,A,-1,45",
    error: "Remaining effort must be between zero and pessimistic effort."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,minimum_session_minutes,maximum_session_minutes\r\na,p,A,45,30",
    error: "Session bounds are invalid."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,minimum_session_minutes,maximum_session_minutes\r\na,p,A,0,30",
    error: "Session bounds are invalid."
  },
  // Pathway syntax, on an action's requirements and on a condition's own composition.
  {
    entity: "actions",
    csv: "import_key,project_key,title,requirements\r\na,p,A,desktop||college",
    error: "requirements has an empty pathway — remove the extra | or add conditions to it."
  },
  {
    entity: "actions",
    csv: "import_key,project_key,title,requirements\r\na,p,A,desktop+online|college",
    error: "requirements has an empty pathway — remove the extra | or add conditions to it.",
    expected: false
  },
  {
    entity: "conditions",
    csv: "import_key,name,kind,pathways\r\nc,C,capability,desktop||laptop",
    error: "pathways has an empty group — remove the extra | or add conditions to it."
  },
  // Commitments in time.
  {
    entity: "fixed_commitments",
    csv: "import_key,title,starts_at,ends_at\r\nf,F,2026-08-10T11:00:00Z,2026-08-10T09:00:00Z",
    error: "End time must be after start time."
  },
  // Recurrence rules.
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,start_date,end_date\r\nr,R,2026-08-14,2026-08-01",
    error: "endDate cannot be before startDate."
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,start_date,end_date\r\nr,R,2026-08-14,2026-08-28",
    error: "endDate cannot be before startDate.",
    expected: false
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,interval_days\r\nr,R,0",
    error: "intervalDays must be a positive integer."
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,local_start_time\r\nr,R,2pm",
    error: "localStartTime must be in HH:MM format."
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,local_end_time\r\nr,R,25",
    error: "localEndTime must be in HH:MM format."
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,local_start_time,local_end_time\r\nr,R,15:00,14:00",
    error: "localEndTime must be after localStartTime."
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,local_start_time,local_end_time\r\nr,R,14:00,14:00",
    error: "localEndTime must be after localStartTime."
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,local_start_time,local_end_time\r\nr,R,14:00,15:00",
    error: "localEndTime must be after localStartTime.",
    expected: false
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,start_date\r\nr,R,the fourteenth",
    error: "startDate must be a valid ISO date or timestamp."
  },
  // Monthly recurrence: unit and anchor.
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,start_date,interval_unit,interval_months\r\nr,R,2026-08-31,months,1",
    error: "monthAnchor is required."
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,start_date,interval_unit,interval_months,month_anchor\r\nr,R,2026-08-15,months,1,last_day",
    error: "monthAnchor does not match startDate."
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,start_date,interval_unit,interval_months,month_anchor\r\nr,R,2026-08-31,months,1,last_day",
    error: "monthAnchor does not match startDate.",
    expected: false
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,interval_unit\r\nr,R,fortnightly",
    error: "intervalUnit must be one of"
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,interval_unit,month_anchor\r\nr,R,months,whenever",
    error: "monthAnchor must be one of"
  },
  // Weekday-set recurrence.
  {
    entity: "fixed_commitment_recurrences",
    csv: 'import_key,title,start_date,interval_unit,interval_weeks,weekdays\r\nr,R,2026-09-29,weeks,1,"Tue, Thu"',
    error: "weekdays do not include",
    expected: false
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: 'import_key,title,start_date,interval_unit,interval_weeks,weekdays\r\nr,R,2026-09-30,weeks,1,"Tue, Thu"',
    error: "weekdays do not include startDate's weekday."
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,start_date,interval_unit,interval_weeks,weekdays\r\nr,R,2026-09-29,weeks,0,Tuesday",
    error: "intervalWeeks must be a positive integer."
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,start_date,interval_unit,interval_weeks\r\nr,R,2026-09-29,weeks,1",
    error: "weekdays is required when interval_unit is weeks."
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: 'import_key,title,start_date,interval_unit,interval_weeks,weekdays\r\nr,R,2026-09-29,weeks,1,"Tue, Funday"',
    error: "weekdays must be weekday names"
  },
  {
    entity: "fixed_commitment_recurrences",
    csv: "import_key,title,start_date,interval_unit,interval_days,weekdays\r\nr,R,2026-09-30,days,7,Tue",
    error: "weekdays",
    expected: false
  }
];

describe("value rules", () => {
  for (const { entity, csv, error, expected = true } of cases) {
    const row = csv.split("\r\n")[1];
    it(`${expected ? "refuses" : "accepts"} ${entity} ${row} — ${error}`, () => {
      const [record] = parseImportCsv(entity, csv);
      const errors = validateImportRecords([record!], { isExisting: isNew })[0]!.errors;
      if (expected) expect(errors.some((item) => item.startsWith(error) || item === error)).toBe(true);
      else expect(errors.some((item) => item.startsWith(error) || item === error)).toBe(false);
    });
  }
});

describe("required fields per entity", () => {
  it("names every required column of an empty row, and nothing that is optional", () => {
    const [record] = parseImportCsv(
      "outcomes",
      "import_key,area_key,title,definition_of_done,value,status,deadline_at,review_on\r\no,a,,,,,,"
    );
    const errors = validateImportRecords([record!], { isExisting: isNew })[0]!.errors;
    expect(errors).toContain("title is required.");
    expect(errors).toContain("definitionOfDone is required.");
    expect(errors).toContain("value is required.");
    expect(errors).toContain("status is required.");
    expect(errors).not.toContain("deadlineAt is required.");
    expect(errors).not.toContain("reviewOn is required.");
  });

  it("requires a condition's name and kind but not its optional shape", () => {
    const [record] = parseImportCsv("conditions", "import_key,name,kind,status,portability\r\nc,,,,");
    const errors = validateImportRecords([record!], { isExisting: isNew })[0]!.errors;
    expect(errors).toContain("name is required.");
    expect(errors).toContain("kind is required.");
    expect(errors).not.toContain("status is required.");
    expect(errors).not.toContain("portability is required.");
  });

  it("requires both keys of a dependency edge, which carries no columns of its own", () => {
    const [record] = parseImportCsv("dependencies", "import_key,action_key,depends_on_action_key\r\ne,,");
    const errors = validateImportRecords([record!], { isExisting: isNew })[0]!.errors;
    expect(errors).toContain("actionKey is required.");
    expect(errors).toContain("dependsOnActionKey is required.");
  });

  it("requires both keys of a deliverable dependency edge", () => {
    const [record] = parseImportCsv(
      "deliverable_dependencies",
      "import_key,deliverable_key,depends_on_deliverable_key\r\ne,,"
    );
    const errors = validateImportRecords([record!], { isExisting: isNew })[0]!.errors;
    expect(errors).toContain("deliverableKey is required.");
    expect(errors).toContain("dependsOnDeliverableKey is required.");
  });
});

describe("entity prerequisite rows", () => {
  const header = "import_key,entity_kind,entity_key,requires_kind,requires_key";
  const rows = (...lines: string[]) => parseImportCsv("entity_prerequisites", [header, ...lines].join("\r\n"));
  const errorsOf = (...lines: string[]) =>
    validateImportRecords(rows(...lines), { isExisting: isNew }).map((r) => r.errors);

  it("accepts an edge between different kinds and a project-to-project edge", () => {
    expect(errorsOf("e1,action,a,project,p", "e2,project,p,project,q")).toEqual([[], []]);
  });

  it("sends same-kind action and deliverable edges to their own sheets", () => {
    const [action, deliverable] = errorsOf("e1,action,a,action,b", "e2,deliverable,a,deliverable,b");
    expect(action).toContain("Action-to-action edges belong on the Dependencies sheet, not Entity Prerequisites.");
    expect(deliverable?.join(" ")).toContain("Deliverable Dependencies sheet");
  });

  it("refuses a project that requires itself, an unknown kind and missing cells", () => {
    expect(errorsOf("e1,project,p,project,p")[0]).toContain("A project cannot be its own prerequisite.");
    expect(errorsOf("e1,task,a,project,p")[0]).toContain("entityKind must be one of: project, deliverable, action.");
    const errors = errorsOf("e1,,,,")[0]!;
    expect(errors).toEqual(expect.arrayContaining(["entityKind is required.", "requiresKey is required."]));
  });

  it("refuses a cycle the batch closes, including through action dependencies and a project's children", () => {
    for (const batch of [
      [...rows("e1,project,p,project,q", "e2,project,q,project,p")],
      [
        ...rows("e1,action,a,deliverable,d", "e2,deliverable,d,action,b"),
        ...parseImportCsv("dependencies", "import_key,action_key,depends_on_action_key\r\ne3,b,a")
      ],
      [...parseImportCsv("actions", `${actionColumns}\r\n${fullRow}`), ...rows("e1,project,proj,action,one")]
    ]) {
      const edges = validateImportRecords(batch, { isExisting: isNew }).filter(
        (record) => record.entityType === "entity_prerequisite"
      );
      for (const edge of edges) expect(edge.errors).toContain("Imported prerequisites contain a cycle.");
    }
  });

  it("accepts a chain that does not come back on itself", () => {
    expect(errorsOf("e1,action,a,deliverable,d", "e2,deliverable,d,project,p")).toEqual([[], []]);
  });
});

describe("repeat columns on an update that states the unit", () => {
  // `upserts.ts` rewrites every repeat column together whenever `interval_unit` is present, so a unit
  // with none of its own columns would write NULLs the pairing CHECK rejects at commit, not at review.
  const updateErrors = (csv: string) => {
    const [record] = parseImportCsv("fixed_commitment_recurrences", csv);
    return validateImportRecords([record!], { isExisting })[0]!.errors;
  };

  it("requires interval_weeks and weekdays when the update switches to weeks", () => {
    const errors = updateErrors("import_key,interval_unit\r\nr,weeks");
    expect(errors).toContain("intervalWeeks must be a positive integer.");
    expect(errors).toContain("weekdays is required when interval_unit is weeks.");
  });

  it("requires interval_months and month_anchor when the update switches to months", () => {
    const errors = updateErrors("import_key,interval_unit\r\nr,months");
    expect(errors).toContain("intervalMonths must be a positive integer.");
    expect(errors).toContain("monthAnchor is required.");
  });

  it("asks for neither when the update leaves the unit alone", () => {
    expect(updateErrors("import_key,title\r\nr,Renamed")).toEqual([]);
  });
});

describe("calendar diff conflicts", () => {
  const conflict = (message: string): ImportRecord => ({
    id: crypto.randomUUID(),
    importKey: "google_calendar:event:c:e",
    entityType: "fixed_commitment",
    operation: "conflict",
    expectedVersion: 2,
    matchedEntityId: "commitment-1",
    fields: {
      title: explicitField("Dentist"),
      startsAt: explicitField("2026-10-10T09:00:00.000Z"),
      endsAt: explicitField("2026-10-10T10:00:00.000Z"),
      status: explicitField("confirmed"),
      setupBeforeMinutes: explicitField(0),
      transitionAfterMinutes: explicitField(0)
    },
    relationships: {},
    errors: [message],
    warnings: [],
    removed: false,
    sortOrder: 0
  });

  it.each([
    "title changed in both Google Calendar and OpenRhen. Choose which value to keep.",
    "Cancelled in Google Calendar, but title changed in OpenRhen since. Delete it anyway or keep it."
  ])("keeps a Google conflict a conflict, with its explanation: %s", (message) => {
    const [record] = validateImportRecords([conflict(message)], { isExisting });
    expect(record).toMatchObject({ operation: "conflict", errors: [message] });
  });
});

describe("plan links", () => {
  const header = "import_key,from_type,from_id,to_type,to_id,kind,weight,evidence";
  const errorsOf = (row: string) => {
    const [record] = parseImportCsv("plan_links", `${header}\r\n${row}`);
    return validateImportRecords([record!])[0]!;
  };

  it("reads a link row, with its evidence list and weight", () => {
    const [record] = parseImportCsv(
      "plan_links",
      `${header}\r\nl1,project,p1,project,p2,before,0.5,term one|same unit`
    );
    expect(record).toMatchObject({ entityType: "plan_link", importKey: "l1" });
    expect(record!.fields.weight!.value).toBe(0.5);
    expect(record!.fields.evidence!.value).toEqual(["term one", "same unit"]);
    expect(validateImportRecords([record!])[0]).toMatchObject({ operation: "create", errors: [] });
  });

  it("requires the ends and the kind, and limits them to the allowed values", () => {
    expect(errorsOf("l1,project,,project,p2,before,,").errors).toContain("fromId is required.");
    expect(errorsOf("l1,project,p1,project,p2,,,").errors).toContain("kind is required.");
    expect(errorsOf("l1,widget,p1,project,p2,before,,").errors.join(" ")).toContain("fromType must be one of");
    expect(errorsOf("l1,project,p1,project,p2,friends,,").errors.join(" ")).toContain("kind must be one of");
  });

  it("refuses ends the kind does not allow, a link to itself and a weight outside 0 to 1", () => {
    expect(errorsOf("l1,project,p1,contact,c1,before,,").errors.join(" ")).toContain("cannot end at a contact");
    expect(errorsOf("l1,project,p1,project,p1,before,,").errors.join(" ")).toContain("itself");
    expect(errorsOf("l1,project,p1,project,p2,before,1.5,").errors).toContain("weight must be a number from 0 to 1.");
    expect(errorsOf("l1,project,p1,project,p2,before,1.5,").operation).toBe("rejected");
  });
});
