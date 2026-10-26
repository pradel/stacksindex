CREATE TABLE "pool_snapshot" (
	"pool_address" text,
	"chainId" bigint,
	"blockHeight" bigint,
	"blockTime" bigint NOT NULL,
	"balanceX" bigint NOT NULL,
	"balanceY" bigint NOT NULL,
	"totalSupply" bigint NOT NULL,
	CONSTRAINT "pool_snapshot_pkey" PRIMARY KEY("pool_address","chainId","blockHeight")
);
