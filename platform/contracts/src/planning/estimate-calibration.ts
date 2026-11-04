/**
 * Learned estimate calibration (logic design §5 "Learned calibration"). Pure, so the portal
 * read that shows the factors and the engine that applies them agree by construction: the server
 * derives once from session history and the result travels in the planning state.
 *
 * A sample is one finished one-off action: the remaining effort its first session started from,
 * less whatever its last session left, against the minutes its sessions actually ran. Nothing here
 * reads a mutable estimate, so editing an action later never rewrites what it taught.
 */

/** Fewer finished actions than this and an estimate stays exactly as entered. */
export const CALIBRATION_MIN_SAMPLES = 5;
/** Weight of the newest ratio in the moving average: gradual, so one odd task moves little. */
export const CALIBRATION_EWMA_WEIGHT = 0.25;
export const CALIBRATION_MIN_FACTOR = 0.75;
export const CALIBRATION_MAX_FACTOR = 2.5;
/** One sample's ratio is bounded before it is averaged, so a forgotten running timer is an outlier, not a verdict. */
export const CALIBRATION_MIN_RATIO = 0.25;
export const CALIBRATION_MAX_RATIO = 4;
/** Learned spread: z of the 85th percentile, applied to the sd of the log ratios. */
export const CALIBRATION_SPREAD_Z = 1.04;
export const CALIBRATION_MIN_SPREAD = 1;
export const CALIBRATION_MAX_SPREAD = 2;
/** An estimate smaller than this cannot say anything useful about a ratio. */
export const CALIBRATION_MIN_ESTIMATE_MINUTES = 5;

export interface CalibrationSample {
  actionId: string;
  areaId: string | null;
  /** ISO instant the action was completed; samples are averaged in this order. */
  completedAt: string;
  estimatedMinutes: number;
  actualMinutes: number;
}

export interface CalibrationFactor {
  /** Two decimals. 1 is "estimates were right". */
  factor: number;
  /**
   * Padding multiplier over the calibrated mean, learned from how widely the finished actions' ratios
   * scatter (p85 of the log ratios, clamped). It replaces the uncertainty multiplier rather than
   * stacking on it. Absent in states derived before it existed.
   */
  spread?: number | undefined;
  samples: number;
  /** Completion instant of the newest sample, so a reader can see when the factor last moved. */
  lastSampleAt: string;
}

export interface EstimateCalibration {
  /** Every area's samples together; the fallback for an area with too few of its own. */
  overall: CalibrationFactor | null;
  areas: Array<CalibrationFactor & { areaId: string }>;
}

export const emptyEstimateCalibration: EstimateCalibration = { overall: null, areas: [] };

export function usableCalibrationSample(sample: CalibrationSample): boolean {
  return (
    Number.isFinite(sample.estimatedMinutes) &&
    Number.isFinite(sample.actualMinutes) &&
    sample.estimatedMinutes >= CALIBRATION_MIN_ESTIMATE_MINUTES &&
    sample.actualMinutes >= 1
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Oldest first from a neutral 1, so the factor walks towards the evidence rather than jumping to it. */
function factorOf(samples: CalibrationSample[]): CalibrationFactor | null {
  if (samples.length < CALIBRATION_MIN_SAMPLES) return null;
  let factor = 1;
  const logs: number[] = [];
  for (const sample of samples) {
    const ratio = clamp(sample.actualMinutes / sample.estimatedMinutes, CALIBRATION_MIN_RATIO, CALIBRATION_MAX_RATIO);
    factor = CALIBRATION_EWMA_WEIGHT * ratio + (1 - CALIBRATION_EWMA_WEIGHT) * factor;
    logs.push(Math.log(ratio));
  }
  const centre = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  const deviation = Math.sqrt(logs.reduce((sum, value) => sum + (value - centre) ** 2, 0) / (logs.length - 1));
  const spread = clamp(Math.exp(CALIBRATION_SPREAD_Z * deviation), CALIBRATION_MIN_SPREAD, CALIBRATION_MAX_SPREAD);
  return {
    factor: Math.round(clamp(factor, CALIBRATION_MIN_FACTOR, CALIBRATION_MAX_FACTOR) * 100) / 100,
    spread: Math.round(spread * 100) / 100,
    samples: samples.length,
    lastSampleAt: samples[samples.length - 1]!.completedAt
  };
}

export function deriveEstimateCalibration(input: readonly CalibrationSample[]): EstimateCalibration {
  const samples = input
    .filter(usableCalibrationSample)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.actionId.localeCompare(b.actionId));
  const byArea = new Map<string, CalibrationSample[]>();
  for (const sample of samples) {
    if (!sample.areaId) continue;
    byArea.set(sample.areaId, [...(byArea.get(sample.areaId) ?? []), sample]);
  }
  const areas = [...byArea.entries()]
    .map(([areaId, list]) => {
      const factor = factorOf(list);
      return factor ? { areaId, ...factor } : null;
    })
    .filter((entry): entry is CalibrationFactor & { areaId: string } => entry !== null)
    .sort((a, b) => a.areaId.localeCompare(b.areaId));
  return { overall: factorOf(samples), areas };
}

/** The factor an area's estimates take: its own once it has enough samples, else everyone's, else none. */
export function calibrationFactorForArea(
  calibration: EstimateCalibration,
  areaId: string | null | undefined
): (CalibrationFactor & { scope: "area" | "overall" }) | null {
  const own = areaId ? calibration.areas.find((entry) => entry.areaId === areaId) : undefined;
  if (own)
    return {
      factor: own.factor,
      ...(own.spread === undefined ? {} : { spread: own.spread }),
      samples: own.samples,
      lastSampleAt: own.lastSampleAt,
      scope: "area"
    };
  return calibration.overall ? { ...calibration.overall, scope: "overall" } : null;
}
