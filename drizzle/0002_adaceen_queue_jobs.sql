CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"model" text,
	"status" text NOT NULL,
	"input_json" jsonb NOT NULL,
	"min_vram_gb" integer,
	"assigned_worker_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_results" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"output_json" jsonb,
	"output_text" text,
	"worker_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_results_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"period" text NOT NULL,
	"jobs_count" integer DEFAULT 0 NOT NULL,
	"chars_in" integer DEFAULT 0 NOT NULL,
	"chars_out" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_user_period_unique" UNIQUE("user_id","period")
);
--> statement-breakpoint
CREATE TABLE "worker_nodes" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"hostname" text,
	"status" text DEFAULT 'online' NOT NULL,
	"vram_gb" integer,
	"supported_models" jsonb DEFAULT '[]'::jsonb,
	"max_parallel_jobs" integer,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_results" ADD CONSTRAINT "job_results_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
