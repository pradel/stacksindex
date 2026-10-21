import { Effect, References } from "effect";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import { StacksClient } from "../datasources/api/index.ts";
import { ConfigurationError, FilterValidationError } from "../lib/errors.ts";
import { createFakeChain } from "../test-utils/fake-chain.ts";
import {
  type ContractDefinitionBase,
  type ContractSpec,
  resolveContracts,
  validateContractDefinitions,
} from "./contracts.ts";

const TOKEN_ID = "SP123.token";

const validate = (contracts: Readonly<Record<string, ContractDefinitionBase>>) => () =>
  validateContractDefinitions(contracts);

describe("contract definitions", () => {
  test("accepts a definition with block bounds, onInvalid and a latest end block", () => {
    expect(
      validate({
        token: { id: TOKEN_ID, startBlock: 0, endBlock: 10, onInvalid: "skip" },
        pool: { id: "SP2ABC.pool-v1_2", startBlock: 5, endBlock: "latest", onInvalid: "fail" },
      }),
    ).not.toThrow();
  });

  test("rejects an empty contracts map", () => {
    expect(validate({})).toThrow(
      new ConfigurationError({ message: "Define at least one contract in `contracts`." }),
    );
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

describe("resolving contracts", () => {
  const spec = (overrides: Partial<ContractSpec> = {}): ContractSpec => ({
    name: "token",
    contractId: TOKEN_ID,
    onInvalid: "fail",
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

  const resolve = (contracts: ContractSpec[]) =>
    resolveContracts(contracts).pipe(
      Effect.provide(StacksClient.layer({ baseUrl: "http://stacks.test" })),
      Effect.provideService(References.MinimumLogLevel, "None"),
    );

  test('resolves "latest" to the API tip and keeps numeric end blocks', async () => {
    const resolved = await Effect.runPromise(
      resolve([
        spec({ startBlock: 5, endBlock: "latest" }),
        spec({ name: "pool", contractId: "SP123.pool", endBlock: 50 }),
      ]),
    );

    expect(resolved.map((contract) => contract.endBlock)).toStrictEqual([120, 50]);
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
});
