/**
 * The names core itself owns as sources: a connection or activity source that ships in the base product and that no
 * deployment chooses or replaces. Core may branch on these (`literal-connection-branch` in
 * `scripts/repository/rules/` skips them); every other registered connection id or activity source name is a provider
 * choice, and core must reach it through the registry, never by comparing against its name.
 *
 * Read by that rule as text, so keep it a plain array of string literals.
 */
export const CORE_SOURCES = [
  "pulse",
  "calendar_feed",
  "rhen-watch",
  "weather",
  "physiology",
  "derived",
  "derived-shadow",
  "drift"
] as const;

export type CoreSource = (typeof CORE_SOURCES)[number];
