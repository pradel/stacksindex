CREATE TABLE "stacksindex"."blocks" (
	"chainId" bigint,
	"height" bigint,
	"hash" varchar(66) NOT NULL,
	"indexBlockHash" varchar(66) NOT NULL,
	"blockTime" bigint NOT NULL,
	"tenureHeight" bigint NOT NULL,
	CONSTRAINT "blocks_pkey" PRIMARY KEY("chainId","height")
);
--> statement-breakpoint
CREATE TABLE "stacksindex"."checkpoints" (
	"chainId" bigint PRIMARY KEY,
	"blockHeight" bigint NOT NULL,
	"blockTime" bigint NOT NULL,
	"finalizedBlockHeight" bigint DEFAULT 0 NOT NULL,
	"finalizedBlockTime" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stacksindex"."events" (
	"chainId" bigint,
	"contract_id" text NOT NULL,
	"tx_id" text,
	"event_index" integer,
	"event_type" text NOT NULL,
	"topic" text NOT NULL,
	"value_hex" text NOT NULL,
	"value_repr" text NOT NULL,
	"blockHeight" bigint NOT NULL,
	CONSTRAINT "events_pkey" PRIMARY KEY("chainId","tx_id","event_index")
);
--> statement-breakpoint
CREATE TABLE "stacksindex"."sync_anchors" (
	"chainId" bigint PRIMARY KEY,
	"blockHeight" bigint NOT NULL,
	"blockHash" varchar(66) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stacksindex"."sync_progress" (
	"chainId" bigint,
	"contract_id" text,
	"cursor" text,
	"syncedBlockHeight" bigint NOT NULL,
	"is_complete" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sync_progress_pkey" PRIMARY KEY("chainId","contract_id")
);
--> statement-breakpoint
CREATE TABLE "stacksindex"."transactions" (
	"chainId" bigint,
	"tx_id" text,
	"blockHeight" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_index" integer NOT NULL,
	"tx_type" text NOT NULL,
	"sender_address" text NOT NULL,
	"fee_rate" bigint NOT NULL,
	"nonce" bigint NOT NULL,
	"tx_status" text NOT NULL,
	CONSTRAINT "transactions_pkey" PRIMARY KEY("chainId","tx_id")
);
--> statement-breakpoint
CREATE INDEX "blocks_chain_id_hash_idx" ON "stacksindex"."blocks" ("chainId","hash");--> statement-breakpoint
CREATE INDEX "events_chain_id_block_height_idx" ON "stacksindex"."events" ("chainId","blockHeight");