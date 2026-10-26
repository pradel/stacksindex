CREATE TABLE "stacksindex"."block_sync_progress" (
	"chainId" bigint,
	"name" text,
	"interval" bigint NOT NULL,
	"startBlock" bigint NOT NULL,
	"syncedBlockHeight" bigint NOT NULL,
	"is_complete" boolean DEFAULT false NOT NULL,
	CONSTRAINT "block_sync_progress_pkey" PRIMARY KEY("chainId","name")
);
