const KEY = "openrhen.closed.lookedAt";

/** When this device last opened the Closed page (ISO), or null. Storage can throw or be empty; both read as never. */
export function readClosedLookedAt(): string | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return value && !Number.isNaN(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

/** Marks the closes up to now as seen on this device, which clears the badge. */
export function markClosedLooked(now: Date = new Date()): void {
  try {
    window.localStorage.setItem(KEY, now.toISOString());
  } catch {
    // The badge then shows again next time; nothing else depends on it.
  }
}
