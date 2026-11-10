ALTER TABLE "check_in" DROP CONSTRAINT "check_in_answer_source_check";--> statement-breakpoint
ALTER TABLE "check_in" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "check_in" ADD CONSTRAINT "check_in_tags_check" CHECK (jsonb_typeof("check_in"."tags") = 'array');--> statement-breakpoint
ALTER TABLE "check_in" ADD CONSTRAINT "check_in_answer_source_check" CHECK ("check_in"."answer_source" IS NULL OR "check_in"."answer_source" IN ('in_app_banner','sheet','push_action','widget','shortcut','app','session_reconciliation'));