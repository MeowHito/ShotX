-- ADR 0008: identity columns renamed for API-issued tokens (the admin CHECK follows the rename),
-- refresh sessions and admin credentials, and anonymous auth events in audit_log.
ALTER TABLE "users" RENAME COLUMN "cognito_pool" TO "auth_pool";
--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "cognito_sub" TO "auth_subject";
--> statement-breakpoint
ALTER TABLE "users" RENAME CONSTRAINT "users_cognito_identity_unique" TO "users_auth_identity_unique";
--> statement-breakpoint
ALTER TABLE "users" RENAME CONSTRAINT "users_cognito_sub_not_empty" TO "users_auth_subject_not_empty";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_id_auth_pool_unique" UNIQUE("id","auth_pool");
--> statement-breakpoint
CREATE UNIQUE INDEX "users_admin_email_unique" ON "users" USING btree (lower("email" COLLATE "C")) WHERE "users"."auth_pool" = 'admins' AND "users"."auth_subject" LIKE 'admin:%';
--> statement-breakpoint
CREATE TABLE "admin_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"auth_pool" "auth_pool" DEFAULT 'admins' NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_encrypted" "bytea" NOT NULL,
	"totp_secret_nonce" "bytea" NOT NULL,
	"totp_confirmed_at" timestamp with time zone,
	"totp_last_used_step" bigint,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_credentials_admins_pool" CHECK ("admin_credentials"."auth_pool" = 'admins'),
	CONSTRAINT "admin_credentials_password_argon2id" CHECK ("admin_credentials"."password_hash" LIKE '$argon2id$%'),
	CONSTRAINT "admin_credentials_totp_sizes" CHECK (octet_length("admin_credentials"."totp_secret_nonce") = 12 AND octet_length("admin_credentials"."totp_secret_encrypted") BETWEEN 17 AND 1024),
	CONSTRAINT "admin_credentials_counters_valid" CHECK ("admin_credentials"."failed_attempts" >= 0 AND ("admin_credentials"."totp_last_used_step" IS NULL OR "admin_credentials"."totp_last_used_step" >= 0))
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"pool" "auth_pool" NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash"),
	CONSTRAINT "auth_sessions_hash_format" CHECK ("auth_sessions"."refresh_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_sessions_expiry_order" CHECK ("auth_sessions"."expires_at" > "auth_sessions"."created_at"),
	CONSTRAINT "auth_sessions_replaced_is_revoked" CHECK ("auth_sessions"."replaced_by_id" IS NULL OR ("auth_sessions"."revoked_at" IS NOT NULL AND "auth_sessions"."replaced_by_id" <> "auth_sessions"."id"))
);
--> statement-breakpoint
ALTER TABLE "admin_credentials" ADD CONSTRAINT "admin_credentials_admin_user_fk" FOREIGN KEY ("user_id","auth_pool") REFERENCES "public"."users"("id","auth_pool") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_replaced_by_id_auth_sessions_id_fk" FOREIGN KEY ("replaced_by_id") REFERENCES "public"."auth_sessions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_pool_fk" FOREIGN KEY ("user_id","pool") REFERENCES "public"."users"("id","auth_pool") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "auth_sessions_family_idx" ON "auth_sessions" USING btree ("family_id");
--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "actor_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_unless_auth_event" CHECK ("audit_log"."actor_id" IS NOT NULL OR "audit_log"."action" LIKE 'auth.%');
