CREATE TABLE "pool" (
	"address" text NOT NULL,
	"chainId" bigint NOT NULL,
	"token_x" text,
	"token_y" text,
	"balanceX" bigint NOT NULL,
	"balanceY" bigint NOT NULL,
	"totalSupply" bigint NOT NULL,
	"feeRateX" bigint NOT NULL,
	"feeRateY" bigint NOT NULL,
	"fee_to_address" text NOT NULL,
	"oracle_enabled" boolean NOT NULL,
	"createdAt" bigint NOT NULL,
	CONSTRAINT "pool_address_chainId_pk" PRIMARY KEY("address","chainId")
);
--> statement-breakpoint
CREATE TABLE "swap" (
	"tx_id" text NOT NULL,
	"chainId" bigint NOT NULL,
	"event_index" integer NOT NULL,
	"pool_address" text NOT NULL,
	"action" text NOT NULL,
	"amountIn" bigint NOT NULL,
	"amountOut" bigint NOT NULL,
	"blockHeight" bigint NOT NULL,
	"blockTime" bigint NOT NULL,
	CONSTRAINT "swap_tx_id_chainId_event_index_pk" PRIMARY KEY("tx_id","chainId","event_index")
);
--> statement-breakpoint
CREATE TABLE "token" (
	"address" text NOT NULL,
	"chainId" bigint NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	CONSTRAINT "token_address_chainId_pk" PRIMARY KEY("address","chainId")
);
