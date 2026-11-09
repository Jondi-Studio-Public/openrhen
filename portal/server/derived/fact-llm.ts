import { createHash, randomBytes } from "node:crypto";
import {
  FACT_REPLY_SCHEMA,
  MAX_FACTS_PER_REPLY,
  buildFactPrompt,
  classifyMessage,
  factIcsHandles,
  groundQuote,
  hostedEligibility,
  linkCandidates,
  linkFromChoice,
  localCandidates,
  localContext,
  messageFactContext,
  parseFactReply,
  readerEventKey,
  resolveWhen,
  vettedCandidates,
  vettedContext,
  type GroundingResult,
  type LinkCandidate,
  type ModelFactType,
  type ParsedFact,
  type VettedCandidates
} from "@openrhen/communication-readers";
import { MODEL_PROVIDERS } from "@openrhen/contracts";
import type { ScanInput } from "@/server/persistence/postgres/derived-scan-store";
import { LOCAL_ADDRESS_FIELD, type DerivedSettings } from "./derived-settings";
import { recipientDenials } from "./hosted-recipients";
import type { ModelExtractResult, ModelExtractor, ModelSourceMessage } from "./model-extractor";

/**
 * `fact-llm` (communication understanding, slice 2b-6): the first model extractor. It reads one mail message with the
 * owner's local model (T2) and writes the facts in it as `fact` rows: `ask`, `event` and `deadline` in mail that came
 * in, `commitment` in mail he sent. It is the code that decides everything but the words: the model returns a quote and
 * a type per fact and nothing else, and
 *
 *   - the fact id comes from the sentence the grounded quote starts in (`factIdN2`), never from the model;
 *   - the date comes from `resolveWhen` over the grounded quote, the message's own time and the owner's zone;
 *   - the direction and `who` come from the headers (`from_self`, `from`, `to`), and the conversation key from the thread;
 *   - a quote is written only if it passes the grounding gate (found exactly once in the message, outside quoted lines);
 *     a quote that fails is not written and is counted in the tick result by reason;
 *   - there is no confidence number: the row's caution is its tier and its stored `review_reason`.
 *
 * The hosted tier (T3) is reached ONLY on one of three closed signals, never on a number: (1) a quote T2 gave that is
 * not in the message while the message has a keyword hit, (2) T2's own `unsure` flag, (3) a reply that is still not the
 * closed schema after the call policy's one repair retry. Every message put in the hosted prompt first passes
 * `hostedEligibility` here (the target, its context and the link candidates, through `vettedContext` and
 * `vettedCandidates`), and the call policy asks the injected checker again at the call. When the hosted tier cannot take a
 * message (the rule says no, the daily cap is reached, no hosted model is pinned, the call fails or its reply is
 * unusable) the T2 rows stay, each with `review_reason: low_signal`. A later run offers the newest such messages to the
 * hosted tier again (`lane: "reoffer"`), up to the cap.
 *
 * Mail text is untrusted data. It reaches a model only inside `buildFactPrompt`'s fences, and a reply is accepted only
 * as the closed JSON schema (`parseFactReply`): a model that repeats instructions, or sends a status, id or date, has its
 * reply refused. The only thing this extractor can cause is a grounded `fact` row.
 *
 * This extractor reads no database: lookups arrive through the run's `lookups`.
 */

export const FACT_LLM = "fact-llm";
export const FACT_LLM_VERSION = "1";
export const FACT_LLM_VIA = `extractor:${FACT_LLM}`;
/** Version of the keyword list below; a change to the list bumps it. */
export const KEYWORDS_VERSION = "k1";

/** Facts kept per message before the rest are `over_cap`; the prompt tells the model the same number. */
export const FACTS_PER_MESSAGE = MAX_FACTS_PER_REPLY;
/** A reply with more facts than this is not the schema; up to it, the facts past the first five are only counted (`over_cap`). */
const REPLY_FACTS_MAX = 2 * FACTS_PER_MESSAGE;

