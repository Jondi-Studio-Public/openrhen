import { notFound, InvalidCommandError } from "./command-errors";
import { changeLogConfirmedBy, requestAgent, requestClaim } from "@/server/agent-actor";
import type { Sql } from "./sql-pool";

/**
 * What the owner says about people goes through `current_availability`, in `currentSituation.presence`
 * (`{ pete: "here" | "away" | null }`) and `currentSituation.waivers` (`{ <action or step id>: ["pete"] | null }`).
 * Both are the owner's to say: an agent may relay them only on the owner's own words (basis stated, with the words
 * as evidence), never from notes, a calendar or a guess. Checked before anything is stored, so a refusal changes nothing.
 */

const OWNER_ONLY = (what: string, example: string) =>
  `${what} is the owner's to say, so it needs their own words: ask the owner, then repeat this call with basis stated and evidence set to what they said (up to 300 characters). ` +
  `Never infer it from notes, the calendar or an earlier day. Nothing was saved. Example: ${example}`;

interface Said {
  presence: string[];
  waivers: { workId: string; people: string[] }[];
}

/** The verbs and lists a payload carries; objects (a resent stored value) are not statements and are skipped. */
export function peopleStatements(currentSituation: unknown): Said {
  const said: Said = { presence: [], waivers: [] };
  if (!currentSituation || typeof currentSituation !== "object") return said;
  const raw = currentSituation as Record<string, unknown>;
  if (raw.presence && typeof raw.presence === "object")
    for (const [id, verb] of Object.entries(raw.presence as Record<string, unknown>))
      if (verb === "here" || verb === "away" || verb === null) said.presence.push(id);
  if (raw.waivers && typeof raw.waivers === "object")
    for (const [workId, people] of Object.entries(raw.waivers as Record<string, unknown>))
      if (Array.isArray(people))
        said.waivers.push({
          workId,
          people: people.filter((id): id is string => typeof id === "string" && id.length > 0)
        });
  return said;
}

export async function checkPeopleStatements(tx: Sql, userId: string, currentSituation: unknown): Promise<void> {
  const said = peopleStatements(currentSituation);
  const raw = (currentSituation ?? {}) as Record<string, unknown>;
  const sayingSomething =
    said.presence.some((id) => (raw.presence as Record<string, unknown>)[id] !== null) || said.waivers.length > 0;
  if (!said.presence.length && !said.waivers.length) return;

  // Clearing is always allowed; saying someone is here or away, or waiving them, is the owner's.
  const byAgent = requestAgent() !== null && changeLogConfirmedBy() !== "owner";
  if (byAgent && sayingSomething) {
    const claim = requestClaim();
    if (claim?.basis !== "stated" || !claim.evidence?.trim()) {
      if (said.waivers.length)
        throw new InvalidCommandError(
          OWNER_ONLY(
            "Letting a task go ahead without a person it waits on",
            'rhen_save {"entityType":"current_availability","fields":{"currentEnergy":"<their current energy>","currentSituation":{"waivers":{"<action id>":["<contact id>"]}}},"basis":"stated","evidence":"<the owner\'s words, e.g. do it without Pete>"}'
          ),
          {
            nextCall: {
              tool: "rhen_attention",
              arguments: {},
              note: "ask the owner first; do not send this unprompted"
            }
          }
        );
      throw new InvalidCommandError(
        OWNER_ONLY(
          "Whether a person is with the owner today",
          'rhen_save {"entityType":"current_availability","fields":{"currentEnergy":"<their current energy>","currentSituation":{"presence":{"<contact id>":"here"}}},"basis":"stated","evidence":"<the owner\'s words, e.g. Pete is here today>"}'
        ),
        {
          nextCall: { tool: "rhen_attention", arguments: {}, note: "ask the owner first; do not send this unprompted" }
        }
      );
    }
  }

  const contactIds = [...new Set([...said.presence, ...said.waivers.flatMap((entry) => entry.people)])];
  if (contactIds.length) {
    const rows = await tx<
      { id: string; kind: string; status: string }[]
    >`SELECT id, kind, status FROM condition_definitions WHERE user_id=${userId} AND id = ANY(${contactIds})`;
    const good = new Set(rows.filter((row) => row.kind === "contact" && row.status === "active").map((row) => row.id));
    const bad = contactIds.filter((id) => !good.has(id));
    if (bad.length)
      throw new InvalidCommandError(
        `${bad.map((id) => `"${id}"`).join(", ")} ${bad.length === 1 ? "is" : "are"} not an active contact, so nothing can be said about ${bad.length === 1 ? "them" : "it"}. ` +
          "Use the id of a contact from the list, or create the person first as a name-only contact. Nothing was saved.",
        {
          nextCall: {
            tool: "rhen_list",
            arguments: { entity: "condition-definitions", limit: 50 },
            note: "contacts have kind contact"
          }
        }
      );
  }
  if (said.waivers.length) {
    const ids = said.waivers.map((entry) => entry.workId);
    const rows = await tx<
      { id: string }[]
    >`SELECT ac.id::text AS id FROM actions ac JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas ar ON ar.id=o.area_id WHERE ac.id::text = ANY(${ids}) AND ar.user_id=${userId}`;
    const found = new Set(rows.map((row) => row.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw notFound("action", missing.join(", "), "The action or step to go ahead without someone");
  }
}
