import type { ModelExtractor } from "./model-extractor";

/**
 * The model-backed extractors the model tick drives. Empty in 2b-4: the `fact-llm` extractor is slice 2b-6 and adds
 * itself here. With none registered the tick answers `no_extractors` and does nothing, so the route and the worker
 * loop are safe to ship before any extractor exists.
 */
export const MODEL_EXTRACTORS: readonly ModelExtractor[] = [];
