import { Effect, Predicate } from "effect";

import type { ClarityJsonValue } from "../codec/index.ts";
import { type StacksApiError, StacksClient } from "../datasources/api/index.ts";
import { ConfigurationError, FilterValidationError } from "../lib/errors.ts";
import type { CoreHandler } from "../lib/types.ts";
import {
  type BlockDefinitions,
  type BlockSourceSpec,
  isBlockHeight,
  type ResolvedBlockSource,
  validateBlockDefinitions,
} from "./blocks.ts";

/** What to do with a print that does not match the contract's `print` schema. */
export type OnInvalid = "fail" | "skip";

/** Fields of a contract definition shared by both entrypoints. */
export interface ContractDefinitionBase {
  /** Fully qualified contract identifier (`<principal>.<contract-name>`). */
  readonly id: string;
  /** Start indexing from this block height. Defaults to the deployment block. */
  readonly startBlock?: number;
  /** Stop at this block height, or `"latest"` for the chain tip read when a run starts. */
  readonly endBlock?: number | "latest";
  /** Defaults to `"fail"`: a mismatching print fails the batch with `EventDecodeError`. */
  readonly onInvalid?: OnInvalid;
}

export interface DecodeIssue {
  readonly message: string;
  readonly cause?: unknown;
}

/** A contract as the runtime indexes it: definition, decoder and handler. */
export interface ContractSpec {
  /** Definition name (the key in `contracts`). */
  readonly name: string;
  readonly contractId: string;
  readonly startBlock?: number;
  readonly endBlock?: number | "latest";
  readonly onInvalid: OnInvalid;
  /** Parses the decoded print; `undefined` passes the Clarity JSON value through. */
  readonly decode?: (value: ClarityJsonValue) => Effect.Effect<unknown, DecodeIssue>;
  readonly handler: CoreHandler;
}

/** A contract spec whose `"latest"` end block has been resolved to a height. */
export interface ResolvedContract extends Omit<ContractSpec, "endBlock"> {
  readonly endBlock?: number;
}

const CONTRACT_ID = /^S[0-9A-Z]+\.[a-zA-Z][a-zA-Z0-9_-]*$/u;

/**
 * Checks a contract definition map, throwing `ConfigurationError` on the
 * first problem so mistakes surface when the definition module loads.
 */
export function validateContractDefinitions(
  contracts: Readonly<Record<string, ContractDefinitionBase>>,
): void {
  const names = Object.keys(contracts);
  const nameById = new Map<string, string>();

  for (const name of names) {
    const contract = contracts[name];

    const fail = (problem: string): never => {
      throw new ConfigurationError({ message: `contracts.${name}: ${problem}` });
    };

    if (!Predicate.isString(contract.id) || !CONTRACT_ID.test(contract.id)) {
      fail(
        `\`id\` must be a contract identifier like "SP….contract-name", got ${JSON.stringify(contract.id)}.`,
      );
    }

    const sameId = nameById.get(contract.id);

    if (sameId !== undefined) {
      fail(`\`id\` ${contract.id} is already indexed as contracts.${sameId}.`);
    }

    nameById.set(contract.id, name);

    if (contract.startBlock !== undefined && !isBlockHeight(contract.startBlock)) {
      fail(`\`startBlock\` must be a non-negative integer, got ${String(contract.startBlock)}.`);
    }

    if (
      contract.endBlock !== undefined &&
      contract.endBlock !== "latest" &&
      !isBlockHeight(contract.endBlock)
    ) {
      fail(
        `\`endBlock\` must be a non-negative integer or "latest", got ${String(contract.endBlock)}.`,
      );
    }

    if (
      contract.startBlock !== undefined &&
      Predicate.isNumber(contract.endBlock) &&
      contract.startBlock > contract.endBlock
    ) {
      fail(`\`startBlock\` (${contract.startBlock}) is after \`endBlock\` (${contract.endBlock}).`);
    }

    if (
      contract.onInvalid !== undefined &&
      contract.onInvalid !== "fail" &&
      contract.onInvalid !== "skip"
    ) {
      fail(`\`onInvalid\` must be "fail" or "skip", got ${JSON.stringify(contract.onInvalid)}.`);
    }
  }
}

