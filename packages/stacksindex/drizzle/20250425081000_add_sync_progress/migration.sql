CREATE TABLE "sync_progress" (
	"chainId" bigint NOT NULL,
	"contract_id" text NOT NULL,
	"cursor" text NOT NULL,
	"lastBlockHeight" bigint NOT NULL,
	CONSTRAINT "sync_progress_pkey" PRIMARY KEY("chainId","contract_id")
);
