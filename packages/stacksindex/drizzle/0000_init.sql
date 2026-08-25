CREATE TABLE "blocks" (
	"chainId" bigint NOT NULL,
	"height" bigint NOT NULL,
	"hash" varchar(66) NOT NULL,
	"blockTime" bigint NOT NULL,
	"tenureHeight" bigint NOT NULL,
	CONSTRAINT "blocks_pkey" PRIMARY KEY("chainId","height")
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"chainId" bigint NOT NULL,
	"blockHeight" bigint NOT NULL,
	"blockTime" bigint NOT NULL,
	CONSTRAINT "checkpoints_pkey" PRIMARY KEY("chainId")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"chainId" bigint NOT NULL,
	"contract_id" text NOT NULL,
	"tx_id" text NOT NULL,
	"event_index" integer NOT NULL,
	"event_type" text NOT NULL,
	"topic" text NOT NULL,
	"value_hex" text NOT NULL,
	"value_repr" text NOT NULL,
	"blockHeight" bigint NOT NULL,
	CONSTRAINT "events_pkey" PRIMARY KEY("chainId","tx_id","event_index")
);
--> statement-breakpoint
CREATE TABLE "sync_progress" (
	"chainId" bigint NOT NULL,
	"contract_id" text NOT NULL,
	"cursor" text NOT NULL,
	"lastBlockHeight" bigint NOT NULL,
	CONSTRAINT "sync_progress_pkey" PRIMARY KEY("chainId","contract_id")
);
--> statement-breakpoint
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