const IN_TYPES: readonly ModelFactType[] = ["ask", "event", "deadline"];
const OUT_TYPES: readonly ModelFactType[] = ["commitment"];
/** Mail the headers say is not from a person is not read by the model: it is the T0 share, and a newsletter's "reply to this" is not an ask. */
const SKIPPED_CLASSES: ReadonlySet<string> = new Set(["bulk", "automated", "transaction"]);
/** Grounding failures that mean "the model quoted something that is not there": the model's weakness, so a signal. */
const UNGROUNDED: ReadonlySet<string> = new Set(["not_found", "ambiguous", "too_long"]);

/**
 * Words that say a message probably holds an ask, a date or a promise, in the languages `resolveWhen` reads. A hit
 * is only half of the first signal (T3 is asked when a quote is NOT in a message that has one); it never sends a message
 * anywhere by itself. Plain letters and a question mark; matched case-insensitively.
 */
const KEYWORD =
  /\?|\b(?:please|could you|can you|would you|will you|need to|needs to|let me know|remind|don'?t forget|deadline|due(?! to\b)|asap|urgent|meeting|appointment|call me|schedule[ds]?|reschedul\w*|cancel\w*|by (?:mon|tue|wed|thu|fri|sat|sun)\w*|by (?:tomorrow|tonight|today|eod|end of)|tomorrow|next week|i'll|i will|i can|we will|we'll|bitte|kannst du|könntest|frist|termin|besprechung|s'il vous pla[iî]t|peux-tu|pourriez|rendez-vous|por favor|puedes|reuni[oó]n|plazo|per favore|puoi|scadenza|riunione|alstublieft|kun je|afspraak|pode|prazo|reuni[aã]o|snälla|kan du|möte)\b/iu;

/** A link (with its query string) says nothing about the message's wording; `?` inside one is not a question. */
const URLS = /(?:https?:\/\/|www\.)\S+/giu;

export function hasKeyword(text: string): boolean {
  return KEYWORD.test(text.replace(URLS, " "));
}

/** The event key of a fact row: follows the SENTENCE, the version and the tier, so a rerun with another quote lands on the same row and a hosted reading is a new row beside the local one. */
export function factEventKey(input: {
  version: string;
  messageKey: string;
  tier: "t2" | "t3";
  sentence: string;
}): string {
  return readerEventKey({
    extractor: FACT_LLM,
    version: input.version,
    sourceEventId: input.messageKey,
    inputHash: createHash("sha1")
      .update(JSON.stringify(["tier", input.tier]))
      .digest("hex"),
    evidence: input.sentence
  });
}

/**
 * The hook for `fact-ics` (slice 2b-8, which does not exist yet). When it ships it supplies a predicate that is true for
 * a message it already turned into T0 `event` facts (an authenticated invite), so the model does not read that message
 * again. Until then nothing is claimed and the model reads calendar mail like any other person's mail.
 */
export type FactIcsHandled = (message: ModelSourceMessage) => boolean;
export const NO_FACT_ICS: FactIcsHandled = () => false;

export interface FactLlmOptions {
  version?: string;
  handledByFactIcs?: FactIcsHandled;
  /** 16 to 64 lowercase letters and digits, fresh per call. Injectable so a golden test can pin the prompt. */
  boundary?: () => string;
}

/** The activity rows fact-llm reads: person mail. Declared once; every lookup below takes it from `extractor.input`. */
const MAIL_INPUT: ScanInput = { source: "gmail", kind: "message" };

const NOT_CONFIGURED_PUT = `PUT /api/derived-settings {"${LOCAL_ADDRESS_FIELD}":"http://<address and port of the computer that runs ${MODEL_PROVIDERS.local.label}>","t2Model":"<a model that computer has pulled>"}`;

type Stats = Record<string, number>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const CONTROL = /\p{Cc}/u;

