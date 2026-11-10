CREATE TABLE "owner_credential_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"credential_id" uuid,
	"actor_credential_id" uuid,
	"label" text,
	"device_install_id" text,
	"platform" text,
	"address" text,
	CONSTRAINT "owner_credential_events_event_check" CHECK ("owner_credential_events"."event" IN ('pairing_started','code_started','code_approved','code_denied','redeemed','revoked'))
);
--> statement-breakpoint
CREATE TABLE "owner_device_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"flow" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"secret_hash" text NOT NULL,
	"user_code_hash" text,
	"name" text,
	"install_id" text,
	"platform" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"poll_interval_seconds" integer DEFAULT 5 NOT NULL,
	"created_by_credential_id" uuid,
	"credential_id" uuid,
	"created_from" text,
	CONSTRAINT "owner_device_pairings_flow_check" CHECK ("owner_device_pairings"."flow" IN ('pairing','code')),
	CONSTRAINT "owner_device_pairings_status_check" CHECK ("owner_device_pairings"."status" IN ('pending','approved','denied','redeemed')),
	CONSTRAINT "owner_device_pairings_hash_check" CHECK ("owner_device_pairings"."secret_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD COLUMN "device_install_id" text;--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD COLUMN "limited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD COLUMN "parent_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD COLUMN "last_used_from" text;--> statement-breakpoint
ALTER TABLE "owner_credential_events" ADD CONSTRAINT "owner_credential_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_credential_events" ADD CONSTRAINT "owner_credential_events_credential_id_owner_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."owner_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_credential_events" ADD CONSTRAINT "owner_credential_events_actor_credential_id_owner_credentials_id_fk" FOREIGN KEY ("actor_credential_id") REFERENCES "public"."owner_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_device_pairings" ADD CONSTRAINT "owner_device_pairings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_device_pairings" ADD CONSTRAINT "owner_device_pairings_created_by_credential_id_owner_credentials_id_fk" FOREIGN KEY ("created_by_credential_id") REFERENCES "public"."owner_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_device_pairings" ADD CONSTRAINT "owner_device_pairings_credential_id_owner_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."owner_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_credential_events_user_time_idx" ON "owner_credential_events" USING btree ("user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "owner_device_pairings_secret_idx" ON "owner_device_pairings" USING btree ("secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_device_pairings_user_code_idx" ON "owner_device_pairings" USING btree ("user_code_hash") WHERE "owner_device_pairings"."user_code_hash" IS NOT NULL AND "owner_device_pairings"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "owner_device_pairings_user_time_idx" ON "owner_device_pairings" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD CONSTRAINT "owner_credentials_parent_credential_id_owner_credentials_id_fk" FOREIGN KEY ("parent_credential_id") REFERENCES "public"."owner_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_credentials_parent_idx" ON "owner_credentials" USING btree ("parent_credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_credentials_live_child_idx" ON "owner_credentials" USING btree ("parent_credential_id") WHERE "owner_credentials"."parent_credential_id" IS NOT NULL AND "owner_credentials"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD CONSTRAINT "owner_credentials_device_check" CHECK ("owner_credentials"."device_install_id" IS NULL OR ("owner_credentials"."device_install_id" ~ '^[a-z0-9][a-z0-9_-]{7,63}$' AND "owner_credentials"."platform" ~ '^[a-z0-9_-]{1,16}$'));