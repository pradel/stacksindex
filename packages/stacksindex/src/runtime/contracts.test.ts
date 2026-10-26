import { Effect, References } from "effect";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import { StacksClient } from "../datasources/api/index.ts";
import { ConfigurationError, FilterValidationError } from "../lib/errors.ts";
import { createFakeChain } from "../test-utils/fake-chain.ts";
import type { BlockDefinition, BlockSourceSpec } from "./blocks.ts";
import {
  type ContractDefinitionBase,
  type ContractSpec,
  resolveSources,
  validateIndexerDefinition,
} from "./contracts.ts";

const TOKEN_ID = "SP123.token";

const validate = (contracts: Readonly<Record<string, ContractDefinitionBase>>) => () =>
  validateIndexerDefinition({ contracts });

const validateBlocks =
  (
    blocks: Readonly<Record<string, BlockDefinition>>,
    contracts: Readonly<Record<string, ContractDefinitionBase>> = {},
  ) =>
  () =>
    validateIndexerDefinition({ contracts, blocks });

describe("contract definitions", () => {
  test("accepts a definition with block bounds, onInvalid and a latest end block", () => {
    expect(
      validate({
        token: { id: TOKEN_ID, startBlock: 0, endBlock: 10, onInvalid: "skip" },
        pool: { id: "SP2ABC.pool-v1_2", startBlock: 5, endBlock: "latest", onInvalid: "fail" },
      }),
    ).not.toThrow();
  });

  test("rejects a definition without contracts or block sources", () => {
    const message = "Define at least one contract in `contracts` or block source in `blocks`.";

    expect(validate({})).toThrow(new ConfigurationError({ message }));
    expect(() => validateIndexerDefinition({})).toThrow(new ConfigurationError({ message }));
  });

  test.each(["token", "SP123", "SP123.", "sp123.token", "SP123.1token", "SP123.token.extra"])(
    "rejects the contract id %j",
    (id) => {
      expect(validate({ token: { id } })).toThrow(ConfigurationError);
      expect(validate({ token: { id } })).toThrow(/^contracts\.token: `id` must be/u);
    },
  );

  test("rejects the same contract id under two names", () => {
    expect(validate({ token: { id: TOKEN_ID }, again: { id: TOKEN_ID } })).toThrow(
      new ConfigurationError({
        message: `contracts.again: \`id\` ${TOKEN_ID} is already indexed as contracts.token.`,
      }),
    );
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects startBlock %j",
    (startBlock) => {
      expect(validate({ token: { id: TOKEN_ID, startBlock } })).toThrow(
        /^contracts\.token: `startBlock` must be a non-negative integer/u,
      );
    },
  );

  test.each([-1, 1.5, Number.NaN])("rejects endBlock %j", (endBlock) => {
    expect(validate({ token: { id: TOKEN_ID, endBlock } })).toThrow(
      /^contracts\.token: `endBlock` must be a non-negative integer or "latest"/u,
    );
  });

  test("rejects a startBlock after a numeric endBlock", () => {
    expect(validate({ token: { id: TOKEN_ID, startBlock: 11, endBlock: 10 } })).toThrow(
      new ConfigurationError({
        message: "contracts.token: `startBlock` (11) is after `endBlock` (10).",
      }),
    );
    expect(validate({ token: { id: TOKEN_ID, startBlock: 10, endBlock: 10 } })).not.toThrow();
  });

  test("rejects an unknown onInvalid", () => {
    // SAFETY: Plain JavaScript callers can pass any string.
    const onInvalid = "ignore" as ContractDefinitionBase["onInvalid"];

    expect(validate({ token: { id: TOKEN_ID, onInvalid } })).toThrow(
      new ConfigurationError({
        message: 'contracts.token: `onInvalid` must be "fail" or "skip", got "ignore".',
      }),
    );
  });
});

describe("block source definitions", () => {
  test("accepts block sources alone, with or without an interval and end block", () => {
    expect(
      validateBlocks({
        everyBlock: { startBlock: 0 },
        hourly: { interval: 360, startBlock: 1000, endBlock: "latest" },
        bounded: { interval: 10, startBlock: 5, endBlock: 5 },
      }),
    ).not.toThrow();
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects interval %j",
    (interval) => {
      expect(validateBlocks({ hourly: { interval, startBlock: 0 } })).toThrow(
        new ConfigurationError({
          message: `blocks.hourly: \`interval\` must be a positive integer, got ${String(interval)}.`,
        }),
      );
    },
  );

  test.each([undefined, -1, 1.5, Number.NaN])("rejects startBlock %j", (startBlock) => {
    // SAFETY: Plain JavaScript callers can omit the required startBlock.
    const source = { startBlock } as BlockDefinition;

    expect(validateBlocks({ hourly: source })).toThrow(
      /^blocks\.hourly: `startBlock` must be a non-negative integer/u,
    );
  });

  test("rejects a startBlock after a numeric endBlock", () => {
    expect(validateBlocks({ hourly: { startBlock: 11, endBlock: 10 } })).toThrow(
      new ConfigurationError({
        message: "blocks.hourly: `startBlock` (11) is after `endBlock` (10).",
      }),
    );
  });

  test("rejects a block source named like a contract", () => {
    expect(validateBlocks({ token: { startBlock: 0 } }, { token: { id: TOKEN_ID } })).toThrow(
      new ConfigurationError({
        message:
          "blocks.token: the name is already used by contracts.token; names must be unique across `contracts` and `blocks`.",
      }),
    );
  });
});

describe("resolving contracts and block sources", () => {
  const spec = (overrides: Partial<ContractSpec> = {}): ContractSpec => ({
    name: "token",
    contractId: TOKEN_ID,
    onInvalid: "fail",
    handler: () => Effect.void,
    ...overrides,
  });

  const blockSpec = (overrides: Partial<BlockSourceSpec> = {}): BlockSourceSpec => ({
    name: "hourly",
    interval: 10,
    startBlock: 5,
    handler: () => Effect.void,
    ...overrides,
  });

  beforeAll(() => {
    // The API tip is block 120.
    const chain = createFakeChain({ baseHeight: 120 });

    vi.stubGlobal("fetch", (input: string | URL | Request) => chain.fetch(input));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const resolve = (contracts: ContractSpec[], blocks: BlockSourceSpec[] = []) =>
    resolveSources(contracts, blocks).pipe(
      Effect.provide(StacksClient.layer({ baseUrl: "http://stacks.test" })),
      Effect.provideService(References.MinimumLogLevel, "None"),
    );

  test('resolves "latest" to the API tip and keeps numeric end blocks', async () => {
    const resolved = await Effect.runPromise(
      resolve(
        [
          spec({ startBlock: 5, endBlock: "latest" }),
          spec({ name: "pool", contractId: "SP123.pool", endBlock: 50 }),
        ],
        [blockSpec({ endBlock: "latest" }), blockSpec({ name: "daily", endBlock: 60 })],
      ),
    );

    expect(resolved.contracts.map((contract) => contract.endBlock)).toStrictEqual([120, 50]);
    expect(resolved.blocks.map((source) => source.endBlock)).toStrictEqual([120, 60]);
  });

  test('fails when startBlock is after the resolved "latest" end block', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(resolve([spec({ startBlock: 200, endBlock: "latest" })])),
    );

    expect(failure).toBeInstanceOf(FilterValidationError);
    expect(failure).toMatchObject({
      message: "Start block (200) is after end block (120) for contracts.token.",
    });
  });

  test('fails when a block source starts after the resolved "latest" end block', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(resolve([], [blockSpec({ startBlock: 200, endBlock: "latest" })])),
    );

    expect(failure).toMatchObject({
      message: "Start block (200) is after end block (120) for blocks.hourly.",
    });
  });
});
