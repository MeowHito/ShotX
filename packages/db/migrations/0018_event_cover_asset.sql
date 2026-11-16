-- ADR 0028 (owner, 2026-11-16): an uploaded event cover. folders.cover_asset_id names a design
-- image (design_assets) the photographer uploaded for the event, cropped to 2:3 in the browser.
-- Additive: a nullable column, its same-owner foreign key and a partial index.
--
-- Hand-edited after drizzle-kit generate: ON DELETE SET NULL ("cover_asset_id") only, so deleting
-- a design image clears the cover and never touches owner_id (drizzle can't express the column
-- list; as for folders_cover_file_same_owner_fk in 0012).
ALTER TABLE "folders" ADD COLUMN "cover_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_cover_asset_same_owner_fk" FOREIGN KEY ("cover_asset_id","owner_id") REFERENCES "public"."design_assets"("id","owner_id") ON DELETE SET NULL ("cover_asset_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folders_cover_asset_idx" ON "folders" USING btree ("cover_asset_id","owner_id") WHERE "folders"."cover_asset_id" IS NOT NULL;
