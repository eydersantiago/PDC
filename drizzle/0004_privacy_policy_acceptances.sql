CREATE TABLE IF NOT EXISTS "privacy_policy_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	"policy_version" text NOT NULL,
	"policy_url" text DEFAULT '' NOT NULL,
	"accepted_user_agent" text DEFAULT '' NOT NULL,
	"accepted_ip" text DEFAULT '' NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_policy_acceptances_user_version_unique" UNIQUE("user_id","policy_version")
);
