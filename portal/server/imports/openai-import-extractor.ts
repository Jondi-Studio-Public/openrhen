import { resolveConnection, type ImportField, type ImportRecord } from "@openrhen/contracts";
import { callCapability } from "@/integrations/connection-host-client";
import { convertImportValue } from "@/features/imports/import-csv";
import { importSpecs } from "@/features/imports/import-spec";
import { recordProviderCall } from "@/server/telemetry/provider-call-recorder";
import type { ImportExtractionInput, ImportExtractor } from "./import-extractor";

type ExtractedField = {
  name: string;
  value: string | null;
  basis: "explicit" | "inferred" | "missing";
  confidence: "high" | "medium" | "low" | null;
  evidence: string[];
  needsReview: boolean;
};
type ExtractedRecord = {
  importKey: string;
  entityType: ImportRecord["entityType"];
  fields: ExtractedField[];
  relationships: Array<{ name: string; value: string | null }>;
};

const entityTypes = [
  "area",
  "outcome",
  "project",
  "action",
  "dependency",
  "fixed_commitment",
  "fixed_commitment_recurrence"
] as const;
const entityName = Object.fromEntries(Object.entries(importSpecs).map(([name, spec]) => [spec.type, name]));

/**
 * The OpenAI call goes through the outbound-proxy sidecar, not a direct fetch from the portal:
 * OPENAI_API_KEY is set on that container only, and the portal is the one process published on the
 * LAN. Any new outbound HTTPS call belongs in that sidecar for the same reason.
 */
export class OpenAIImportExtractor implements ImportExtractor {
  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly model = "gpt-5.6-sol",
    private readonly request: typeof fetch = fetch
  ) {}

  async extract(input: ImportExtractionInput): Promise<ImportRecord[]> {
    const url = this.env.OUTBOUND_PROXY_URL?.trim();
    const token = this.env.OUTBOUND_PROXY_TOKEN?.trim();
    if (!url || !token)
      throw new Error("The integrations sidecar is not configured: OUTBOUND_PROXY_URL, OUTBOUND_PROXY_TOKEN.");
    const { records } = await recordProviderCall(
      "openai",
      "extract_import",
      async () => {
        const response = await callCapability({
          connectionId: resolveConnection("model_provider", "extract").id,
          capability: "model_provider",
          op: "extract",
          env: this.env,
          fetcher: this.request,
          body: {
            model: this.model,
            store: false,
            reasoning: { effort: "medium" },
            instructions: instructions(input),
            input: [{ role: "user", content: requestContent(input) }],
            text: {
              format: { type: "json_schema", name: "openrhen_import_draft", strict: true, schema: extractionSchema }
            }
          }
        });
        const payload = response.body as any;
        if (payload === null && response.ok) throw new Error("The AI extraction answer was not JSON.");
        if (!response.ok) throw new Error(payload?.error ?? `AI extraction failed (${response.status}).`);
        const refusal = payload.output
          ?.flatMap((item: any) => item.content ?? [])
          .find((item: any) => item.type === "refusal")?.refusal;
        if (refusal) throw new Error(`OpenAI could not extract this input: ${refusal}`);
        const output =
          payload.output_text ??
          payload.output?.flatMap((item: any) => item.content ?? []).find((item: any) => item.type === "output_text")
            ?.text;
        if (!output) throw new Error("OpenAI returned no structured import draft.");
        const parsed = JSON.parse(output) as { records?: ExtractedRecord[] };
        if (!Array.isArray(parsed.records)) throw new Error("OpenAI returned an invalid import draft.");
        return {
          records: parsed.records,
          usage: payload.usage as { input_tokens?: number; output_tokens?: number } | undefined
        };
      },
      (result) => ({
        ok: true,
        inputTokens: result.usage?.input_tokens ?? null,
        outputTokens: result.usage?.output_tokens ?? null
      })
    );
    return records.map(normalizeRecord);
  }
}

function normalizeRecord(extracted: ExtractedRecord, sortOrder: number): ImportRecord {
  const specName = entityName[extracted.entityType];
  const spec = specName ? importSpecs[specName] : undefined;
  if (!spec) throw new Error(`OpenAI returned an unsupported entity type: ${extracted.entityType}`);
  const byName = new Map(extracted.fields.map((field) => [field.name, field]));
  const fields: ImportRecord["fields"] = {};
  for (const column of spec.columns) {
    const source = byName.get(column.name);
    const value =
      source?.value === null || source?.value === undefined ? null : convertImportValue(source.value, column);
    fields[column.name] = normalizeField(source, value);
  }
  // Only keys that live in `relationships` are read from there. A relation the spec carries as a
  // field names a saved record the extraction has no catalogue to choose from, so it is not asked for.
  const relationships = Object.fromEntries(
    spec.relations
      .filter((relation) => !relation.asField)
      .map(({ name }) => [name, extracted.relationships.find((item) => item.name === name)?.value?.trim() || null])
  );
  const importKey = extracted.importKey.trim() || `missing-${extracted.entityType}-${sortOrder + 1}`;
  return {
    id: crypto.randomUUID(),
    importKey,
    entityType: extracted.entityType,
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    fields,
    relationships,
    errors: extracted.importKey.trim() ? [] : ["import_key is required."],
    warnings: [],
    removed: false,
    sortOrder
  };
}

