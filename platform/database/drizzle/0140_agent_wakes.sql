CREATE TABLE "agent_wakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event" text NOT NULL,
	"target_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_wakes_event_check" CHECK ("agent_wakes"."event" IN ('check_in_unanswered','pulse_lapsed')),
	CONSTRAINT "agent_wakes_status_check" CHECK ("agent_wakes"."status" IN ('pending','sent','dead'))
);
--> statement-breakpoint
ALTER TABLE "agent_wakes" ADD CONSTRAINT "agent_wakes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wakes_user_dedupe_unique" ON "agent_wakes" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "agent_wakes_status_created_idx" ON "agent_wakes" USING btree ("status","created_at");