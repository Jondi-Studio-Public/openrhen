-- Supersession (A3): an import row that holds a message's text stands in for a thinner copy of the same message in
-- another source. A side table (the append-only trigger of 0148 stays as it is), a SQL twin of normaliseMessageId, and one
-- partial expression index so a message's other copies are found by id without scanning the largest table.
--
-- The index build takes a SHARE lock on activity_events for as long as it runs (about 14 s at 4 million rows, measured):
-- inserts, updates and deletes wait, reads do not. CREATE INDEX CONCURRENTLY is not possible here: it cannot run inside a
-- transaction, and drizzle's migrator applies every pending migration of a set in one transaction (see
-- operations/migrate-on-deploy.ts); nothing else in this repo runs a non-transactional migration step. Nothing is lost
-- while it waits: the deploy's migrate step runs before the portal and worker start (compose recreates them and holds
-- them until it exits 0), so the only writers are collectors, which already get "connection refused" for the whole
-- deploy and resend (an event key already held is alreadyHeld, never a duplicate). A migration run by hand against a
-- running stack makes a write wait, then complete when the build ends, or time out at the client (rhen: "did not answer
-- within N ms"); resending the same batch is safe either way. The lock_timeout below bounds only how long the build
-- waits to get its lock behind running writers; it then fails fast and the migration can be retried. Reverse, in this order:
--   DROP INDEX activity_events_message_id_idx; DROP TABLE activity_supersessions;
--   DROP FUNCTION reject_activity_supersession_update(); DROP FUNCTION normalise_message_id(text);
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
-- Does exactly what normaliseMessageId does (platform/contracts/src/activity-message.ts): trim; strip one pair of angle
-- brackets and trim again; lower-case the part after the last "@" (a local part is case-sensitive); an id with no "@" as
-- given. Trimming covers the ASCII whitespace a message id can carry. IMMUTABLE so it can sit in an index.
CREATE FUNCTION "normalise_message_id"(raw text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN strpos(t.id, '@') = 0 THEN t.id
    ELSE substr(t.id, 1, length(t.id) - length(substring(t.id from '[^@]*$'))) || lower(substring(t.id from '[^@]*$'))
  END
  FROM (
    SELECT btrim(
      CASE WHEN b.s ~ '^<.*>$' THEN substr(b.s, 2, length(b.s) - 2) ELSE b.s END,
      E' \t\r\n\f\v'
    ) AS id
    FROM (SELECT btrim(raw, E' \t\r\n\f\v') AS s) b
  ) t
$$;--> statement-breakpoint
CREATE TABLE "activity_supersessions" (
	"user_id" uuid NOT NULL,
	"superseded_id" uuid PRIMARY KEY NOT NULL,
	"by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_supersessions_distinct_check" CHECK ("activity_supersessions"."superseded_id" <> "activity_supersessions"."by_id")
);
--> statement-breakpoint
ALTER TABLE "activity_supersessions" ADD CONSTRAINT "activity_supersessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_supersessions" ADD CONSTRAINT "activity_supersessions_superseded_id_activity_events_id_fk" FOREIGN KEY ("superseded_id") REFERENCES "public"."activity_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_supersessions" ADD CONSTRAINT "activity_supersessions_by_id_activity_events_id_fk" FOREIGN KEY ("by_id") REFERENCES "public"."activity_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_supersessions_by_idx" ON "activity_supersessions" USING btree ("by_id");--> statement-breakpoint
-- Append-only, like activity_events: a link is written once and removed only by its rows going (cascade).
CREATE FUNCTION "reject_activity_supersession_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity_supersessions is append-only: a link is never updated. Undo the import (or purge the source) and import again.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "activity_supersessions_no_update" BEFORE UPDATE ON "activity_supersessions" FOR EACH ROW EXECUTE FUNCTION "reject_activity_supersession_update"();--> statement-breakpoint
CREATE INDEX "activity_events_message_id_idx" ON "activity_events" USING btree ("user_id",(normalise_message_id("attrs"->>'message_id'))) WHERE "activity_events"."kind" = 'message' AND "activity_events"."attrs" ? 'message_id';
