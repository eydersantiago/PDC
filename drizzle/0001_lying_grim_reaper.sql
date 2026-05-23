CREATE TABLE "project_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"workspace_key" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"branch" text DEFAULT '' NOT NULL,
	"project_label" text DEFAULT '' NOT NULL,
	"snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"files_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics_json" jsonb DEFAULT '{"suggestionsReceived":0,"suggestionsAccepted":0,"errorsDetected":0,"quizzesTaken":0}'::jsonb NOT NULL,
	"saved_by" text DEFAULT 'manual' NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_memories_owner_workspace_unique" UNIQUE("owner_user_id","workspace_key")
);
--> statement-breakpoint
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;