import { extensionSourceIds } from "./connection-id.js";
import { manifests } from "./manifest-store.js";
import { CAPABILITY_OPS, type CapabilityId } from "./capabilities.js";
import type { ConnectionManifest } from "./manifest.js";

export { registerConnectionManifest } from "./manifest-store.js";

const CORE_SOURCE_LABELS: Record<string, string> = {
  email: "Email",
  apple_calendar: "Apple Calendar"
};

/** The one place consumers read manifests from, never `BUILTIN_CONNECTIONS` directly: the core list, then registered ones. */
export function connectionRegistry(): readonly ConnectionManifest[] {
  return manifests;
}

export function connectionManifest(id: string): ConnectionManifest | undefined {
  return connectionRegistry().find((manifest) => manifest.id === id);
}

export function isRegisteredConnection(id: string): boolean {
  return connectionManifest(id) !== undefined;
}

export function calendarSourceConnections(): ConnectionManifest[] {
  return connectionRegistry().filter((manifest) => manifest.calendarSource !== undefined);
}

/** Calendar sources the automatic sync runs for on an interval (not a daily one), in registry order. */
export function intervalCalendarSourceIds(): string[] {
  return calendarSourceConnections()
    .filter((manifest) => manifest.calendarSource?.schedule.kind === "interval")
    .map((manifest) => manifest.id);
}

/** The connection that publishes the plan to a shared calendar (the first declaring `calendar_sink`), if one is registered. */
export function calendarSinkConnection(): ConnectionManifest | undefined {
  return connectionRegistry().find((manifest) => manifest.capabilities.includes("calendar_sink"));
}

/** What the person calls the shared calendar: the sink connection's label, or a generic phrase when none is registered. */
export function calendarSinkLabel(): string {
  return calendarSinkConnection()?.label ?? "shared calendar";
}

/** The calendar source whose values are definitive on the fields it gives (role `primary`), if one is registered. */
export function primarySourceConnection(): ConnectionManifest | undefined {
  return calendarSourceConnections().find((manifest) => manifest.calendarSource?.role === "primary");
}

/** Every calendar source with role `primary`, in registry order (the ones whose links a "share imported shifts" default moves). */
export function primarySourceIds(): string[] {
  return calendarSourceConnections()
    .filter((manifest) => manifest.calendarSource?.role === "primary")
    .map((manifest) => manifest.id);
}

/** What the person calls the primary source: its label, or a generic phrase when none is registered. */
export function primarySourceLabel(): string {
  return primarySourceConnection()?.label ?? "roster";
}

/** Every calendar source id the registry holds, in registry order. */
export function calendarSourceIds(): string[] {
  return calendarSourceConnections().map((manifest) => manifest.id);
}

/** Calendar sources that hold review batches the person works through (everything but the primary source), in registry order. */
export function reviewCalendarSourceIds(): string[] {
  return calendarSourceConnections()
    .filter((manifest) => manifest.calendarSource?.role !== "primary")
    .map((manifest) => manifest.id);
}

/** The prefix a calendar source's conflict relationships carry (`<prefix>ConflictFields`, `<prefix>Remote:<field>`). */
export function relationshipPrefixOf(manifest: ConnectionManifest): string {
  return manifest.calendarSource?.relationshipPrefix ?? manifest.id;
}

export function sourceRoleOf(id: string): "primary" | "secondary" {
  return connectionManifest(id)?.calendarSource?.role === "primary" ? "primary" : "secondary";
}

export function sourceLabel(id: string): string {
  const manifest = connectionManifest(id);
  if (manifest) return manifest.label;
  if (Object.hasOwn(CORE_SOURCE_LABELS, id)) return CORE_SOURCE_LABELS[id] as string;
  if (Object.hasOwn(extensionSourceIds(), id)) return extensionSourceIds()[id] as string;
  return id
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function declaresOp(manifest: ConnectionManifest, capability: CapabilityId, op: string): boolean {
  if (!manifest.capabilities.includes(capability)) return false;
  const ops: readonly string[] = manifest.ops?.[capability] ?? CAPABILITY_OPS[capability];
  return ops.includes(op);
}

/** The first registry manifest declaring the op; throws if none does. */
export function resolveConnection(capability: CapabilityId, op: string): ConnectionManifest {
  const found = connectionRegistry().find((manifest) => declaresOp(manifest, capability, op));
  if (!found) throw new Error(`No connection declares ${capability}.${op}`);
  return found;
}
