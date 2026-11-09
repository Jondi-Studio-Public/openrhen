/**
 * The eight settings rows You and the Settings page list, and the pages each row owns. A row with more
 * than one page shows them as tabs (Planning | Buffers | Estimates), so every settings page knows its
 * siblings from this one list rather than each page linking its own.
 */
export interface SettingsPageLink {
  href: string;
  /** The tab label; the first page's label is the section's own name. */
  label: string;
}

export interface SettingsSection {
  id: string;
  title: string;
  /** What the row holds, shown under its title when there is nothing live to say. */
  meta: string;
  pages: readonly SettingsPageLink[];
}

export const settingsSections: readonly SettingsSection[] = [
  {
    id: "sleep",
    title: "Sleep and routines",
    meta: "Bedtime, wake and the steps around them",
    pages: [
      { href: "/settings/sleep", label: "Sleep" },
      { href: "/settings/routines", label: "Routines" }
    ]
  },
  {
    id: "planning",
    title: "Planning",
    meta: "Buffers, estimates, time zone",
    pages: [
      { href: "/settings/planning", label: "Planning" },
      { href: "/settings/planning/buffers", label: "Buffers" },
      { href: "/settings/planning/estimates", label: "Estimates" }
    ]
  },
  {
    id: "places",
    title: "Places and energy",
    meta: "Places, capabilities, contacts, energy levels",
    pages: [
      { href: "/settings/catalogues/conditions", label: "Places and conditions" },
      { href: "/settings/catalogues/energy", label: "Energy levels" }
    ]
  },
  {
    id: "notifications",
    title: "Notifications",
    meta: "Leave-by alerts on this device",
    pages: [{ href: "/settings/notifications", label: "Notifications" }]
  },
  {
    id: "disruptions",
    title: "Disruptions and sharing",
    meta: "Disruption presets, family calendar, pulse",
    pages: [
      { href: "/settings/disruptions", label: "Disruptions" },
      { href: "/settings/family-calendar", label: "Family calendar" },
      { href: "/settings/pulse", label: "Pulse" }
    ]
  },
  {
    id: "ai",
    title: "AI and add-ons",
    meta: "Models, mail understanding, map add-ons, agent tokens",
    pages: [
      { href: "/settings/ai", label: "AI and add-ons" },
      { href: "/settings/mail-understanding", label: "Mail understanding" }
    ]
  },
  {
    id: "passwords",
    title: "Passwords and keys",
    meta: "Keys for outside services, saved encrypted and never shown again",
    pages: [{ href: "/settings/passwords-and-keys", label: "Passwords and keys" }]
  },
  {
    id: "sign-in",
    title: "Sign-in and devices",
    meta: "This browser and your other devices",
    pages: [{ href: "/settings/advanced", label: "Sign-in and devices" }]
  }
];

/** The section a settings page belongs to, or undefined for a path outside settings. */
export function settingsSectionFor(href: string): SettingsSection | undefined {
  return settingsSections.find((section) => section.pages.some((page) => page.href === href));
}

/** A 24-hour "22:40" as "10:40 pm"; anything else is returned as written. */
export function clockLabel(value: string | undefined): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? "");
  if (!match) return value ?? "";
  const hours = Number(match[1]);
  const period = hours >= 12 ? "pm" : "am";
  return `${hours % 12 === 0 ? 12 : hours % 12}:${match[2]} ${period}`;
}
