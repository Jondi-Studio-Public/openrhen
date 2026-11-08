CREATE TABLE "derived_lineage" (
	"user_id" uuid NOT NULL,
	"derived_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	CONSTRAINT "derived_lineage_derived_id_source_id_pk" PRIMARY KEY("derived_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "extractor_state" (
	"user_id" uuid NOT NULL,
	"extractor" text NOT NULL,
	"version" text NOT NULL,
	"cursor" jsonb,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"active" boolean DEFAULT false NOT NULL,
	CONSTRAINT "extractor_state_user_id_extractor_version_pk" PRIMARY KEY("user_id","extractor","version")
);
--> statement-breakpoint
ALTER TABLE "derived_lineage" ADD CONSTRAINT "derived_lineage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_lineage" ADD CONSTRAINT "derived_lineage_derived_id_activity_events_id_fk" FOREIGN KEY ("derived_id") REFERENCES "public"."activity_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_lineage" ADD CONSTRAINT "derived_lineage_source_id_activity_events_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."activity_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractor_state" ADD CONSTRAINT "extractor_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "derived_lineage_source_idx" ON "derived_lineage" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extractor_state_one_active_idx" ON "extractor_state" USING btree ("user_id","extractor") WHERE "extractor_state"."active";--> statement-breakpoint
CREATE INDEX "activity_events_user_source_ingested_idx" ON "activity_events" USING btree ("user_id","source","ingested_at");