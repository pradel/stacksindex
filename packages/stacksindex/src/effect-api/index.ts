import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import { Context, Effect, Layer, Predicate, Schema } from "effect";

import type { ClarityJsonValue } from "../codec/index.ts";
import { IndexerDatabase, type IndexerDb } from "../database/index.ts";
import { HandlerClient } from "../indexing/client.ts";
import { ConfigurationError, type DatabaseError, type MigrationError } from "../lib/errors.ts";
import type { BlockEvent, IndexingClient, PrintEvent } from "../lib/types.ts";
import type { BlockDefinitions } from "../runtime/blocks.ts";
import type { IndexerRuntimeOptions } from "../runtime/config.ts";
import {
  type ContractDefinitionBase,
  type DecodeIssue,
  type SourceSpecs,
  validateIndexerDefinition,
} from "../runtime/contracts.ts";
import { Indexer } from "../runtime/index.ts";

/** A contract to index. */
export interface ContractDefinition extends ContractDefinitionBase {
  /**
   * Schema parsing every print into `event.data`. Without it, `data` is the
   * decoded Clarity value. A mismatch fails with `EventDecodeError` unless
   * `onInvalid` is `"skip"`.
   */
  readonly print?: Schema.Decoder<unknown>;
}

export type ContractDefinitions = Readonly<Record<string, ContractDefinition>>;

/** A definition map with no entries: the default when `contracts` or `blocks` is omitted. */
// oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty definition map is the intent
export type EmptyDefinitions = Readonly<Record<never, never>>;

/** `event.data` of a contract: its `print` schema's type, or the decoded Clarity value. */
export type PrintData<TContract extends ContractDefinition> = TContract extends {
  readonly print: infer TSchema extends Schema.Decoder<unknown>;
}
  ? TSchema["Type"]
  : ClarityJsonValue;

/**
 * Handles one print. `IndexerDatabase` (the batch transaction, through
 * `indexer.Db`) and `HandlerClient` (through `indexer.Client`) are provided by
 * the runtime; other requirements are provided to `indexer.layer`.
 */
export type EventHandler<
  TContract extends ContractDefinition = ContractDefinition,
  E = never,
  R = never,
> = (event: PrintEvent<PrintData<TContract>>) => Effect.Effect<void, E, R>;

/**
 * Handles a block source run: once per block the source runs at. Services are
 * provided as for `EventHandler`.
 */
export type BlockHandler<E = never, R = never, TName extends string = string> = (
  event: BlockEvent<TName>,
) => Effect.Effect<void, E, R>;

/** The handler of the contract or block source named `TName`. */
export type SourceHandler<
  TContracts extends ContractDefinitions,
  TName extends PropertyKey,
  E = never,
  R = never,
> = TName extends keyof TContracts
  ? EventHandler<TContracts[TName], E, R>
  : BlockHandler<E, R, TName & string>;

/** One handler per defined contract and block source. */
export type Handlers<
  TContracts extends ContractDefinitions,
  TBlocks extends BlockDefinitions = EmptyDefinitions,
> = {
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly [TName in keyof TContracts | keyof TBlocks]: SourceHandler<TContracts, TName, any, any>;
};

/** Services the handlers need beyond the ones the runtime provides. */
export type HandlerRequirements<THandlers> = Exclude<
  {
    // oxlint-disable-next-line typescript/no-explicit-any
    [TName in keyof THandlers]: THandlers[TName] extends (
      ...args: any
    ) => Effect.Effect<any, any, infer R>
      ? R
      : never;
  }[keyof THandlers],
  IndexerDatabase | HandlerClient
>;

export interface LayerOptions<THandlers> extends IndexerRuntimeOptions {
  readonly handlers: THandlers;
}

export interface IndexerDefinition<
  TContracts extends ContractDefinitions,
  TRelations extends AnyRelations,
  TBlocks extends BlockDefinitions = EmptyDefinitions,
> {
  readonly contracts: TContracts;
  readonly blocks: TBlocks;
  /**
   * The indexer database typed by `relations`. Inside a handler it is the
   * batch transaction, so writes commit together with the checkpoint.
   */
  readonly Db: Effect.Effect<IndexerDb<TRelations>, never, IndexerDatabase>;
  /** Read-only contract client pinned to the handled event's block. Handlers only. */
  readonly Client: Effect.Effect<IndexingClient, never, HandlerClient>;
  /** Types a handler defined apart from `layer`, e.g. in its own module. */
  readonly handler: <
    TName extends (keyof TContracts | keyof TBlocks) & string,
    E = never,
    R = never,
  >(
    name: TName,
    handler: SourceHandler<TContracts, TName, E, R>,
  ) => SourceHandler<TContracts, TName, E, R>;
  /**
   * Provides `Indexer` and `IndexerDatabase`: opens the database, applies the
   * indexer's migrations and `migrations`, and installs the logger and, with
   * `telemetry.otlp`, the metrics exporter.
   */
  readonly layer: <const THandlers extends Handlers<TContracts, TBlocks>>(
    options: LayerOptions<THandlers> & {
      // A handler key without a contract or block source is a type error, as in the promise `create`.
      readonly handlers: {
        readonly [TName in Exclude<keyof THandlers, keyof TContracts | keyof TBlocks>]: never;
      };
    },
  ) => Layer.Layer<
    Indexer | IndexerDatabase,
    ConfigurationError | DatabaseError | MigrationError,
    HandlerRequirements<THandlers>
  >;
}

const schemaDecoder =
  (schema: Schema.Decoder<unknown>) =>
  (value: ClarityJsonValue): Effect.Effect<unknown, DecodeIssue> =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((error): DecodeIssue => ({ message: error.message, cause: error })),
    );

