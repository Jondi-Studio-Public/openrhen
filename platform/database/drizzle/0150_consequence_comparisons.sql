CREATE TABLE "consequence_comparisons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pool" text NOT NULL,
	"item_ids" text[] NOT NULL,
	"item_stars" smallint[] NOT NULL,
	"item_hashes" text[] NOT NULL,
	"ranking" text[],
	"tie" boolean DEFAULT false NOT NULL,
	"answered_by" text NOT NULL,
	"basis" text NOT NULL,
	"evidence" text,
	"question_wording" text NOT NULL,
	"asked_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "consequence_comparisons_pool_check" CHECK ("consequence_comparisons"."pool" in ('project','action')),
	CONSTRAINT "consequence_comparisons_answered_by_check" CHECK ("consequence_comparisons"."answered_by" in ('person','agent')),
	CONSTRAINT "consequence_comparisons_basis_check" CHECK ("consequence_comparisons"."basis" in ('stated','observed','inferred')),
	CONSTRAINT "consequence_comparisons_items_check" CHECK (cardinality("consequence_comparisons"."item_ids") between 2 and 4 and cardinality("consequence_comparisons"."item_stars") = cardinality("consequence_comparisons"."item_ids") and cardinality("consequence_comparisons"."item_hashes") = cardinality("consequence_comparisons"."item_ids")),
	CONSTRAINT "consequence_comparisons_ranking_check" CHECK (("consequence_comparisons"."tie" and "consequence_comparisons"."ranking" is null) or (not "consequence_comparisons"."tie" and "consequence_comparisons"."ranking" is not null and cardinality("consequence_comparisons"."ranking") = cardinality("consequence_comparisons"."item_ids") and "consequence_comparisons"."ranking" <@ "consequence_comparisons"."item_ids" and "consequence_comparisons"."item_ids" <@ "consequence_comparisons"."ranking"))
);
--> statement-breakpoint
CREATE TABLE "consequence_groups_issued" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pool" text NOT NULL,
	"item_ids" text[] NOT NULL,
	"wording" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"answered_comparison_id" uuid,
	CONSTRAINT "consequence_groups_issued_pool_check" CHECK ("consequence_groups_issued"."pool" in ('project','action')),
	CONSTRAINT "consequence_groups_issued_items_check" CHECK (cardinality("consequence_groups_issued"."item_ids") between 2 and 4),
	CONSTRAINT "consequence_groups_issued_answered_check" CHECK (("consequence_groups_issued"."answered_at" is null) = ("consequence_groups_issued"."answered_comparison_id" is null))
);
--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "consequence_refined" real;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "consequence_refined_for_stars" smallint;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "consequence_refined_as_of" date;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "consequence_refined" real;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "consequence_refined_for_stars" smallint;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "consequence_refined_as_of" date;--> statement-breakpoint
ALTER TABLE "consequence_comparisons" ADD CONSTRAINT "consequence_comparisons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consequence_comparisons" ADD CONSTRAINT "consequence_comparisons_group_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consequence_groups_issued"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consequence_groups_issued" ADD CONSTRAINT "consequence_groups_issued_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consequence_comparisons_idempotency_idx" ON "consequence_comparisons" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "consequence_comparisons_group_idx" ON "consequence_comparisons" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "consequence_comparisons_user_pool_idx" ON "consequence_comparisons" USING btree ("user_id","pool","answered_at");--> statement-breakpoint
CREATE INDEX "consequence_groups_issued_user_pool_idx" ON "consequence_groups_issued" USING btree ("user_id","pool","issued_at");--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_consequence_refined_check" CHECK (("actions"."consequence_refined" is null and "actions"."consequence_refined_for_stars" is null and "actions"."consequence_refined_as_of" is null) or ("actions"."consequence_refined" is not null and "actions"."consequence_refined_for_stars" is not null and "actions"."consequence_refined_as_of" is not null and "actions"."consequence_refined" between 0 and 6 and "actions"."consequence_refined_for_stars" between 1 and 5));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_consequence_refined_check" CHECK (("projects"."consequence_refined" is null and "projects"."consequence_refined_for_stars" is null and "projects"."consequence_refined_as_of" is null) or ("projects"."consequence_refined" is not null and "projects"."consequence_refined_for_stars" is not null and "projects"."consequence_refined_as_of" is not null and "projects"."consequence_refined" between 0 and 6 and "projects"."consequence_refined_for_stars" between 1 and 5));