/** The calendar UID a message carries, when it is a usable one (the contract's own limits). */
function icsUidOf(attrs: Record<string, unknown>): string | null {
  const uid = isRecord(attrs.ics) ? attrs.ics.uid : undefined;
  return typeof uid === "string" && uid.length > 0 && uid.length <= 255 && !CONTROL.test(uid) ? uid : null;
}

/** Lines starting with `>` are an earlier message quoted back; a keyword there says nothing about this message. */
const withoutQuoted = (content: string) =>
  content
    .split(/\r\n?|\n/u)
    .filter((line) => !/^[ \t]*>/u.test(line))
    .join("\n");

// ---- reading a reply ---------------------------------------------------------------------------------------------------

type Reading = { ok: true; facts: ParsedFact[]; unsure: boolean } | { ok: false; problem: string };

/**
 * The closed schema, with one allowance: up to ten facts are read (the first five are the facts, the rest are
 * `over_cap`), where `parseFactReply` itself stops at five. Anything else the schema refuses stays refused.
 */
function readReply(raw: string, candidateCount: number): Reading {
  const strict = parseFactReply(raw, candidateCount);
  if (strict.ok) return strict;
  if (strict.reason === "too_many_facts") {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return refusal(strict.reason, strict.path);
    }
    if (isRecord(value) && Array.isArray(value.facts) && value.facts.length <= REPLY_FACTS_MAX) {
      const head = parseFactReply(
        JSON.stringify({ ...value, facts: value.facts.slice(0, FACTS_PER_MESSAGE) }),
        candidateCount
      );
      const tail = parseFactReply(JSON.stringify({ facts: value.facts.slice(FACTS_PER_MESSAGE) }), candidateCount);
      if (head.ok && tail.ok) return { ok: true, facts: [...head.facts, ...tail.facts], unsure: head.unsure };
      const bad = !head.ok ? head : tail;
      if (!bad.ok) return refusal(bad.reason, bad.path, bad.field);
    }
  }
  return refusal(strict.reason, strict.path, strict.field);
}

function refusal(reason: string, path?: string, field?: string): Reading {
  const where = path ? ` at ${path}` : "";
  const named = field ? ` (the field "${field}" is not allowed)` : "";
  return {
    ok: false,
    problem: `the reply was not the allowed JSON object: ${reason.replace(/_/gu, " ")}${where}${named}. Give only {"facts":[{"quote":"...","type":"ask"}],"unsure":false}, with at most ${FACTS_PER_MESSAGE} facts, and no date, id, name or direction`
  };
}

// ---- turning readings into rows ----------------------------------------------------------------------------------------

interface Accepted {
  fact: ParsedFact;
  grounded: Extract<GroundingResult, { ok: true }>;
}
interface TierReading {
  accepted: Accepted[];
  unsure: boolean;
  ungrounded: number;
}

interface Subject {
  message: ModelSourceMessage;
  attrs: Record<string, unknown>;
  direction: "in" | "out";
  who: string[];
  conversationKey: string;
  icsUid: string | null;
  subjectLine: string | null;
  tz: string;
}

