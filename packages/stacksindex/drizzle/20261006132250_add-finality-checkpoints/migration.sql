ALTER TABLE "checkpoints" ADD COLUMN "finalizedBlockHeight" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "finalizedBlockTime" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "checkpoints" SET "finalizedBlockHeight" = "blockHeight", "finalizedBlockTime" = "blockTime";
