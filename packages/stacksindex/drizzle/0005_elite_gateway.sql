ALTER TABLE "sync_progress" ALTER COLUMN "cursor" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_progress" ADD COLUMN "is_complete" boolean DEFAULT false NOT NULL;