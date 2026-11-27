-- ADR 0033: the event screen design of a share (`/{slug}/display`).
-- - shares.display_design_id: nullable (null: the built-in screen), with a foreign key on
--   (display_design_id, owner_id) so a share can only use its owner's design.
-- Hand-edited after drizzle-kit generate: ON DELETE SET NULL ("display_design_id") (drizzle can't
-- express the column list; a plain SET NULL would also null owner_id), as in migration 0013.
ALTER TABLE "shares" ADD COLUMN "display_design_id" uuid;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_display_design_same_owner_fk" FOREIGN KEY ("display_design_id","owner_id") REFERENCES "public"."share_designs"("id","owner_id") ON DELETE SET NULL ("display_design_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shares_display_design_idx" ON "shares" USING btree ("display_design_id","owner_id") WHERE "shares"."display_design_id" IS NOT NULL;
