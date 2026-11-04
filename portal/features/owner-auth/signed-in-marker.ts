/**
 * A non-secret note that this browser has been signed in before. After 30 unused days the browser drops its
 * expired cookie, so the server answers as if it had never seen one; the marker is how the sign-in screen can
 * still say "expired" rather than "not signed in yet".
 */
export const SIGNED_IN_BEFORE_KEY = "openrhen.signedInBefore";

export function markSignedIn() {
  try {
    window.localStorage.setItem(SIGNED_IN_BEFORE_KEY, "1");
  } catch {
    // Storage blocked: the screen just uses its first-visit wording.
  }
}

export function clearSignedInMark() {
  try {
    window.localStorage.removeItem(SIGNED_IN_BEFORE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The two refusals that mean "no credential was sent". An invalid or throttled one has its own wording. */
export function isAnonymousRefusal(reason: string | null | undefined): boolean {
  return reason === "read-anonymous" || reason === "write-anonymous";
}

export function wasSignedInBefore(): boolean {
  try {
    return window.localStorage.getItem(SIGNED_IN_BEFORE_KEY) === "1";
  } catch {
    return false;
  }
}
