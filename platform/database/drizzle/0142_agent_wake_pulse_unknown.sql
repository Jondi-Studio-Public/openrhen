ALTER TABLE "agent_wakes" DROP CONSTRAINT "agent_wakes_event_check";--> statement-breakpoint
ALTER TABLE "agent_wakes" ADD CONSTRAINT "agent_wakes_event_check" CHECK ("agent_wakes"."event" IN ('check_in_unanswered','pulse_lapsed','pulse_unknown'));
