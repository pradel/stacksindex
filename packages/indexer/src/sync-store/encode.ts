import type {
  BlockApiResponse,
  ContractLog,
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
  blockHeight: BigInt(transaction.block_height),
  blockHash: transaction.block_hash,
  txIndex: transaction.tx_index,
  txType: transaction.tx_type,
  senderAddress: transaction.sender_address,
  feeRate: BigInt(transaction.fee_rate),
  nonce: BigInt(transaction.nonce),
  txStatus: transaction.tx_status,
  canonical: transaction.canonical,
});

export const encodeEvent = ({
  event,
  chainId,
  blockHeight,
}: {
  event: ContractLog;
  chainId: number;
  blockHeight: number;
}): typeof ponderSyncSchema.eventsTable.$inferInsert => ({
  chainId: BigInt(chainId),
  contractId: event.contract_id,
  txId: event.tx_id,
  eventIndex: event.event_index,
  eventType: event.event_type,
  topic: event.topic,
  valueHex: event.value?.hex ?? "",
  valueRepr: event.value?.repr ?? "",
  blockHeight: BigInt(blockHeight),
});
