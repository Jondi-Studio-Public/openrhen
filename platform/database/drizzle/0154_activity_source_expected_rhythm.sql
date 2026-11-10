-- Fail fast rather than queue behind ingest: the column add takes a brief ACCESS EXCLUSIVE lock on a small table.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "activity_source_state" ADD COLUMN "expected_every_minutes" integer;--> statement-breakpoint
ALTER TABLE "activity_source_state" ADD CONSTRAINT "activity_source_state_expected_check" CHECK ("activity_source_state"."expected_every_minutes" IS NULL OR "activity_source_state"."expected_every_minutes" BETWEEN 5 AND 129600);
-- Reverse: ALTER TABLE "activity_source_state" DROP CONSTRAINT "activity_source_state_expected_check", DROP COLUMN "expected_every_minutes";
