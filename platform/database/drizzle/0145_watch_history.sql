CREATE TABLE "video_info" (
	"video_id" text PRIMARY KEY NOT NULL,
	"duration_s" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unavailable" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"video_id" text NOT NULL,
	"watched_at" timestamp with time zone NOT NULL,
	"dup_index" integer DEFAULT 0 NOT NULL,
	"title" text,
	"channel" text,
	CONSTRAINT "watch_events_source_check" CHECK ("watch_events"."source" IN ('youtube_takeout','youtube_music_takeout')),
	CONSTRAINT "watch_events_kind_check" CHECK ("watch_events"."kind" IN ('watch','ad','post'))
);
--> statement-breakpoint
CREATE TABLE "watch_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"source" text DEFAULT 'youtube_takeout' NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_import_id_watch_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."watch_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_imports" ADD CONSTRAINT "watch_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_events_unique_idx" ON "watch_events" USING btree ("user_id","source","video_id","watched_at","dup_index");--> statement-breakpoint
CREATE INDEX "watch_events_user_time_idx" ON "watch_events" USING btree ("user_id","watched_at");--> statement-breakpoint
CREATE INDEX "watch_events_import_idx" ON "watch_events" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "watch_imports_user_idx" ON "watch_imports" USING btree ("user_id","imported_at");
