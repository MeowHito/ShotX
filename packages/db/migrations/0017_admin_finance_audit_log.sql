-- ADR 0027: admin finance and the audit log viewer. Additive and safe with the previous api
-- release running: a new table and enum (`expenses`, `expense_category`; the previous release never
-- reads or writes them) and indexes for the finance and audit-log queries. The only DROP is
-- `audit_log_created_idx`, recreated under the same name as (created_at DESC, id DESC) for the
-- viewer's keyset; it serves every query the old (created_at) index did. No data is changed.
CREATE TYPE "public"."expense_category" AS ENUM('server', 'storage', 'payment_fee', 'domain', 'email', 'marketing', 'other');--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"spent_on" date NOT NULL,
	"amount_satang" integer NOT NULL,
	"category" "expense_category" NOT NULL,
	"note" text,
	"recorded_by_id" uuid NOT NULL,
	"recorded_by_pool" "auth_pool" DEFAULT 'admins' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "expenses_recorded_by_pool" CHECK ("expenses"."recorded_by_pool" = 'admins'),
	CONSTRAINT "expenses_amount_positive" CHECK ("expenses"."amount_satang" > 0),
	CONSTRAINT "expenses_note_length" CHECK ("expenses"."note" IS NULL OR char_length("expenses"."note") BETWEEN 1 AND 500),
	CONSTRAINT "expenses_spent_on_not_future" CHECK ("expenses"."spent_on" <= ("expenses"."created_at" AT TIME ZONE 'Asia/Bangkok')::date + 1),
	CONSTRAINT "expenses_deleted_after_created" CHECK ("expenses"."deleted_at" IS NULL OR "expenses"."deleted_at" >= "expenses"."created_at")
);
--> statement-breakpoint
DROP INDEX "audit_log_created_idx";--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recorded_by_admin_fk" FOREIGN KEY ("recorded_by_id","recorded_by_pool") REFERENCES "public"."users"("id","auth_pool") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_spent_on_idx" ON "expenses" USING btree ("spent_on" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "expenses"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action" text_pattern_ops,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_target_id_idx" ON "audit_log" USING btree ("target_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "package_orders_paid_idx" ON "package_orders" USING btree ("paid_at") WHERE "package_orders"."status" = 'paid';--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);