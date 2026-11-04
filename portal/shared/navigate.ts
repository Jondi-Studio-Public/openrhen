"use client";

/**
 * Sending the reader to another page, as a function rather than as a bare `window.location` write.
 *
 * A control that navigates is making a claim about where it goes, and that claim is worth a test.
 * `window.location.assign` cannot be replaced under jsdom — the property refuses redefinition — so
 * a test can neither observe it nor stop it from logging a not-implemented navigation. One named
 * seam fixes both: product code says where it is going, and a test watches this module.
 */
export function navigateTo(href: string): void {
  window.location.assign(href);
}
