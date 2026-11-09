import { createHash } from "node:crypto";
import { normaliseText } from "./fact-id.js";
import { SPLITTER_VERSION } from "./sentence-split.js";

/**
 * The normaliser version of the fact identity. Frozen like `n1`: the golden vectors in fact-id-n2.test.ts pin it, and
 * changing what it does means a new version string and new vectors. `n1` and its vectors stay as they are; no fact has
 * been stored under it.
 */
export const FACT_ID_NORMALISER_VERSION = "n2";

/** Quote markers at the start of each line (`>`, nested `> >` or `>>`, with the spaces around them), which are not the sentence. */
const QUOTE_MARKERS = /^[ \t]*(?:>[ \t]*)+/gmu;

/** The sentence without the `>` markers a reply puts in front of quoted lines, so a quoted ask hashes as the original does. */
export function stripQuoteMarkers(text: string): string {
  return text.replace(QUOTE_MARKERS, "");
}

export interface FactIdN2Input {
  conversationKey: string;
  /** The sentence unit that contains the start of the grounded quote (`sentenceAt`), not the model's quote; normalised here. */
  sentence: string;
  icsUid?: string | null | undefined;
}

/**
 * Identity of a fact: sha1 over `["fact", "n2", splitter version, conversation key, normalised sentence, ics uid]` as a
 * JSON array so no field borrows characters from its neighbour. It hashes the sentence the quote starts in, so two model
 * readings of one message with different quotes land on one id, and it has no fact type, so a model that calls the same
 * sentence a `deadline` instead of an `ask` keeps its statuses, overrides and labels. Text is normalised as `n1` does
 * (NFKC, invisible characters removed, lower case, whitespace folded, where whitespace is JavaScript's `\\s`), after
 * leading `>` quote markers are stripped from every line. A surviving fact id is a plain sha1 of a short sentence and so
 * guessable for stock phrases by anyone holding the database; see activity-store.md.
 */
export function factIdN2(input: FactIdN2Input): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        "fact",
        FACT_ID_NORMALISER_VERSION,
        SPLITTER_VERSION,
        input.conversationKey,
        normaliseText(stripQuoteMarkers(input.sentence)),
        input.icsUid ?? null
      ])
    )
    .digest("hex");
}
