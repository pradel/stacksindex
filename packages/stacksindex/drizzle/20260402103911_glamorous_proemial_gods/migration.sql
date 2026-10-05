CREATE TABLE "blocks" (
	"chainId" bigint NOT NULL,
	"height" bigint NOT NULL,
	"hash" varchar(66) NOT NULL,
	"blockTime" bigint NOT NULL,
	"tenureHeight" bigint NOT NULL,
	CONSTRAINT "blocks_pkey" PRIMARY KEY("chainId","height")
);
