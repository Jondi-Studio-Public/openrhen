CREATE TABLE "derived_model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_event_key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"tier" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "derived_model_calls_tier_check" CHECK ("derived_model_calls"."tier" IN ('t2', 't3')),
	CONSTRAINT "derived_model_calls_tokens_check" CHECK ("derived_model_calls"."tokens_in" >= 0 AND "derived_model_calls"."tokens_out" >= 0),
	CONSTRAINT "derived_model_calls_short_text_check" CHECK (length("derived_model_calls"."source_event_key") <= 512 AND length("derived_model_calls"."model") <= 200 AND length("derived_model_calls"."reason") <= 200)
);
--> statement-breakpoint
CREATE TABLE "derived_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"ollama_url" text,
	"t2_model" text,
	"t3_model" text,
	"t3_daily_message_cap" integer DEFAULT 50 NOT NULL,
	"t3_daily_token_cap" integer DEFAULT 200000 NOT NULL,
	"backfill_days" integer DEFAULT 90 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "derived_settings_t3_message_cap_check" CHECK ("derived_settings"."t3_daily_message_cap" BETWEEN 0 AND 10000),
	CONSTRAINT "derived_settings_t3_token_cap_check" CHECK ("derived_settings"."t3_daily_token_cap" BETWEEN 0 AND 100000000),
	CONSTRAINT "derived_settings_backfill_days_check" CHECK ("derived_settings"."backfill_days" BETWEEN 1 AND 3650),
	CONSTRAINT "derived_settings_ollama_url_check" CHECK (length("derived_settings"."ollama_url") <= 2048),
	CONSTRAINT "derived_settings_t2_model_check" CHECK (length("derived_settings"."t2_model") <= 200),
	CONSTRAINT "derived_settings_t3_model_check" CHECK (length("derived_settings"."t3_model") <= 200)
);
--> statement-breakpoint
ALTER TABLE "derived_model_calls" ADD CONSTRAINT "derived_model_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_settings" ADD CONSTRAINT "derived_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "derived_model_calls_user_at_idx" ON "derived_model_calls" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "activity_events_fact_id_idx" ON "activity_events" USING btree ("user_id",("attrs"->>'fact_id')) WHERE "activity_events"."kind" = 'fact';--> statement-breakpoint
CREATE INDEX "activity_events_derived_idx" ON "activity_events" USING btree ("user_id","source","kind") WHERE "activity_events"."source" IN ('derived', 'derived-shadow');

--> statement-breakpoint
-- Append-only: an UPDATE of a model-call audit row is refused. DELETE stays possible (the user cascade) and so does
-- TRUNCATE (restore and the test harness clear every backup table). Same shape as activity_events.
-- Reverse: DROP TRIGGER derived_model_calls_no_update ON derived_model_calls; DROP FUNCTION reject_derived_model_call_update();
CREATE FUNCTION "reject_derived_model_call_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'derived_model_calls is append-only: rows are never updated. Write a new row instead.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "derived_model_calls_no_update" BEFORE UPDATE ON "derived_model_calls" FOR EACH ROW EXECUTE FUNCTION "reject_derived_model_call_update"();
