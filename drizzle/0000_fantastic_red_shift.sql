CREATE TABLE "app_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intervention_telemetry" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"student_user_id" text,
	"teacher_user_id" text,
	"event_type" text NOT NULL,
	"intervention_type" text NOT NULL,
	"detail_level" text NOT NULL,
	"policy_name" text NOT NULL,
	"exercise_key" text,
	"blocked" boolean DEFAULT false NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"context_summary" text DEFAULT '' NOT NULL,
	"policy_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "student_exercise_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"student_user_id" text NOT NULL,
	"exercise_key" text NOT NULL,
	"hint_count" integer DEFAULT 0 NOT NULL,
	"last_intervention_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_exercise_progress_student_user_exercise_unique" UNIQUE("student_user_id","exercise_key")
);
--> statement-breakpoint
CREATE TABLE "teacher_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"teacher_user_id" text NOT NULL,
	"policy_name" text NOT NULL,
	"outcome" text NOT NULL,
	"tone" text NOT NULL,
	"frequency" text NOT NULL,
	"help_level" text NOT NULL,
	"allow_mini_quiz" boolean DEFAULT true NOT NULL,
	"strict_no_solution" boolean DEFAULT true NOT NULL,
	"max_hints_per_exercise" integer,
	"fallback_message" text NOT NULL,
	"custom_instruction" text DEFAULT '' NOT NULL,
	"allowed_interventions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"event_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teacher_policies_teacher_user_id_unique" UNIQUE("teacher_user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"teacher_user_id" text,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_telemetry" ADD CONSTRAINT "intervention_telemetry_session_id_app_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."app_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_telemetry" ADD CONSTRAINT "intervention_telemetry_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_telemetry" ADD CONSTRAINT "intervention_telemetry_teacher_user_id_users_id_fk" FOREIGN KEY ("teacher_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_exercise_progress" ADD CONSTRAINT "student_exercise_progress_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_policies" ADD CONSTRAINT "teacher_policies_teacher_user_id_users_id_fk" FOREIGN KEY ("teacher_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_teacher_user_id_users_id_fk" FOREIGN KEY ("teacher_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;