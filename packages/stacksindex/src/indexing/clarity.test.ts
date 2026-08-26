import { describe, expect, test } from "vite-plus/test";

import {
  ClarityType,
  contractPrincipalCV,
  cvToHex,
  decodeClarityValue,
  decodeClarityValueUnwrapped,
  formatPrincipal,
  noneCV,
  responseOkCV,
  someCV,
  stringAsciiCV,
  trueCV,
  tupleCV,
  uintCV,
} from "./clarity.ts";

describe("clarity decoding", () => {
  test("decodes a uint", () => {
    const value = decodeClarityValue(cvToHex(uintCV(5n)));
    expect(value).toMatchObject({ type: ClarityType.UInt, value: 5n });
  });

  test("decodes a response ok wrapping a uint", () => {
    const value = decodeClarityValue(cvToHex(responseOkCV(uintCV(5n))));
    expect(value).toMatchObject({
      type: ClarityType.ResponseOk,
      value: { type: ClarityType.UInt, value: 5n },
    });
  });

  test("round-trips tuples with nested values", () => {
    const tuple = tupleCV({
      action: stringAsciiCV("swap-x-for-y"),
      amount: uintCV(7n),
      flag: trueCV(),
      nested: someCV(uintCV(1n)),
    });
    const decoded = decodeClarityValue(cvToHex(tuple));
    expect(decoded).toMatchObject({
      type: ClarityType.Tuple,
      value: {
        action: { type: ClarityType.StringASCII, value: "swap-x-for-y" },
        amount: { type: ClarityType.UInt, value: 7n },
        flag: { type: ClarityType.BoolTrue },
      },
    });
  });

  test("decodes none", () => {
    expect(decodeClarityValue(cvToHex(noneCV())).type).toBe(ClarityType.OptionalNone);
  });

  test("throws on invalid hex", () => {
    expect(() => decodeClarityValue("not-hex")).toThrow("Invalid byte sequence");
  });
});

describe("unwrapped decoding helper", () => {
  test("returns undefined for undecodable input", () => {
    expect(decodeClarityValueUnwrapped("")).toBeUndefined();
    expect(decodeClarityValueUnwrapped("zz")).toBeUndefined();
  });

  test("unwraps (ok ...) responses", () => {
    const value = decodeClarityValueUnwrapped(cvToHex(responseOkCV(uintCV(5n))));
    expect(value).toMatchObject({ type: ClarityType.UInt, value: 5n });
  });

  test("unwraps nested (ok (some ...))", () => {
    const value = decodeClarityValueUnwrapped(cvToHex(responseOkCV(someCV(uintCV(7n)))));
    expect(value).toMatchObject({ type: ClarityType.UInt, value: 7n });
  });

  test("preserves (err ...) wrappers", () => {
    // (err u1): response-error type byte + the full inner CV serialization.
    const errHex = `0x08${cvToHex(uintCV(1n)).slice(2)}`;
    const value = decodeClarityValueUnwrapped(errHex);
    expect(value).toMatchObject({
      type: ClarityType.ResponseErr,
      value: { type: ClarityType.UInt, value: 1n },
    });
  });

  test("returns plain values untouched", () => {
    const value = decodeClarityValueUnwrapped(cvToHex(trueCV()));
    expect(value).toMatchObject({ type: ClarityType.BoolTrue });
  });
});

describe("formatPrincipal helper", () => {
  test("formats contract principals", () => {
    expect(
      formatPrincipal({
        address: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9",
        contract_name: "pool",
      }),
    ).toBe("SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.pool");
  });

  test("formats standard principals", () => {
    expect(formatPrincipal({ address: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKQ9XH0TB" })).toBe(
      "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKQ9XH0TB",
    );
  });

  test("agrees with contractPrincipalCV serialization", () => {
    const principal = contractPrincipalCV("SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9", "pool");
    expect(principal.value).toBe(
      formatPrincipal({
        address: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9",
        contract_name: "pool",
      }),
    );
    expect(principal.type).toBe(ClarityType.PrincipalContract);
  });
});
