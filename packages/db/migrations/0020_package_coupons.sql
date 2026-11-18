CREATE TABLE "package_coupons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"percent_off" integer NOT NULL,
	"max_redemptions" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_by_id" uuid NOT NULL,
	"created_by_pool" "auth_pool" DEFAULT 'admins' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_coupons_code_unique" UNIQUE("code"),
	CONSTRAINT "package_coupons_code_format" CHECK ("package_coupons"."code" ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
	CONSTRAINT "package_coupons_percent_off_range" CHECK ("package_coupons"."percent_off" BETWEEN 1 AND 100),
	CONSTRAINT "package_coupons_max_redemptions_positive" CHECK ("package_coupons"."max_redemptions" > 0),
	CONSTRAINT "package_coupons_created_by_pool" CHECK ("package_coupons"."created_by_pool" = 'admins'),
	CONSTRAINT "package_coupons_note_length" CHECK ("package_coupons"."note" IS NULL OR char_length("package_coupons"."note") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "package_orders" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "package_orders" ADD COLUMN "coupon_code" text;--> statement-breakpoint
ALTER TABLE "package_orders" ADD COLUMN "discount_satang" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "package_coupons" ADD CONSTRAINT "package_coupons_created_by_admin_fk" FOREIGN KEY ("created_by_id","created_by_pool") REFERENCES "public"."users"("id","auth_pool") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_orders" ADD CONSTRAINT "package_orders_coupon_id_package_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."package_coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "package_orders_coupon_idx" ON "package_orders" USING btree ("coupon_id","created_at") WHERE "package_orders"."coupon_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "package_orders" ADD CONSTRAINT "package_orders_coupon_consistent" CHECK (("package_orders"."coupon_id" IS NULL) = ("package_orders"."coupon_code" IS NULL) AND ("package_orders"."coupon_id" IS NOT NULL OR "package_orders"."discount_satang" = 0));--> statement-breakpoint
ALTER TABLE "package_orders" ADD CONSTRAINT "package_orders_discount_nonnegative" CHECK ("package_orders"."discount_satang" >= 0);