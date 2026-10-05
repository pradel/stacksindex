CREATE TABLE "transactions" (
	"chainId" bigint NOT NULL,
	"tx_id" text NOT NULL,
	"blockHeight" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_index" integer NOT NULL,
	"tx_type" text NOT NULL,
	"sender_address" text NOT NULL,
	"fee_rate" bigint NOT NULL,
	"nonce" bigint NOT NULL,
	"tx_status" text NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	CONSTRAINT "transactions_pkey" PRIMARY KEY("chainId","tx_id")
);
