-- ADR 0010: admin-provisioned accounts. Account status on users (who created it, last sign-in),
-- photographer password credentials (users pool), admin credentials without a TOTP secret until
-- the first sign-in enrols one (plus a temporary-password flag), one email per password account
-- across both pools, and the cash-payments ledger. Additive: existing rows get status 'active'
-- and keep their TOTP secrets; no `password:` subjects exist yet, so every new CHECK holds.
CREATE TYPE "public"."account_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "user_password_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"auth_pool" "auth_pool" DEFAULT 'users' NOT NULL,
	"password_hash" text NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_password_credentials_users_pool" CHECK ("user_password_credentials"."auth_pool" = 'users'),
	CONSTRAINT "user_password_credentials_password_argon2id" CHECK ("user_password_credentials"."password_hash" LIKE '$argon2id$%'),
	CONSTRAINT "user_password_credentials_failed_attempts_valid" CHECK ("user_password_credentials"."failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cash_payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"photographer_id" uuid NOT NULL,
	"photographer_pool" "auth_pool" DEFAULT 'users' NOT NULL,
	"amount_satang" integer NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"note" text,
	"recorded_by_id" uuid NOT NULL,
	"recorded_by_pool" "auth_pool" DEFAULT 'admins' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_payments_idempotency_unique" UNIQUE("recorded_by_id","idempotency_key"),
	CONSTRAINT "cash_payments_photographer_pool" CHECK ("cash_payments"."photographer_pool" = 'users'),
	CONSTRAINT "cash_payments_recorded_by_pool" CHECK ("cash_payments"."recorded_by_pool" = 'admins'),
	CONSTRAINT "cash_payments_amount_positive" CHECK ("cash_payments"."amount_satang" > 0),
	CONSTRAINT "cash_payments_note_length" CHECK ("cash_payments"."note" IS NULL OR char_length("cash_payments"."note") BETWEEN 1 AND 500),
	CONSTRAINT "cash_payments_paid_at_not_future" CHECK ("cash_payments"."paid_at" <= "cash_payments"."created_at" + interval '1 day'),
	CONSTRAINT "cash_payments_idempotency_key_format" CHECK ("cash_payments"."idempotency_key" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "cash_payments_request_sha256_hex" CHECK ("cash_payments"."request_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "admin_credentials" ALTER COLUMN "totp_secret_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_credentials" ALTER COLUMN "totp_secret_nonce" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "account_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "created_by_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_credentials" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_password_credentials" ADD CONSTRAINT "user_password_credentials_user_fk" FOREIGN KEY ("user_id","auth_pool") REFERENCES "public"."users"("id","auth_pool") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_payments" ADD CONSTRAINT "cash_payments_photographer_fk" FOREIGN KEY ("photographer_id","photographer_pool") REFERENCES "public"."users"("id","auth_pool") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_payments" ADD CONSTRAINT "cash_payments_recorded_by_admin_fk" FOREIGN KEY ("recorded_by_id","recorded_by_pool") REFERENCES "public"."users"("id","auth_pool") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_payments_photographer_paid_idx" ON "cash_payments" USING btree ("photographer_id","paid_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cash_payments_paid_idx" ON "cash_payments" USING btree ("paid_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_password_account_email_unique" ON "users" USING btree (lower("email" COLLATE "C")) WHERE ("users"."auth_pool" = 'admins' AND "users"."auth_subject" LIKE 'admin:%') OR ("users"."auth_pool" = 'users' AND "users"."auth_subject" LIKE 'password:%');--> statement-breakpoint
CREATE INDEX "users_accounts_created_idx" ON "users" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "users"."role" IN ('admin', 'photographer');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_disabled_at_iff_disabled" CHECK (("users"."status" = 'disabled') = ("users"."disabled_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_password_subject_photographer" CHECK ("users"."auth_subject" NOT LIKE 'password:%' OR ("users"."auth_pool" = 'users' AND "users"."role" = 'photographer'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_admin_subject_admins_pool" CHECK ("users"."auth_subject" NOT LIKE 'admin:%' OR "users"."auth_pool" = 'admins');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_password_account_has_email" CHECK ("users"."auth_subject" NOT LIKE 'password:%' OR "users"."email" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_not_created_by_self" CHECK ("users"."created_by_id" IS NULL OR "users"."created_by_id" <> "users"."id");--> statement-breakpoint
ALTER TABLE "admin_credentials" ADD CONSTRAINT "admin_credentials_totp_secret_complete" CHECK (("admin_credentials"."totp_secret_encrypted" IS NULL) = ("admin_credentials"."totp_secret_nonce" IS NULL));--> statement-breakpoint
ALTER TABLE "admin_credentials" ADD CONSTRAINT "admin_credentials_totp_state_needs_secret" CHECK (("admin_credentials"."totp_confirmed_at" IS NULL AND "admin_credentials"."totp_last_used_step" IS NULL) OR "admin_credentials"."totp_secret_encrypted" IS NOT NULL);