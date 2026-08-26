import type {
  BlockApiResponse,
  SmartContractLogEvent,
  TransactionApiResponse,
} from "../datasources/api/index.ts";
import type * as ponderSyncSchema from "./schema.js";

export const encodeBlock = ({
  block,
  chainId,
}: {
  block: BlockApiResponse;
  chainId: number;
}): typeof ponderSyncSchema.blocksTable.$inferInsert => ({
  chainId: BigInt(chainId),
  height: BigInt(block.height),
  hash: block.hash,
  blockTime: BigInt(block.burn_block_time),
  tenureHeight: BigInt(block.burn_block_height),
});

export const encodeTransaction = ({
  transaction,
  chainId,
}: {
  transaction: TransactionApiResponse;
  chainId: number;
}): typeof ponderSyncSchema.transactionsTable.$inferInsert => ({
  txId: transaction.tx_id,
  chainId: BigInt(chainId),
  blockHeight: BigInt("block_height" in transaction ? transaction.block_height : 0),
  blockHash: "block_hash" in transaction ? transaction.block_hash : "",
  txIndex: "tx_index" in transaction ? transaction.tx_index : 0,
  txType: transaction.tx_type,
  senderAddress: transaction.sender_address,
  feeRate: BigInt(transaction.fee_rate),
  nonce: BigInt(transaction.nonce),
  txStatus: transaction.tx_status,
  canonical: "canonical" in transaction ? transaction.canonical : false,
});

export const encodeEvent = ({
  event,
  chainId,
  blockHeight,
}: {
  event: SmartContractLogEvent;
  chainId: number;
  blockHeight: number;
}): typeof ponderSyncSchema.eventsTable.$inferInsert => ({
  chainId: BigInt(chainId),
  contractId: event.contract_log.contract_id,
  txId: event.tx_id,
  eventIndex: event.event_index,
  eventType: event.event_type,
  topic: event.contract_log.topic,
  valueHex: event.contract_log.value.hex,
  valueRepr: event.contract_log.value.repr,
  blockHeight: BigInt(blockHeight),
});
