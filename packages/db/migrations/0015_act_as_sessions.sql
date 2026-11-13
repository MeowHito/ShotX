-- ADR 0018 (admin act-as): auth_sessions.acting_admin_id marks a photographer session opened by an
-- admin. Additive and safe with the previous api release running: a nullable ADD COLUMN without a
-- default (no rewrite) and a foreign key validated against the small auth_sessions table (rows
-- all null, so nothing to check). The previous release never writes it.
ALTER TABLE "auth_sessions" ADD COLUMN "acting_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_acting_admin_id_users_id_fk" FOREIGN KEY ("acting_admin_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;