import { DEFAULT_CHECK_IN_EXTRA_MINUTES, DEFAULT_PULSE_THRESHOLDS } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";

/** The recorder's latest judgement as the portal state carries it (`state.pulse`); absent before its first run. */
export type PulseReading = NonNullable<PortalState["pulse"]>;

/** Whether the pulse is the `off/lapsed` state that only a re-entry heals. */
export function pulseNeedsReentry(pulse: PulseReading | undefined): boolean {
  return pulse?.state === "off" && (pulse.offReason === "lapsed" || pulse.reason === "lapsed");
}

/** Contact has been lost for a while: the "Still doing X?" line is the whole recovery. */
export function pulseIsUnknown(pulse: PulseReading | undefined): boolean {
  return pulse?.state === "unknown";
}

export type PulseTone = "neutral" | "accent" | "warn" | "danger" | "info";

/** The chip on Now and You: a few words that say the same thing the colour does. */
export function pulseChip(pulse: PulseReading | undefined): { tone: PulseTone; label: string } | null {
  if (!pulse) return null;
  if (pulseNeedsReentry(pulse)) return { tone: "danger", label: "Lost track · catch up" };
  switch (pulse.state) {
    case "on":
      return { tone: "accent", label: pulse.reason === "disrupted" ? "On plan · disrupted" : "On plan" };
    case "unknown":
      return { tone: "warn", label: "Not sure what you're doing" };
    case "off":
      return { tone: "danger", label: "Off plan" };
    case "free":
      return { tone: "neutral", label: "Free" };
    case "asleep":
      return { tone: "info", label: "Asleep" };
  }
}

/** The longer line under the chip on You. */
export function pulseSentence(pulse: PulseReading | undefined): string {
  if (!pulse) return "Not read yet";
  if (pulseNeedsReentry(pulse)) return "Contact was lost. Tell the plan where you are to carry on.";
  switch (pulse.state) {
    case "on":
      if (pulse.reason === "disrupted" && pulse.disruption) return `On plan, disrupted: ${pulse.disruption.doing}`;
      return pulse.doing ? `On plan · ${pulse.doing.title}` : "On plan";
    case "unknown":
      return pulse.doing ? `Still doing ${pulse.doing.title}? Say so on Now.` : "Say what you're doing on Now.";
    case "off":
      return "Off plan";
    case "free":
      return "Free time";
    case "asleep":
      return "Asleep";
  }
}

/** The line on Now while the pulse is unknown and a check-in is waiting to be answered. */
export function stillDoingQuestion(pulse: PulseReading | undefined, fallbackTitle: string): string {
  const title = pulse?.doing?.title || fallbackTitle;
  return title ? `Still doing ${title}?` : "Still on plan?";
}

export type ThresholdKey = "pulseUnknownToOffMinutes" | "pulseFurtherPrompts" | "pulseUnknownHardOffMinutes";

export interface ThresholdSpec {
  key: ThresholdKey;
  label: string;
  unit: "minutes" | "prompts";
  min: number;
  max: number;
  fallback: number;
  help: string;
}

/** The three lapse numbers (design note, "Transitions"); the bounds match `settingsFields` on the server. */
export const THRESHOLDS: readonly ThresholdSpec[] = [
  {
    key: "pulseUnknownToOffMinutes",
    label: "Minutes unsure before you are marked off plan",
    unit: "minutes",
    min: 5,
    max: 480,
    fallback: DEFAULT_PULSE_THRESHOLDS.unknownToOffMinutes,
    help: "Counted once a further check-in has gone unanswered."
  },
  {
    key: "pulseFurtherPrompts",
    label: "Unanswered check-ins before you are marked off plan",
    unit: "prompts",
    min: 0,
    max: 10,
    fallback: DEFAULT_PULSE_THRESHOLDS.furtherPrompts,
    help: "After the first one that made the plan unsure."
  },
  {
    key: "pulseUnknownHardOffMinutes",
    label: "Minutes unsure before off plan, whatever was asked",
    unit: "minutes",
    min: 5,
    max: 720,
    fallback: DEFAULT_PULSE_THRESHOLDS.unknownHardOffMinutes,
    help: "The cap when no further check-in went out. Cannot be shorter than the first."
  }
];

/**
 * What a threshold box holds as the command field: blank is `null` (the default), anything else a whole number in
 * range. A string comes back for an out-of-range or malformed entry, to show next to the box.
 */
export function parseThreshold(spec: ThresholdSpec, text: string): number | null | string {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return "Use a whole number, or leave it blank for the default.";
  const value = Number(trimmed);
  if (value < spec.min || value > spec.max) return `Between ${spec.min} and ${spec.max}.`;
  return value;
}

/** What `Check-in allowance` offers: the default (+15 min), or a custom number of minutes (0 allowed). */
export const CHECK_IN_ALLOWANCE_DEFAULT_LABEL = `Default (+${DEFAULT_CHECK_IN_EXTRA_MINUTES} min)`;
export const CHECK_IN_ALLOWANCE_MAX = 480;

export function checkInAllowanceLabel(minutes: number | null | undefined): string {
  return minutes === null || minutes === undefined ? CHECK_IN_ALLOWANCE_DEFAULT_LABEL : `+${minutes} min`;
}
