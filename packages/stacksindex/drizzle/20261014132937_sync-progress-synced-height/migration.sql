ALTER TABLE "sync_progress" RENAME COLUMN "lastBlockHeight" TO "syncedBlockHeight";--> statement-breakpoint
UPDATE "sync_progress" SET "syncedBlockHeight" = GREATEST("syncedBlockHeight" - 1, 0) WHERE "is_complete" = false;
