CREATE TYPE "public"."print_approval" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."print_order_status" AS ENUM('pending', 'queued', 'printed', 'rejected');--> statement-breakpoint
CREATE TABLE "print_orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"photographer_id" uuid NOT NULL,
	"order_number" integer NOT NULL,
	"share_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"anon_id" uuid NOT NULL,
	"viewer_id" uuid,
	"paper_size" text NOT NULL,
	"customer_name" text,
	"status" "print_order_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"printed_at" timestamp with time zone,
	"print_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "print_orders_number_unique" UNIQUE("photographer_id","order_number"),
	CONSTRAINT "print_orders_paper_size_valid" CHECK ("print_orders"."paper_size" IN ('4r', '5r', '6r', '8r', 'a5', 'a4')),
	CONSTRAINT "print_orders_order_number_positive" CHECK ("print_orders"."order_number" > 0),
	CONSTRAINT "print_orders_print_count_nonnegative" CHECK ("print_orders"."print_count" >= 0),
	CONSTRAINT "print_orders_customer_name_length" CHECK ("print_orders"."customer_name" IS NULL OR char_length("print_orders"."customer_name") BETWEEN 1 AND 60),
	CONSTRAINT "print_orders_printed_shape" CHECK (("print_orders"."status" = 'printed') = ("print_orders"."printed_at" IS NOT NULL AND "print_orders"."print_count" > 0))
);
--> statement-breakpoint
CREATE TABLE "print_settings" (
	"photographer_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"approval" "print_approval" DEFAULT 'manual' NOT NULL,
	"per_device_limit" integer DEFAULT 1 NOT NULL,
	"paper_sizes" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_settings_per_device_limit_range" CHECK ("print_settings"."per_device_limit" BETWEEN 1 AND 100),
	CONSTRAINT "print_settings_paper_sizes_valid" CHECK (cardinality("print_settings"."paper_sizes") >= 1 AND "print_settings"."paper_sizes" <@ ARRAY['4r', '5r', '6r', '8r', 'a5', 'a4']::text[])
);
--> statement-breakpoint
ALTER TABLE "print_orders" ADD CONSTRAINT "print_orders_photographer_id_users_id_fk" FOREIGN KEY ("photographer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_orders" ADD CONSTRAINT "print_orders_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_orders" ADD CONSTRAINT "print_orders_share_same_owner_fk" FOREIGN KEY ("share_id","photographer_id") REFERENCES "public"."shares"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_orders" ADD CONSTRAINT "print_orders_file_same_owner_fk" FOREIGN KEY ("file_id","photographer_id") REFERENCES "public"."files"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_settings" ADD CONSTRAINT "print_settings_photographer_id_users_id_fk" FOREIGN KEY ("photographer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "print_orders_share_device_idx" ON "print_orders" USING btree ("share_id","anon_id","created_at");--> statement-breakpoint
CREATE INDEX "print_orders_photographer_status_idx" ON "print_orders" USING btree ("photographer_id","status","created_at");