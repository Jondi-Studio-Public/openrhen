const TRIGGERS: Record<string, string> = {
  manual: "Run by hand",
  scheduled: "Scheduled",
  notify: "On a new submission"
};

const RUN_STATUSES: Record<string, string> = {
  synced: "Synced",
  needs_review: "Needs your review",
  failed: "Failed",
  not_configured: "Not set up"
};

function words(value: string): string {
  const text = value.replace(/[_-]+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What started a sync run, for the Connections cards: "scheduled" -> "Scheduled", "notify" -> "On a new submission". */
export function syncTriggerLabel(trigger: string): string {
  return TRIGGERS[trigger] ?? words(trigger);
}

/** How a sync run ended, in words: "needs_review" -> "Needs your review". Unknown values read as plain sentence case. */
export function syncRunStatusLabel(status: string): string {
  return RUN_STATUSES[status] ?? words(status);
}
