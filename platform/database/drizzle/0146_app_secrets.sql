CREATE TABLE "app_secrets" (
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_secrets_user_id_name_pk" PRIMARY KEY("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "youtube_quota_use" (
	"user_id" uuid NOT NULL,
	"quota_date" date NOT NULL,
	"units_spent" integer DEFAULT 0 NOT NULL,
	"exhausted_at" timestamp with time zone,
	CONSTRAINT "youtube_quota_use_user_id_quota_date_pk" PRIMARY KEY("user_id","quota_date"),
	CONSTRAINT "youtube_quota_use_units_check" CHECK ("youtube_quota_use"."units_spent" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app_secrets" ADD CONSTRAINT "app_secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_quota_use" ADD CONSTRAINT "youtube_quota_use_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
