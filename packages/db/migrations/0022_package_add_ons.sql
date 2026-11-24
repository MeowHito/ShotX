CREATE TYPE "public"."package_kind" AS ENUM('plan', 'days', 'photos');--> statement-breakpoint
ALTER TABLE "packages" DROP CONSTRAINT "packages_days_positive";--> statement-breakpoint
ALTER TABLE "packages" DROP CONSTRAINT "packages_photo_limit_positive";--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "kind" "package_kind" DEFAULT 'plan' NOT NULL;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_kind_terms" CHECK (("packages"."kind" = 'plan' AND "packages"."days" > 0 AND "packages"."photo_limit" > 0) OR ("packages"."kind" = 'days' AND "packages"."days" > 0 AND "packages"."photo_limit" = 0) OR ("packages"."kind" = 'photos' AND "packages"."days" = 0 AND "packages"."photo_limit" > 0));--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_free_is_plan" CHECK ("packages"."code" <> 'free' OR "packages"."kind" = 'plan');--> statement-breakpoint
INSERT INTO "packages" ("code", "name", "kind", "days", "photo_limit", "price_satang", "is_active", "sort_order") VALUES
	('day1', '+1 Day', 'days', 1, 0, 7900, true, 110),
	('day3', '+3 Days', 'days', 3, 0, 19900, true, 120),
	('day7', '+7 Days', 'days', 7, 0, 39900, true, 130),
	('photo1000', '+1,000 Photos', 'photos', 0, 1000, 19900, true, 210),
	('photo3000', '+3,000 Photos', 'photos', 0, 3000, 44900, true, 220),
	('photo5000', '+5,000 Photos', 'photos', 0, 5000, 64900, true, 230)
ON CONFLICT ("code") DO NOTHING;
