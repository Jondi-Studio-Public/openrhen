import type { Extractor } from "./extractor";
import { factIcs } from "./fact-ics";
import { msgClassT0 } from "./msg-class-t0";

export type { Extractor };

/** The extractors the runner drives. A new version is added here and starts inactive until it is promoted. */
export const EXTRACTORS: readonly Extractor[] = [msgClassT0, factIcs];
