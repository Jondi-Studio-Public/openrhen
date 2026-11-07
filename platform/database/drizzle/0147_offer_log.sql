CREATE TABLE "offer_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"recommendation_id" uuid,
	"surface" text DEFAULT 'server' NOT NULL,
	"resolution_kind" text,
	"target_type" text,
	"target_id" text,
	"execution_option_id" text,
	"label" text,
	"rank" smallint,
	"rank_basis" text,
	"candidates" jsonb,
	"valid_until" timestamp with time zone,
	"actor" text,
	"command_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "offer_log_event_check" CHECK ("offer_log"."event" IN ('offered','shown','started','skipped','did_not_start','blocked','snoozed','checked_in')),
	CONSTRAINT "offer_log_surface_check" CHECK ("offer_log"."surface" IN ('server','portal','handheld')),
	CONSTRAINT "offer_log_rank_basis_check" CHECK ("offer_log"."rank_basis" IS NULL OR "offer_log"."rank_basis" IN ('offered_row','none')),
	CONSTRAINT "offer_log_rank_check" CHECK ("offer_log"."rank" IS NULL OR "offer_log"."rank" >= 1)
);
--> statement-breakpoint
ALTER TABLE "offer_log" ADD CONSTRAINT "offer_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_log_user_time_idx" ON "offer_log" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "offer_log_user_event_time_idx" ON "offer_log" USING btree ("user_id","event","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "offer_log_command_event_target_idx" ON "offer_log" USING btree ("command_id","event","target_id") WHERE "offer_log"."command_id" IS NOT NULL;