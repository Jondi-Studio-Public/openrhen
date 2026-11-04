import { createElement } from "react";
import { registerPortalExtension } from "@/state/portal-extensions";

/** The sender and subject a fake mail thread carries in its proposed fields. */
const text = (fields: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = fields?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
};

/** The source type the fake claims, standing in for a real mail provider's. */
export const FAKE_MAIL_SOURCE_TYPE = "mail_thread";

/**
 * Registers a stand-in mail source (the `inbox_source` seam), so the Emails room's grouping, counts
 * and queue rows can be tested without any provider installed. It claims `email_change` proposals whose source type
 * is {@link FAKE_MAIL_SOURCE_TYPE}.
 */
export function registerFakeMailSource(): void {
  registerPortalExtension({
    id: "fake-mail",
    mail: {
      claims: (item) => item.sourceType === FAKE_MAIL_SOURCE_TYPE,
      ownsProposal: (item) => item.sourceType === FAKE_MAIL_SOURCE_TYPE || item.sourceType === "mail",
      contextFrom: () => ({}),
      entry: (items, _context, now) => {
        const first = items[0]!;
        const fields = first.proposedFields;
        return {
          kind: "email",
          items,
          key: `email:${first.sourceId}`,
          room: "emails",
          title: items.length === 1 ? (text(fields, "title") ?? first.text) : (text(fields, "subject") ?? first.text),
          meta: ["Email", text(fields, "fromName"), now.toISOString().slice(0, 10)].filter(Boolean).join(" · "),
          tag: { label: items.length > 1 ? `${items.length} changes` : "Email change", tone: "info" },
          waiting: true,
          arrivedAt: items
            .map((item) => text(item.proposedFields, "newestAt") ?? item.createdAt)
            .reduce((a, b) => (a > b ? a : b))
        };
      },
      Card: ({ items }) => createElement("div", { "data-testid": "mail-card" }, `${items.length} mail changes`),
      reviewCountUrl: "/api/mail/review-count"
    }
  });
}
