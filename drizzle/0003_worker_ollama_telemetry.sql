ALTER TABLE "worker_nodes" ADD COLUMN IF NOT EXISTS "worker_role" text;
--> statement-breakpoint
ALTER TABLE "worker_nodes" ADD COLUMN IF NOT EXISTS "observed_vram_gb" integer;
--> statement-breakpoint
ALTER TABLE "worker_nodes" ADD COLUMN IF NOT EXISTS "ollama_status" jsonb DEFAULT '{}'::jsonb;
