CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"event_key" text NOT NULL,
	"device" text,
	"ts_start" timestamp with time zone NOT NULL,
	"ts_end" timestamp with time zone,
	"tz_offset_min" smallint,
	"approximate" boolean DEFAULT false NOT NULL,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content" text,
	"import_id" uuid,
	"ingested_via" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_events_time_order_check" CHECK ("activity_events"."ts_end" IS NULL OR "activity_events"."ts_end" >= "activity_events"."ts_start")
);
--> statement-breakpoint
CREATE TABLE "activity_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"filename" text NOT NULL,
	"sha256" text NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_source_state" (
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"content_enabled" boolean DEFAULT false NOT NULL,
	"retention_days" integer,
	"cursor" jsonb,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "activity_source_state_user_id_source_pk" PRIMARY KEY("user_id","source"),
	CONSTRAINT "activity_source_state_retention_check" CHECK ("activity_source_state"."retention_days" IS NULL OR "activity_source_state"."retention_days" >= 1)
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_import_id_activity_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."activity_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_imports" ADD CONSTRAINT "activity_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_source_state" ADD CONSTRAINT "activity_source_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_events_key_idx" ON "activity_events" USING btree ("user_id","source","event_key");--> statement-breakpoint
CREATE INDEX "activity_events_user_source_time_idx" ON "activity_events" USING btree ("user_id","source","ts_start");--> statement-breakpoint
CREATE INDEX "activity_events_import_idx" ON "activity_events" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "activity_events_thread_idx" ON "activity_events" USING btree ("user_id","source",("attrs"->>'thread_id'),"ts_start") WHERE "activity_events"."attrs" ? 'thread_id';--> statement-breakpoint
CREATE UNIQUE INDEX "activity_imports_user_sha_idx" ON "activity_imports" USING btree ("user_id","sha256");--> statement-breakpoint
CREATE INDEX "activity_imports_user_idx" ON "activity_imports" USING btree ("user_id","imported_at");
--> statement-breakpoint
-- Append-only: an UPDATE of an activity event is refused. DELETE stays possible (undo import, purge by source, retention
-- purge, the user cascade) and so does TRUNCATE (restore and the test harness clear every backup table).
-- Reverse: DROP TRIGGER activity_events_no_update ON activity_events; DROP FUNCTION reject_activity_event_update();
CREATE FUNCTION "reject_activity_event_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only: rows are never updated. Write a new row (kind "correction") instead.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "activity_events_no_update" BEFORE UPDATE ON "activity_events" FOR EACH ROW EXECUTE FUNCTION "reject_activity_event_update"();
