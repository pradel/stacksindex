CREATE TABLE "swap" (
	"tx_id" text NOT NULL,
	"chainId" bigint NOT NULL,
	"amountIn" bigint NOT NULL,
	"amountOut" bigint NOT NULL,
	CONSTRAINT "swap_tx_id_chainId_pk" PRIMARY KEY("tx_id","chainId")
);
--> statement-breakpoint
CREATE TABLE "token" (
	"address" text NOT NULL,
	"chainId" bigint NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	CONSTRAINT "token_address_chainId_pk" PRIMARY KEY("address","chainId")
);
