CREATE TABLE IF NOT EXISTS "github_app_install_states" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"session_id" text REFERENCES "public"."app_sessions"("id") ON DELETE no action ON UPDATE no action,
	"user_id" text NOT NULL REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	"repo_full_name" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_install_states_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_app_install_states_state_idx" ON "github_app_install_states" USING btree ("state");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_app_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"user_id" text NOT NULL REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	"account_login" text DEFAULT '' NOT NULL,
	"account_type" text DEFAULT '' NOT NULL,
	"repository_selection" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_app_installations_user_updated_idx" ON "github_app_installations" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"session_id" text REFERENCES "public"."app_sessions"("id") ON DELETE no action ON UPDATE no action,
	"user_id" text NOT NULL REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	"repo_full_name" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_oauth_states_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_oauth_states_state_idx" ON "github_oauth_states" USING btree ("state");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_user_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	"account_login" text DEFAULT '' NOT NULL,
	"account_email" text DEFAULT '' NOT NULL,
	"access_token" text NOT NULL,
	"token_type" text DEFAULT 'bearer' NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_user_tokens_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_user_tokens_user_updated_idx" ON "github_user_tokens" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_repo_bootstrap_states" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	"repo_full_name" text NOT NULL,
	"is_bootstrapped" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_repo_bootstrap_states_user_repo_unique" UNIQUE("user_id","repo_full_name")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_repo_bootstrap_states_user_updated_idx" ON "github_repo_bootstrap_states" USING btree ("user_id","updated_at");
