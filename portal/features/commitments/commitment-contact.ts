import type { ConditionDefinition } from "@/features/settings/context-summary";

/** What every reader needs to know about the person on the other end. */
export interface ResolvedContact {
  id: string;
  name: string;
  /** Where a prefilled text or email goes, when Settings has one. */
  phone?: string;
  email?: string;
}

/**
 * The one place a commitment's optional contact becomes a person to show. A reader that resolved it
 * its own way would be the drift this function exists to prevent.
 *
 * A slug that names nothing, an archived condition, or one that is not `kind: "contact"` all read as
 * no contact: the caller falls back to its generic wording rather than showing a bare slug.
 */
export function resolveCommitmentContact(
  commitment: { contactId?: string | undefined },
  conditionDefinitions: ConditionDefinition[]
): ResolvedContact | undefined {
  if (!commitment.contactId) return undefined;
  const found = conditionDefinitions.find((entry) => entry.id === commitment.contactId);
  if (!found || found.kind !== "contact" || found.status !== "active") return undefined;
  return {
    id: found.id,
    name: found.name,
    ...(found.phone ? { phone: found.phone } : {}),
    ...(found.email ? { email: found.email } : {})
  };
}
