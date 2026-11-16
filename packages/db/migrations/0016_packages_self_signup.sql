-- ADR 0026: time-boxed packages, self sign-up and online payment (mpay). Additive and safe with
-- the previous api release running: three new tables and an enum (the previous release never
-- reads or writes them), and the audit_log actor CHECK relaxed (same name) so `package.` gateway
-- events may have no actor; every existing row satisfies the wider rule. plans, subscriptions and
-- payments are untouched. The five packages are seeded at the end (prices VAT-exclusive satang;
-- ON CONFLICT DO NOTHING, so re-running never overwrites prices edited in the DB).
CREATE TYPE "public"."package_order_status" AS ENUM('pending', 'paid', 'failed', 'amount_mismatch');--> statement-breakpoint
CREATE TABLE "package_orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"package_id" uuid NOT NULL,
	"photographer_id" uuid,
	"email" text NOT NULL,
	"name" text,
	"price_satang" integer NOT NULL,
	"vat_satang" integer NOT NULL,
	"total_satang" integer NOT NULL,
	"vat_rate_basis_points" integer NOT NULL,
	"gateway" text NOT NULL,
	"gateway_ref" text,
	"redirect_url" text,
	"status" "package_order_status" DEFAULT 'pending' NOT NULL,
	"access_token_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_sha256" text NOT NULL,
	"account_created" boolean DEFAULT false NOT NULL,
	"paid_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_orders_gateway_ref_unique" UNIQUE("gateway","gateway_ref"),
	CONSTRAINT "package_orders_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "package_orders_amounts_valid" CHECK ("package_orders"."price_satang" >= 0 AND "package_orders"."vat_satang" >= 0 AND "package_orders"."total_satang" >= 0),
	CONSTRAINT "package_orders_total_is_price_plus_vat" CHECK ("package_orders"."total_satang" = "package_orders"."price_satang" + "package_orders"."vat_satang"),
	CONSTRAINT "package_orders_vat_rate_valid" CHECK ("package_orders"."vat_rate_basis_points" BETWEEN 0 AND 10000),
	CONSTRAINT "package_orders_gateway_format" CHECK ("package_orders"."gateway" ~ '^[a-z0-9_]{1,32}$'),
	CONSTRAINT "package_orders_gateway_ref_valid" CHECK ("package_orders"."gateway_ref" IS NULL OR char_length("package_orders"."gateway_ref") BETWEEN 1 AND 255),
	CONSTRAINT "package_orders_email_valid" CHECK (char_length("package_orders"."email") BETWEEN 3 AND 254 AND position('@' in "package_orders"."email") > 1),
	CONSTRAINT "package_orders_name_length" CHECK ("package_orders"."name" IS NULL OR char_length("package_orders"."name") BETWEEN 1 AND 200),
	CONSTRAINT "package_orders_access_token_hash_hex" CHECK ("package_orders"."access_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "package_orders_idempotency_key_format" CHECK ("package_orders"."idempotency_key" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "package_orders_request_sha256_hex" CHECK ("package_orders"."request_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "package_orders_paid_iff_applied" CHECK (("package_orders"."status" = 'paid') = ("package_orders"."paid_at" IS NOT NULL) AND ("package_orders"."status" = 'paid') = ("package_orders"."applied_at" IS NOT NULL)),
	CONSTRAINT "package_orders_applied_has_photographer" CHECK ("package_orders"."applied_at" IS NULL OR "package_orders"."photographer_id" IS NOT NULL),
	CONSTRAINT "package_orders_account_created_when_paid" CHECK (NOT "package_orders"."account_created" OR "package_orders"."status" = 'paid')
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"days" integer NOT NULL,
	"photo_limit" integer NOT NULL,
	"price_satang" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "packages_code_unique" UNIQUE("code"),
	CONSTRAINT "packages_code_format" CHECK ("packages"."code" ~ '^[a-z][a-z0-9_]{0,31}$'),
	CONSTRAINT "packages_name_length" CHECK (char_length("packages"."name") BETWEEN 1 AND 100),
	CONSTRAINT "packages_days_positive" CHECK ("packages"."days" > 0),
	CONSTRAINT "packages_photo_limit_positive" CHECK ("packages"."photo_limit" > 0),
	CONSTRAINT "packages_price_nonnegative" CHECK ("packages"."price_satang" >= 0),
	CONSTRAINT "packages_free_costs_nothing" CHECK ("packages"."code" <> 'free' OR "packages"."price_satang" = 0)
);
--> statement-breakpoint
CREATE TABLE "photographer_packages" (
	"photographer_id" uuid PRIMARY KEY NOT NULL,
	"photographer_pool" "auth_pool" DEFAULT 'users' NOT NULL,
	"package_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"photo_limit" integer NOT NULL,
	"photos_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photographer_packages_photographer_pool" CHECK ("photographer_packages"."photographer_pool" = 'users'),
	CONSTRAINT "photographer_packages_period_order" CHECK ("photographer_packages"."starts_at" < "photographer_packages"."expires_at"),
	CONSTRAINT "photographer_packages_photo_limit_positive" CHECK ("photographer_packages"."photo_limit" > 0),
	CONSTRAINT "photographer_packages_photos_used_nonnegative" CHECK ("photographer_packages"."photos_used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_unless_auth_event";--> statement-breakpoint
ALTER TABLE "package_orders" ADD CONSTRAINT "package_orders_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_orders" ADD CONSTRAINT "package_orders_photographer_id_users_id_fk" FOREIGN KEY ("photographer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photographer_packages" ADD CONSTRAINT "photographer_packages_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photographer_packages" ADD CONSTRAINT "photographer_packages_photographer_fk" FOREIGN KEY ("photographer_id","photographer_pool") REFERENCES "public"."users"("id","auth_pool") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "package_orders_photographer_created_idx" ON "package_orders" USING btree ("photographer_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "package_orders_email_idx" ON "package_orders" USING btree (lower("email" COLLATE "C"),"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "package_orders_pending_created_idx" ON "package_orders" USING btree ("created_at") WHERE "package_orders"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "photographer_packages_expires_idx" ON "photographer_packages" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_unless_auth_event" CHECK ("audit_log"."actor_id" IS NOT NULL OR "audit_log"."action" LIKE 'auth.%' OR "audit_log"."action" LIKE 'package.%');--> statement-breakpoint
INSERT INTO "packages" ("code", "name", "days", "photo_limit", "price_satang", "is_active", "sort_order") VALUES
	('free', 'Free', 3, 100, 0, true, 10),
	('d3', '3 Days', 3, 1000, 39900, true, 20),
	('d7', '7 Days', 7, 3000, 59900, true, 30),
	('d15', '15 Days', 15, 5000, 79900, true, 40),
	('d30', '30 Days', 30, 10000, 129900, true, 50)
ON CONFLICT ("code") DO NOTHING;
