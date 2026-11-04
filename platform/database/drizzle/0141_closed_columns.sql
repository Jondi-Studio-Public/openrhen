ALTER TABLE "actions" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "closed_from_status" text;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "closed_batch" uuid;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "areas" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "areas" ADD COLUMN "closed_from_status" text;--> statement-breakpoint
ALTER TABLE "areas" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "areas" ADD COLUMN "closed_batch" uuid;--> statement-breakpoint
ALTER TABLE "areas" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "commitments" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commitments" ADD COLUMN "closed_from_status" text;--> statement-breakpoint
ALTER TABLE "commitments" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "commitments" ADD COLUMN "closed_batch" uuid;--> statement-breakpoint
ALTER TABLE "commitments" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "condition_definitions" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "condition_definitions" ADD COLUMN "closed_from_status" text;--> statement-breakpoint
ALTER TABLE "condition_definitions" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "condition_definitions" ADD COLUMN "closed_batch" uuid;--> statement-breakpoint
ALTER TABLE "condition_definitions" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "deliverables" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliverables" ADD COLUMN "closed_from_status" text;--> statement-breakpoint
ALTER TABLE "deliverables" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "deliverables" ADD COLUMN "closed_batch" uuid;--> statement-breakpoint
ALTER TABLE "deliverables" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "outcomes" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outcomes" ADD COLUMN "closed_from_status" text;--> statement-breakpoint
ALTER TABLE "outcomes" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "outcomes" ADD COLUMN "closed_batch" uuid;--> statement-breakpoint
ALTER TABLE "outcomes" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "closed_from_status" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "closed_batch" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "routine_presets" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routine_presets" ADD COLUMN "closed_from_status" text;--> statement-breakpoint
ALTER TABLE "routine_presets" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "routine_presets" ADD COLUMN "closed_batch" uuid;--> statement-breakpoint
ALTER TABLE "routine_presets" ADD COLUMN "closed_reason" text;
-- Closed-record stamping (archive-removals design, section 5). Reverse: DROP TRIGGER stamp_closed_columns ON each table
-- below, DROP FUNCTION stamp_closed_columns(), then DROP the five closed_* columns from each table.
-- Rows already closed: closed_at = updated_at; closed_from_status and closed_by stay NULL ("unknown"). The triggers
-- are created AFTER this backfill, so it fires no transition.
UPDATE "areas" SET "closed_at" = "updated_at" WHERE "status"::text IN ('archived','cancelled') AND "closed_at" IS NULL;--> statement-breakpoint
UPDATE "outcomes" SET "closed_at" = "updated_at" WHERE "status"::text IN ('archived','cancelled') AND "closed_at" IS NULL;--> statement-breakpoint
UPDATE "projects" SET "closed_at" = "updated_at" WHERE "status"::text IN ('archived','cancelled') AND "closed_at" IS NULL;--> statement-breakpoint
UPDATE "actions" SET "closed_at" = "updated_at" WHERE "status"::text IN ('archived','cancelled') AND "closed_at" IS NULL;--> statement-breakpoint
UPDATE "deliverables" SET "closed_at" = "updated_at" WHERE "status"::text IN ('archived','cancelled') AND "closed_at" IS NULL;--> statement-breakpoint
UPDATE "commitments" SET "closed_at" = "updated_at" WHERE "status"::text IN ('cancelled') AND "closed_at" IS NULL;--> statement-breakpoint
UPDATE "routine_presets" SET "closed_at" = "updated_at" WHERE "status"::text IN ('archived') AND "closed_at" IS NULL;--> statement-breakpoint
UPDATE "condition_definitions" SET "closed_at" = "updated_at" WHERE "status"::text IN ('archived') AND "closed_at" IS NULL;--> statement-breakpoint
-- Entering a closed status stamps closed_at (now), closed_from_status (OLD.status) and closed_by (the
-- priorities.actor setting, 'system' when unset); leaving it nulls all five. An INSERT or a transition that arrives
-- with closed_at already set (replaceState, fixtures, ledger undo of a restore) keeps its closed_* values.
-- closed_batch and closed_reason are written by the close command in the same statement and kept as given.
CREATE FUNCTION "stamp_closed_columns"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  closed_values text[] := string_to_array(TG_ARGV[0], ',');
  new_closed boolean := NEW.status::text = ANY (closed_values);
  old_closed boolean := false;
  actor text := COALESCE(NULLIF(current_setting('priorities.actor', true), ''), 'system');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_closed := OLD.status::text = ANY (closed_values);
  END IF;
  IF new_closed THEN
    IF TG_OP = 'INSERT' OR NOT old_closed THEN
      IF NEW.closed_at IS NULL THEN
        NEW.closed_at := now();
        NEW.closed_from_status := CASE WHEN TG_OP = 'UPDATE' THEN OLD.status::text ELSE NULL END;
        NEW.closed_by := COALESCE(NEW.closed_by, actor);
      END IF;
    END IF;
  ELSIF old_closed THEN
    NEW.closed_at := NULL;
    NEW.closed_from_status := NULL;
    NEW.closed_by := NULL;
    NEW.closed_batch := NULL;
    NEW.closed_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "stamp_closed_columns" BEFORE INSERT OR UPDATE ON "areas" FOR EACH ROW EXECUTE FUNCTION "stamp_closed_columns"('archived,cancelled');--> statement-breakpoint
CREATE TRIGGER "stamp_closed_columns" BEFORE INSERT OR UPDATE ON "outcomes" FOR EACH ROW EXECUTE FUNCTION "stamp_closed_columns"('archived,cancelled');--> statement-breakpoint
CREATE TRIGGER "stamp_closed_columns" BEFORE INSERT OR UPDATE ON "projects" FOR EACH ROW EXECUTE FUNCTION "stamp_closed_columns"('archived,cancelled');--> statement-breakpoint
CREATE TRIGGER "stamp_closed_columns" BEFORE INSERT OR UPDATE ON "actions" FOR EACH ROW EXECUTE FUNCTION "stamp_closed_columns"('archived,cancelled');--> statement-breakpoint
CREATE TRIGGER "stamp_closed_columns" BEFORE INSERT OR UPDATE ON "deliverables" FOR EACH ROW EXECUTE FUNCTION "stamp_closed_columns"('archived,cancelled');--> statement-breakpoint
CREATE TRIGGER "stamp_closed_columns" BEFORE INSERT OR UPDATE ON "commitments" FOR EACH ROW EXECUTE FUNCTION "stamp_closed_columns"('cancelled');--> statement-breakpoint
CREATE TRIGGER "stamp_closed_columns" BEFORE INSERT OR UPDATE ON "routine_presets" FOR EACH ROW EXECUTE FUNCTION "stamp_closed_columns"('archived');--> statement-breakpoint
CREATE TRIGGER "stamp_closed_columns" BEFORE INSERT OR UPDATE ON "condition_definitions" FOR EACH ROW EXECUTE FUNCTION "stamp_closed_columns"('archived');
