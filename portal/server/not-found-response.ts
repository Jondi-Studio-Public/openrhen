import { notFoundRefusal, type RefusalKind } from "@openrhen/contracts";

/**
 * The 404 a route answers when the id in its path names nothing: the record's kind and the id sent, and (in `nextCall`)
 * the call that lists the real ones, in the same body shape the command refusals use.
 */
export function notFoundResponse(kind: RefusalKind, id: unknown, what?: string): Response {
  const refusal = notFoundRefusal(kind, id, what);
  return Response.json(
    { error: refusal.message, ...(refusal.nextCall === undefined ? {} : { nextCall: refusal.nextCall }) },
    { status: 404 }
  );
}
