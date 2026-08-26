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
