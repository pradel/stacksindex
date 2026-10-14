CREATE TABLE "sync_anchors" (
	"chainId" bigint PRIMARY KEY,
	"blockHeight" bigint NOT NULL,
	"blockHash" varchar(66) NOT NULL
);
