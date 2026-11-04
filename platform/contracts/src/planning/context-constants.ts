/**
 * Constants the context matcher needs at run time, kept apart from `context-model.ts` so the
 * matcher can be bundled without zod. The schemas there are built at module load, and a bundler
 * cannot tell that building them is side-effect free, so anything that imports the module drags
 * every schema in the package into the browser with it. The portal runs the matcher in the browser.
 */
export const DEFAULT_LOCATION_STALE_AFTER_MINUTES = 480;

/**
 * How long each daily fact is trusted before the plan treats it as unknown (the fact freshness design note,
 * "One rule, in contracts"). Constants, not settings: nothing to configure until one proves wrong in use.
 * Location's own window is `DEFAULT_LOCATION_STALE_AFTER_MINUTES` above.
 */
/** A wake older than `maxAwakeHours` plus this was followed by a night nobody recorded. */
export const WAKE_STALE_GRACE_HOURS = 2;
/** An action or deliverable session is stale this long past its planned end, or its planned length if longer. */
export const SESSION_STALE_MIN_GRACE_MINUTES = 60;
/** A paused session is stale this long after it was paused. */
export const PAUSED_SESSION_STALE_HOURS = 4;
/** A routine or commitment session is stale this long past its planned end. */
export const ACTIVITY_STALE_GRACE_HOURS = 4;
/** Energy said longer ago than this, or before the last wake, is no longer current. */
export const ENERGY_STALE_HOURS = 8;
/** A remaining-effort estimate not set or confirmed for this many days is aged, once its project is at risk. */
export const EFFORT_STALE_DAYS = 14;