export function createFactLlm(options: FactLlmOptions = {}): ModelExtractor {
  const version = options.version ?? FACT_LLM_VERSION;
  const handled = options.handledByFactIcs ?? NO_FACT_ICS;
  const boundary = options.boundary ?? (() => randomBytes(12).toString("hex"));

  const extractor: ModelExtractor = {
    name: FACT_LLM,
    version,
    via: FACT_LLM_VIA,
    input: MAIL_INPUT,
    reoffer: { reviewReason: "low_signal" },
    notConfigured(settings: DerivedSettings) {
      if (settings[LOCAL_ADDRESS_FIELD] && settings.t2Model) return null;
      const missing = [
        !settings[LOCAL_ADDRESS_FIELD] ? LOCAL_ADDRESS_FIELD : null,
        !settings.t2Model ? "t2Model" : null
      ].filter(Boolean);
      return `the local model is not set up (${missing.join(" and ")} missing), so there is nothing to read mail with. Save them with ${NOT_CONFIGURED_PUT} (Settings > Mail understanding); the first version is created on the next run.`;
    },
    forVersion: (other) => createFactLlm({ ...options, version: other }),
    async extract(message, context, run) {
      const stats: Stats = {};
      const bump = (key: string, by = 1) => void (stats[key] = (stats[key] ?? 0) + by);
      const done = (rows: unknown[]): ModelExtractResult => ({ kind: "rows", rows, stats });

      const attrs = isRecord(message.attrs) ? message.attrs : null;
      const header = attrs ? messageFactContext(MAIL_INPUT.source, attrs) : null;
      if (!attrs || !header || !header.ok) {
        bump("skipped_context");
        return done([]);
      }
      if (SKIPPED_CLASSES.has(classifyMessage(attrs).class)) {
        bump("skipped_class");
        return done([]);
      }
      if (handled(message)) {
        bump("skipped_fact_ics");
        return done([]);
      }

      const subject: Subject = {
        message,
        attrs,
        direction: header.direction,
        who: header.who,
        conversationKey: header.conversationKey,
        icsUid: icsUidOf(attrs),
        subjectLine: text(attrs.subject),
        tz: await run.lookups.timeZone()
      };
      const earlier = context.filter((c) => text(c.content) !== null);
      const pool = earlier.length > 0 ? await run.lookups.linkPool(subject.conversationKey) : [];
      const sources = new Map(pool.map((entry) => [entry.factId, entry.source]));
      const candidates = linkCandidates(
        { conversationKey: subject.conversationKey, tsStart: message.tsStart.getTime(), icsUid: subject.icsUid },
        pool
      );
      const keyword = hasKeyword(withoutQuoted(message.content));

      const tally = (grounded: GroundingResult) => {
        if (grounded.ok) bump("grounded");
        else {
          bump("rejected");
          bump(`rejected_${grounded.reason}`);
        }
      };
      const accept = (facts: readonly ParsedFact[], unsure: boolean): TierReading => {
        const accepted: Accepted[] = [];
        const seen = new Set<string>();
        let ungrounded = 0;
        const allowed = subject.direction === "in" ? IN_TYPES : OUT_TYPES;
        for (const fact of facts) {
          const grounded = groundQuote({
            content: message.content,
            quote: fact.quote,
            conversationKey: subject.conversationKey,
            icsUid: subject.icsUid
          });
          tally(grounded);
          if (!grounded.ok) {
            if (UNGROUNDED.has(grounded.reason)) ungrounded += 1;
            continue;
          }
          if (!allowed.includes(fact.type)) {
            bump("type_not_for_direction");
            continue;
          }
          if (seen.has(grounded.factId)) {
            bump("duplicate_sentence");
            continue;
          }
          seen.add(grounded.factId);
          if (accepted.length >= FACTS_PER_MESSAGE) {
            bump("over_cap");
            continue;
          }
          accepted.push({ fact, grounded });
        }
        return { accepted, unsure, ungrounded };
      };

      // ---- the rows -----------------------------------------------------------------------------------------------------
      const rowsFor = async (
        reading: TierReading,
        tier: "t2" | "t3",
        links: readonly LinkCandidate[],
        lowSignal: boolean
      ): Promise<unknown[]> => {
        const points = Array.from(message.content);
        const rows: unknown[] = [];
        for (const { fact, grounded } of reading.accepted) {
          const span = grounded.span;
          const quoteText = points.slice(span.start, span.end).join("");
          const when = resolveWhen({
            text: quoteText,
            textStart: span.start,
            refTime: message.tsStart,
            tz: subject.tz,
            lang: text(attrs.lang)
          });
          if (!when.ok) bump("when_failed");
          const resolved = when.ok ? when.when : null;
          const link = fact.link ? linkFromChoice(links, fact.link.relation, `c${fact.link.candidate}`) : null;
          const reason = lowSignal ? "low_signal" : resolved?.ambiguous ? "ambiguous_date" : undefined;
          const attrsOut: Record<string, unknown> = {
            source_event_id: message.key,
            fact_id: grounded.factId,
            fact_type: fact.type,
            tier,
            extractor: FACT_LLM,
            extractor_version: version,
            span,
            ...(resolved ? { when: resolved } : {}),
            who: subject.who,
            direction: subject.direction,
            conversation_key: subject.conversationKey,
            ...(subject.icsUid ? { ics_uid: subject.icsUid } : {}),
            ...(link && link.target_fact_id !== grounded.factId ? { links: [link] } : {}),
            ...(reason ? { review_reason: reason } : {})
          };
          rows.push({
            id: factEventKey({ version, messageKey: message.key, tier, sentence: grounded.sentence.text }),
            source: "derived",
            kind: "fact",
            start: new Date(Math.min(message.tsStart.getTime(), run.now.getTime())).toISOString(),
            attrs: attrsOut
          });
          bump(`rows_${tier}`);
        }
        return rows;
      };

      // ---- the hosted tier ------------------------------------------------------------------------------------------------
      type Hosted =
        | { kind: "ok"; reading: TierReading; links: readonly LinkCandidate[] }
        | { kind: "unavailable" | "denied" | "cap" | "failed" | "bad_output"; message?: string };
      const askHosted = async (): Promise<Hosted> => {
        if (!run.pinned.t3) {
          bump("t3_unavailable");
          return { kind: "unavailable" };
        }
        const hostedContext = earlier.map((c) => ({
          attrs: isRecord(c.attrs) ? c.attrs : {},
          subject: text(isRecord(c.attrs) ? c.attrs.subject : null),
          content: c.content as string,
          fromSelf: isRecord(c.attrs) && c.attrs.from_self === true
        }));
        const sensitive = await run.lookups.sensitiveSenders();
        // A link candidate shows a quote from an EARLIER message, so that message must itself pass the rule (its sender,
        // class, text and labels); a candidate whose source is gone or fails is not offered to the hosted tier at all.
        const offered = candidates.filter((candidate) => {
          const source = sources.get(candidate.factId);
          if (!source || source.content === null) return false;
          const checked = hostedEligibility({
            message: { attrs: source.attrs, subject: source.subject, content: source.content },
            context: [],
            sensitiveSenders: sensitive
          });
          return checked.send && recipientDenials(source.attrs, sensitive).length === 0;
        });
        const verdict = hostedEligibility({
          message: { attrs, subject: subject.subjectLine, content: message.content },
          context: hostedContext,
          candidates: offered,
          sensitiveSenders: sensitive
        });
        // For mail he sent, the sender is himself: the recipients (of this message and of the context) go through the sender rule.
        const recipients = [attrs, ...hostedContext.map((c) => c.attrs)].flatMap((a) => recipientDenials(a, sensitive));
        if (!verdict.send || recipients.length > 0) {
          bump("t3_denied");
          return { kind: "denied" };
        }
        const links: VettedCandidates<LinkCandidate> = vettedCandidates(verdict);
        const prompt = buildFactPrompt({
          boundary: boundary(),
          message: { subject: subject.subjectLine, content: message.content, from: text(attrs.from) },
          context: vettedContext<(typeof hostedContext)[number]>(verdict),
          candidates: links
        });
        if (!prompt.ok) return { kind: "bad_output" };
        const called = await run.call({
          tier: "t3",
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ],
          format: FACT_REPLY_SCHEMA as unknown as Record<string, unknown>,
          validate: (reply) => {
            const read = readReply(reply, links.length);
            return read.ok ? null : read.problem;
          }
        });
        if (called.kind === "refused") {
          if (called.reason === "message_cap" || called.reason === "token_cap") {
            bump("t3_cap");
            return { kind: "cap", message: called.message };
          }
          // The call-site check said no. A verdict about this message (`settled`) or the model's retention is final; a setting (no key saved, a cap of 0) is not.
          bump(called.reason === "not_eligible" && called.settled !== true ? "t3_refused" : "t3_denied");
          return { kind: "denied", message: called.message };
        }
        if (called.kind === "failed") {
          bump(called.outcome === "bad_output" ? "t3_bad_output" : "t3_failed");
          return { kind: called.outcome === "bad_output" ? "bad_output" : "failed", message: called.message };
        }
        const read = readReply(called.text, links.length);
        if (!read.ok) {
          bump("t3_bad_output");
          return { kind: "bad_output", message: read.problem };
        }
        bump("t3_used");
        return { kind: "ok", reading: accept(read.facts, read.unsure), links };
      };

      // ---- a message offered to the hosted tier again --------------------------------------------------------------------
      if (run.lane === "reoffer") {
        const hosted = await askHosted();
        if (hosted.kind !== "ok") return done([]);
        return done(await rowsFor(hosted.reading, "t3", hosted.links, hosted.reading.unsure));
      }

      // ---- T2 ---------------------------------------------------------------------------------------------------------------
      if (!run.pinned.t2)
        return {
          kind: "failed",
          outcome: "unreachable",
          message: `This version was pinned without a local model, so it cannot read mail. Save one with ${NOT_CONFIGURED_PUT}; the next version is pinned to it.`
        };
      const localLinks: VettedCandidates<LinkCandidate> = localCandidates(candidates);
      const prompt = buildFactPrompt({
        boundary: boundary(),
        message: { subject: subject.subjectLine, content: message.content, from: text(attrs.from) },
        context: localContext(
          earlier.map((c) => ({
            subject: text(isRecord(c.attrs) ? c.attrs.subject : null),
            content: c.content as string,
            fromSelf: isRecord(c.attrs) && c.attrs.from_self === true
          }))
        ),
        candidates: localLinks
      });
      if (!prompt.ok) {
        bump("skipped_no_text");
        return done([]);
      }
      const called = await run.call({
        tier: "t2",
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ],
        format: FACT_REPLY_SCHEMA as unknown as Record<string, unknown>,
        validate: (reply) => {
          const read = readReply(reply, localLinks.length);
          return read.ok ? null : read.problem;
        }
      });
      if (called.kind === "refused") return { kind: "failed", outcome: "unreachable", message: called.message };
      let t2: TierReading | null = null;
      let schemaFailure = false;
      let schemaMessage = "";
      if (called.kind === "failed") {
        if (called.outcome !== "bad_output")
          return { kind: "failed", outcome: called.outcome, message: called.message };
        schemaFailure = true;
        schemaMessage = called.message;
      } else {
        const read = readReply(called.text, localLinks.length);
        if (read.ok) t2 = accept(read.facts, read.unsure);
        else {
          schemaFailure = true;
          schemaMessage = read.problem;
        }
      }

      const signalUngrounded = t2 !== null && t2.ungrounded > 0 && keyword;
      const signalUnsure = t2?.unsure === true && keyword;
      if (schemaFailure) bump("signal_schema");
      if (signalUnsure) bump("signal_unsure");
      if (signalUngrounded) bump("signal_ungrounded");
      if (!schemaFailure && !signalUnsure && !signalUngrounded)
        return done(await rowsFor(t2!, "t2", localLinks, false));

      const hosted = await askHosted();
      if (hosted.kind === "ok") return done(await rowsFor(hosted.reading, "t3", hosted.links, hosted.reading.unsure));
      // The hosted tier did not take it: what T2 read stays, marked as not settled.
      if (schemaFailure || t2 === null)
        return {
          kind: "failed",
          outcome: "bad_output",
          message: `${schemaMessage || "The local model's reply was not usable."} The hosted tier did not take the message over (${hosted.kind}), so nothing was kept.`
        };
      return done(await rowsFor(t2, "t2", localLinks, true));
    }
  };
  return extractor;
}

export const factLlm: ModelExtractor = createFactLlm({ handledByFactIcs: (message) => factIcsHandles(message.attrs) });