function normalizeField(source: ExtractedField | undefined, value: unknown): ImportField {
  if (value === null || value === undefined || value === "")
    return {
      value: null,
      basis: "missing",
      confidence: null,
      evidence: source?.evidence.filter(Boolean) ?? [],
      needsReview: true
    };
  const basis = source?.basis === "explicit" ? "explicit" : "inferred";
  return {
    value,
    basis,
    confidence: source?.confidence ?? "low",
    evidence: source?.evidence.filter(Boolean) ?? [],
    needsReview: basis === "inferred" || source?.needsReview === true
  };
}

function requestContent(input: ImportExtractionInput) {
  const content: Array<Record<string, string>> = [];
  if (input.text?.trim()) content.push({ type: "input_text", text: input.text.trim() });
  for (const image of input.images ?? [])
    content.push({
      type: "input_image",
      image_url: `data:${image.mimeType};base64,${bytesToBase64(image.bytes)}`,
      detail: "high"
    });
  return content;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function instructions(input: ImportExtractionInput) {
  const supported = Object.entries(importSpecs)
    .map(
      ([_name, spec]) =>
        `${spec.type}: fields [${spec.columns.map((column) => column.name).join(", ")}], relationships [${spec.relations
          .filter((relation) => !relation.asField)
          .map((relation) => relation.name)
          .join(", ")}]`
    )
    .join("\n");
  const hierarchy = JSON.stringify(input.currentState);
  return `Extract planning records from the supplied ${input.inputKind} into an editable OpenRhen import draft.
Timezone: ${input.timezone}.
Supported record shapes:\n${supported}

Rules:
- Recurring appointments (e.g. "Piano lesson, every 2 weeks on Friday 2-3pm") are fixed_commitment_recurrence records, not fixed_commitment: set startDate to the first occurrence's date, intervalDays to the repeat interval in days (every 2 weeks = 14, weekly = 7; a single weekday only), and localStartTime/localEndTime to the clock time of each occurrence. A rule on several weekdays ("Tuesdays and Thursdays") is intervalUnit weeks with intervalWeeks (1 = every week) and weekdays as a comma-separated list like "Tue, Thu" that includes startDate's weekday. Only use fixed_commitment for a single, non-repeating appointment.
- A habit or cadence ("run every 3 days", "practise maths daily", "twice a week") is an action with repeatEveryDays set to the days between attempts — daily = 1, twice a week ≈ 3 — never a fixed_commitment_recurrence, which is for an appointment at a fixed clock time. Such an action needs an importance saying how much the habit matters, since that is what decides when it is suggested.
- Never invent unavailable facts, placeholder text, dates, estimates, scores, statuses, relationships, or defaults.
- For unavailable fields use value null, basis missing, confidence null, needsReview true.
- Use explicit only when directly stated or visibly present. Use inferred only for a defensible interpretation and set needsReview true.
- Evidence must be a short source phrase or image observation, never hidden reasoning.
- Use stable concise import keys. Relationships must reference import keys in this draft unless the input unambiguously identifies an existing hierarchy item.
- Return only supported field and relationship names. Include all useful records, but do not create speculative records.
- Dates must be ISO 8601 and timestamps must include an offset when the source provides enough date/time information.
Current hierarchy context (reference only; do not fabricate updates): ${hierarchy}`;
}

const extractedFieldSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    value: { type: ["string", "null"] },
    basis: { type: "string", enum: ["explicit", "inferred", "missing"] },
    confidence: { type: ["string", "null"], enum: ["high", "medium", "low", null] },
    evidence: { type: "array", items: { type: "string" } },
    needsReview: { type: "boolean" }
  },
  required: ["name", "value", "basis", "confidence", "evidence", "needsReview"]
};

const extractionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    records: {
      type: "array",
      maxItems: 2000,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          importKey: { type: "string" },
          entityType: { type: "string", enum: entityTypes },
          fields: { type: "array", items: extractedFieldSchema },
          relationships: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { name: { type: "string" }, value: { type: ["string", "null"] } },
              required: ["name", "value"]
            }
          }
        },
        required: ["importKey", "entityType", "fields", "relationships"]
      }
    }
  },
  required: ["records"]
};
