ALTER TABLE "check_in" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "check_in" ADD COLUMN "occurred_note" text;--> statement-breakpoint
ALTER TABLE "session_segments" ADD COLUMN "start_occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_segments" ADD COLUMN "start_occurred_note" text;--> statement-breakpoint
ALTER TABLE "session_segments" ADD COLUMN "end_occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_segments" ADD COLUMN "end_occurred_note" text;