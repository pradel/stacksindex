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
  blockHeight: BigInt(transaction.block.height),
  blockHash: transaction.block.hash,
  txIndex: transaction.block.tx_index,
  txType: transaction.type,
  senderAddress: transaction.sender.address,
  feeRate: BigInt(transaction.fee_rate),
  nonce: BigInt(transaction.sender.nonce),
  txStatus: transaction.status,
  canonical: typeof transaction.canonical === "boolean" ? transaction.canonical : true,
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