/** Any contract or block source handler, as `toSpecs` reads them from `handlers`. */
type AnySourceHandler =
  | EventHandler<ContractDefinition, unknown, unknown>
  | BlockHandler<unknown, unknown, never>;

/** Pairs every contract and block source with its handler, rejecting unknown or missing ones. */
const toSpecs = (
  contracts: ContractDefinitions,
  blocks: BlockDefinitions,
  handlers: Readonly<Partial<Record<string, AnySourceHandler>>>,
  services: Context.Context<never>,
): SourceSpecs => {
  for (const name of Object.keys(handlers)) {
    if (!Object.hasOwn(contracts, name) && !Object.hasOwn(blocks, name)) {
      throw new ConfigurationError({
        message: `handlers.${name}: no contract or block source named "${name}".`,
      });
    }
  }

  const handlerOf = (name: string): AnySourceHandler => {
    const handler = handlers[name];

    if (!Predicate.isFunction(handler)) {
      throw new ConfigurationError({ message: `handlers.${name}: missing handler.` });
    }

    return handler;
  };

  // Services captured from the layer's context; the runtime's own (the
  // Transaction, the pinned client) take precedence over them.
  const withServices = (
    effect: Effect.Effect<void, unknown, IndexerDatabase | HandlerClient>,
  ): Effect.Effect<void, unknown, IndexerDatabase | HandlerClient> =>
    effect.pipe(
      Effect.updateContext((current: Context.Context<IndexerDatabase | HandlerClient>) =>
        Context.merge(services, current),
      ),
    );

  return {
    contracts: Object.entries(contracts).map(([name, contract]) => {
      // SAFETY: Widens the contract-specific event type and requirements; the runtime hands this handler only its contract's events, with `services` provided.
      const handler = handlerOf(name) as (
        event: PrintEvent,
      ) => Effect.Effect<void, unknown, IndexerDatabase | HandlerClient>;

      return {
        name,
        contractId: contract.id,
        startBlock: contract.startBlock,
        endBlock: contract.endBlock,
        onInvalid: contract.onInvalid ?? "fail",
        decode: contract.print === undefined ? undefined : schemaDecoder(contract.print),
        // SAFETY: The runtime parsed `data` with this contract's `print` schema, which `EventHandler` types it with.
        handler: (event) => withServices(handler(event as PrintEvent)),
      };
    }),
    blocks: Object.entries(blocks).map(([name, source]) => {
      // SAFETY: Widens the handler's requirements, which `services` provides.
      const handler = handlerOf(name) as (
        event: BlockEvent,
      ) => Effect.Effect<void, unknown, IndexerDatabase | HandlerClient>;

      return {
        name,
        interval: source.interval ?? 1,
        startBlock: source.startBlock,
        endBlock: source.endBlock,
        handler: (event) => withServices(handler(event)),
      };
    }),
  };
};

/**
 * Defines the contracts and block sources to index and, optionally, the
 * drizzle `relations` typing `indexer.Db`. Throws `ConfigurationError` on an
 * invalid definition.
 */
export function defineIndexer<
  TRelations extends AnyRelations,
  const TContracts extends ContractDefinitions = EmptyDefinitions,
  const TBlocks extends BlockDefinitions = EmptyDefinitions,
>(definition: {
  readonly contracts?: TContracts;
  readonly blocks?: TBlocks;
  readonly relations: TRelations;
}): IndexerDefinition<TContracts, TRelations, TBlocks>;

export function defineIndexer<
  const TContracts extends ContractDefinitions = EmptyDefinitions,
  const TBlocks extends BlockDefinitions = EmptyDefinitions,
>(definition: {
  readonly contracts?: TContracts;
  readonly blocks?: TBlocks;
}): IndexerDefinition<TContracts, EmptyRelations, TBlocks>;

export function defineIndexer<
  TRelations extends AnyRelations,
  const TContracts extends ContractDefinitions,
  const TBlocks extends BlockDefinitions,
>(definition: {
  readonly contracts?: TContracts;
  readonly blocks?: TBlocks;
  readonly relations?: TRelations;
}): IndexerDefinition<TContracts, TRelations, TBlocks> {
  validateIndexerDefinition(definition);

  // SAFETY: An omitted map is the empty definition its type parameter defaults to.
  const contracts = (definition.contracts ?? {}) as TContracts;
  // SAFETY: As above.
  const blocks = (definition.blocks ?? {}) as TBlocks;

  return {
    contracts,
    blocks,
    // SAFETY: The database is opened with `definition.relations`, typed as `TRelations`.
    Db: Effect.service(IndexerDatabase) as Effect.Effect<
      IndexerDb<TRelations>,
      never,
      IndexerDatabase
    >,
    Client: Effect.service(HandlerClient),
    handler: (_name, handler) => handler,
    layer: (options) =>
      Layer.unwrap(
        Effect.gen(function* () {
          // Holds the handlers' own requirements, provided to this layer.
          const services = yield* Effect.context();

          const specs = yield* Effect.try({
            try: () => toSpecs(contracts, blocks, options.handlers, services),
            catch: (error) =>
              error instanceof ConfigurationError
                ? error
                : new ConfigurationError({ message: String(error) }),
          });

          return Indexer.layerWithDatabase({
            database: options.database,
            migrations: options.migrations,
            relations: definition.relations,
            chain: options.chain,
            api: options.api,
            finality: options.finality,
            live: options.live,
            logLevel: options.logLevel,
            telemetry: options.telemetry,
            contracts: specs.contracts,
            blocks: specs.blocks,
          });
        }),
      ),
  };
}