/**
 * Checks a whole definition: its contracts, its block sources, that it has at
 * least one of them, and that every name is unique across both, since the
 * names key one `handlers` record.
 */
export function validateIndexerDefinition(definition: {
  readonly contracts?: Readonly<Record<string, ContractDefinitionBase>>;
  readonly blocks?: BlockDefinitions;
}): void {
  const contracts = definition.contracts ?? {};
  const blocks = definition.blocks ?? {};

  validateContractDefinitions(contracts);
  validateBlockDefinitions(blocks);

  const blockNames = Object.keys(blocks);

  if (Object.keys(contracts).length === 0 && blockNames.length === 0) {
    throw new ConfigurationError({
      message: "Define at least one contract in `contracts` or block source in `blocks`.",
    });
  }

  for (const name of blockNames) {
    if (Object.hasOwn(contracts, name)) {
      throw new ConfigurationError({
        message: `blocks.${name}: the name is already used by contracts.${name}; names must be unique across \`contracts\` and \`blocks\`.`,
      });
    }
  }
}

/** Contracts and block sources paired with their handlers, as the facades build them. */
export interface SourceSpecs {
  readonly contracts: ContractSpec[];
  readonly blocks: BlockSourceSpec[];
}

/** Contracts and block sources whose `"latest"` end blocks are resolved. */
export interface ResolvedSources {
  readonly contracts: ResolvedContract[];
  readonly blocks: ResolvedBlockSource[];
}

interface SourceRange {
  readonly name: string;
  readonly startBlock?: number;
  readonly endBlock?: number | "latest";
}

/**
 * Resolves `"latest"` end blocks to the chain tip read now, and re-checks
 * the start/end ordering against it.
 */
export function resolveSources(
  contracts: readonly ContractSpec[],
  blocks: readonly BlockSourceSpec[],
): Effect.Effect<ResolvedSources, StacksApiError | FilterValidationError, StacksClient> {
  return Effect.gen(function* () {
    let latestBlockHeight: number | undefined = undefined;

    if (
      contracts.some((contract) => contract.endBlock === "latest") ||
      blocks.some((source) => source.endBlock === "latest")
    ) {
      const client = yield* StacksClient;
      const status = yield* client.getStatus();
      latestBlockHeight = status.chain_tip?.block_height;

      if (latestBlockHeight === undefined) {
        return yield* new FilterValidationError({
          message: "Unable to determine the latest block height from the API status response.",
        });
      }

      yield* Effect.logInfo(`Resolved "latest" endBlock to block height ${latestBlockHeight}`).pipe(
        Effect.annotateLogs({ latestBlockHeight }),
      );
    }

    const resolveEndBlock = (
      kind: "contracts" | "blocks",
      source: SourceRange,
    ): Effect.Effect<number | undefined, FilterValidationError> => {
      const endBlock = source.endBlock === "latest" ? latestBlockHeight : source.endBlock;

      return source.startBlock !== undefined &&
        endBlock !== undefined &&
        source.startBlock > endBlock
        ? Effect.fail(
            new FilterValidationError({
              message: `Start block (${source.startBlock}) is after end block (${endBlock}) for ${kind}.${source.name}.`,
            }),
          )
        : Effect.succeed(endBlock);
    };

    const resolvedContracts: ResolvedContract[] = [];

    for (const contract of contracts) {
      resolvedContracts.push({
        ...contract,
        endBlock: yield* resolveEndBlock("contracts", contract),
      });
    }

    const resolvedBlocks: ResolvedBlockSource[] = [];

    for (const source of blocks) {
      resolvedBlocks.push({ ...source, endBlock: yield* resolveEndBlock("blocks", source) });
    }

    return { contracts: resolvedContracts, blocks: resolvedBlocks };
  });
}
