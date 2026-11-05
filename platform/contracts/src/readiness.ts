/**
 * The contracts the portal runs in the browser: the context matcher and the deliverable readiness
 * assessment, and nothing that builds a zod schema. Importing these through the package's main entry
 * brings every schema in the package into the client bundle, because schema construction runs at
 * module load and cannot be tree-shaken; this entry reaches the same functions without it.
 *
 * Only pure, side-effect-free modules belong here. A server that validates input keeps using the
 * main entry.
 */
export {
  evaluateConjunction,
  evaluateConditions,
  findCompositeCycles,
  resolveSituation
} from "./planning/context-match.js";
export type {
  CommitmentWindow,
  ConjunctionResult,
  ResolutionSource,
  ResolvedSituation
} from "./planning/context-match.js";
export { assessDeliverable, buildDeliverableProjections, cyclicSteps } from "./planning/deliverable-readiness.js";
export type {
  CoverageFailure,
  DeliverableReadiness,
  ReadinessDeliverable,
  StepBlockReason,
  StepReadiness
} from "./planning/deliverable-readiness.js";
export { parseRequirementKey, baseConditionId } from "./planning/requirement-key.js";
export { DEFAULT_LOCATION_STALE_AFTER_MINUTES } from "./planning/context-constants.js";
export { CALIBRATION_MIN_SAMPLES, calibrationFactorForArea } from "./planning/estimate-calibration.js";
export type { CalibrationFactor, EstimateCalibration } from "./planning/estimate-calibration.js";
