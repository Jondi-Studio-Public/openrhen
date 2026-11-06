-- "I'm free": the instant the person released the rest of this occurrence to the planner. Additive and nullable, no default,
-- no backfill. Reverse: ALTER TABLE "commitments" DROP COLUMN "freed_from".
ALTER TABLE "commitments" ADD COLUMN "freed_from" timestamp with time zone;
