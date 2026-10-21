import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import { Context, Effect, Layer, Predicate, Schema } from "effect";

import type { ClarityJsonValue } from "../codec/index.ts";
import { IndexerDatabase, type IndexerDb } from "../database/index.ts";
import { HandlerClient } from "../indexing/client.ts";
import { ConfigurationError, type DatabaseError, type MigrationError } from "../lib/errors.ts";
import type { CoreHandler, IndexingClient, PrintEvent } from "../lib/types.ts";
import type { IndexerRuntimeOptions } from "../runtime/config.ts";
import {
  type ContractDefinitionBase,
  type ContractSpec,
  type DecodeIssue,
  validateContractDefinitions,
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

/** One handler per defined contract. */
export type Handlers<TContracts extends ContractDefinitions> = {
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly [TName in keyof TContracts]: EventHandler<TContracts[TName], any, any>;
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
> {
  readonly contracts: TContracts;
  /**
   * The indexer database typed by `relations`. Inside a handler it is the
   * batch transaction, so writes commit together with the checkpoint.
   */
  readonly Db: Effect.Effect<IndexerDb<TRelations>, never, IndexerDatabase>;
  /** Read-only contract client pinned to the handled event's block. Handlers only. */
  readonly Client: Effect.Effect<IndexingClient, never, HandlerClient>;
  /** Types a handler defined apart from `layer`, e.g. in its own module. */
  readonly handler: <TName extends keyof TContracts & string, E = never, R = never>(
    name: TName,
    handler: EventHandler<TContracts[TName], E, R>,
  ) => EventHandler<TContracts[TName], E, R>;
  /**
   * Provides `Indexer` and `IndexerDatabase`: opens the database, applies the
   * indexer's migrations and `migrations`, and installs the logger and, with
   * `telemetry.otlp`, the metrics exporter.
   */
  readonly layer: <const THandlers extends Handlers<TContracts>>(
    options: LayerOptions<THandlers> & {
      // A handler key without a contract is a type error, as in the promise `create`.
      readonly handlers: { readonly [TName in Exclude<keyof THandlers, keyof TContracts>]: never };
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

// oxlint-disable-next-line typescript/no-explicit-any
type AnyEventHandler = EventHandler<ContractDefinition, any, any>;

const toContractSpecs = <TContracts extends ContractDefinitions>(
  contracts: TContracts,
  handlers: Handlers<TContracts>,
  services: Context.Context<never>,
): ContractSpec[] => {
  for (const name of Object.keys(handlers)) {
    if (!Object.hasOwn(contracts, name)) {
      throw new ConfigurationError({ message: `handlers.${name}: no contract named "${name}".` });
    }
  }

  return Object.entries(contracts).map(([name, contract]) => {
    // SAFETY: Widens the contract-specific event type; the runtime hands this handler only its contract's events.
    const handler = handlers[name] as AnyEventHandler | undefined;

    if (!Predicate.isFunction(handler)) {
      throw new ConfigurationError({ message: `handlers.${name}: missing handler.` });
    }

    // Services captured from the layer's context; the runtime's own (the
    // Transaction, the pinned client) take precedence over them.
    const core: CoreHandler = (event) =>
      // SAFETY: The runtime parsed `data` with this contract's `print` schema, which `EventHandler` types it with.
      (
        handler(event as PrintEvent) as Effect.Effect<
          void,
          unknown,
          IndexerDatabase | HandlerClient
        >
      ).pipe(
        Effect.updateContext((current: Context.Context<IndexerDatabase | HandlerClient>) =>
          Context.merge(services, current),
        ),
      );

    return {
      name,
      contractId: contract.id,
      startBlock: contract.startBlock,
      endBlock: contract.endBlock,
      onInvalid: contract.onInvalid ?? "fail",
      decode: contract.print === undefined ? undefined : schemaDecoder(contract.print),
      handler: core,
    };
  });
};

/**
 * Defines the contracts to index and, optionally, the drizzle `relations`
 * typing `indexer.Db`. Throws `ConfigurationError` on an invalid definition.
 */
export function defineIndexer<
  const TContracts extends ContractDefinitions,
  TRelations extends AnyRelations,
>(definition: {
  readonly contracts: TContracts;
  readonly relations: TRelations;
}): IndexerDefinition<TContracts, TRelations>;

export function defineIndexer<const TContracts extends ContractDefinitions>(definition: {
  readonly contracts: TContracts;
}): IndexerDefinition<TContracts, EmptyRelations>;

export function defineIndexer<
  const TContracts extends ContractDefinitions,
  TRelations extends AnyRelations,
>(definition: {
  readonly contracts: TContracts;
  readonly relations?: TRelations;
}): IndexerDefinition<TContracts, TRelations> {
  validateContractDefinitions(definition.contracts);

  return {
    contracts: definition.contracts,
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

          const contracts = yield* Effect.try({
            try: () => toContractSpecs(definition.contracts, options.handlers, services),
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
            contracts,
          });
        }),
      ),
  };
}
