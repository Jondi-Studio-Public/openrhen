import planInputTables from "./plan-input-tables.json" with { type: "json" };
import { parseDatasetRef, type DatasetRef } from "./types.js";

/**
 * The value surfaces (design 2.4): the concrete places data reaches something the person or the engine uses. A reader
 * claims a surface in its `to`; CI checks the claim against the code, so "gives" is computed, not written by hand.
 */

export const SURFACE_KINDS = ["engine", "page", "tool", "device", "push", "external", "backup", "rest"] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** Surfaces that only move data without anyone using it: reaching them never counts as value. */
export const PASS_THROUGH_SURFACE_KINDS: readonly SurfaceKind[] = ["backup", "rest"];

/** Kinds that take no name (`surface:engine`) and kinds that need one (`surface:page/review`). */
const NAMELESS: readonly SurfaceKind[] = ["engine", "push", "backup", "rest"];

export interface ParsedSurface {
  kind: SurfaceKind;
  /** The path, tool, route or connection id; absent for the nameless kinds. */
  name?: string;
}

export function parseSurface(ref: string): ParsedSurface | null {
  const parsed = parseDatasetRef(ref);
  if (!parsed || parsed.scheme !== "surface" || Object.keys(parsed.filters).length > 0) return null;
  const [head, ...rest] = parsed.name.split("/");
  const kind = SURFACE_KINDS.find((candidate) => candidate === head);
  if (!kind) return null;
  const name = rest.join("/");
  if (NAMELESS.includes(kind)) return name === "" ? { kind } : null;
  return name === "" ? null : { kind, name };
}

export function isSurfaceRef(ref: string): boolean {
  return ref.startsWith("surface:");
}

/** Whether reaching this surface counts as the data being used. */
export function surfaceHasValue(ref: string): boolean {
  const parsed = parseSurface(ref);
  return parsed !== null && !PASS_THROUGH_SURFACE_KINDS.includes(parsed.kind);
}

/** The `page.tsx` a `surface:page/<path>` stands for, relative to the repository root. */
export function surfacePageFile(ref: string): string | null {
  const parsed = parseSurface(ref);
  return parsed?.kind === "page" ? `portal/app/${parsed.name}/page.tsx` : null;
}

/** A short label for a surface, used in the reach text ("Review", "Engine"). */
export function surfaceLabel(ref: string): string {
  const parsed = parseSurface(ref);
  if (!parsed) return ref;
  if (parsed.kind === "page") {
    const last = parsed.name!.split("/").at(-1) ?? parsed.name!;
    return last.charAt(0).toUpperCase() + last.slice(1);
  }
  if (parsed.kind === "tool" || parsed.kind === "device" || parsed.kind === "external") return parsed.name!;
  return parsed.kind.charAt(0).toUpperCase() + parsed.kind.slice(1);
}

export function surfaceRef(kind: SurfaceKind, name?: string): DatasetRef {
  return `surface:${name === undefined ? kind : `${kind}/${name}`}`;
}

/**
 * The tables the planning engine reads (`readPortalState` and `buildPlanForecastRequest`). Every production write to
 * one goes through `recordStateChange`. The same file feeds `scripts/repository/write-path-registry.mjs`.
 */
export const PLAN_INPUT_TABLES: readonly string[] = planInputTables;

/**
 * Tables the engine is blind to on purpose: watch history, the activity store, saved keys and the Now offer log.
 * `portal/server/watch-history/engine-blind.test.ts` keeps its own list and fails when this one differs.
 */
export const BLIND_TABLES: readonly string[] = [
  "watch_events",
  "watch_imports",
  "video_info",
  "activity_events",
  "activity_imports",
  "activity_source_state",
  "activity_supersessions",
  "derived_lineage",
  "extractor_state",
  "derived_settings",
  "derived_model_calls",
  "app_secrets",
  "youtube_quota_use",
  "offer_log"
];

/** The one table whose rows are split into per-source, per-kind partitions (`pg:activity_events[source=a,kind=b]`). */
export const ACTIVITY_PARTITION_TABLE = "activity_events";
