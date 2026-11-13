-- ADR 0016 (events): a share can be unpublished and published again with the same link.
-- Additive and safe with the previous api release still running: one nullable ADD COLUMN without
-- a default (no table rewrite); the previous release never reads or writes it.
ALTER TABLE "shares" ADD COLUMN "paused_at" timestamp with time zone;
