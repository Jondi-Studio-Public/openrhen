import { factLlm } from "./fact-llm";
import type { ModelExtractor } from "./model-extractor";

/**
 * The model-backed extractors the model tick drives. `fact-llm` (communication understanding, slice 2b-6) is the first:
 * version 1 is created only when the local host and model are both set, and is ACTIVE from its first run (its facts reach
 * readers at once and it backfills). Only a later version, made by saving a different model pair, starts inactive and
 * shadow-reads until someone calls `promoteExtractorVersion`; `GET /api/activity-events/summary?report=eval` is a report,
 * not a gate. With none registered the tick answers `no_extractors` and does nothing.
 */
export const MODEL_EXTRACTORS: readonly ModelExtractor[] = [factLlm];
