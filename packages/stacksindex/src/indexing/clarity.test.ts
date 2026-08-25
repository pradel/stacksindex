import { ClarityTypeID } from "@stacks/codec";
import { describe, expect, test } from "vite-plus/test";

import { decodeClarityValue, decodeClarityValueUnwrapped, formatPrincipal } from "./clarity.ts";

describe("clarity decoding", () => {
  test("decodes a uint", () => {
    const value = decodeClarityValue("0x0100000000000000000000000000000005");
    expect(value.type_id).toBe(ClarityTypeID.UInt);
    expect(value).toMatchObject({ type_id: 1, value: "5" });
  });

  test("decodes a response ok wrapping a uint", () => {
    // (ok u5)
    const value = decodeClarityValue("0x070100000000000000000000000000000005");
    expect(value.type_id).toBe(ClarityTypeID.ResponseOk);
  });

  test("throws on invalid hex", () => {
    expect(() => decodeClarityValue("not-hex")).toThrow("Hex parsing error");
  });
});

describe("decodeClarityValueUnwrapped helper", () => {
  test("returns undefined for undecodable input", () => {
    expect(decodeClarityValueUnwrapped("")).toBeUndefined();
    expect(decodeClarityValueUnwrapped("zz")).toBeUndefined();
  });

  test("unwraps (ok ...) responses", () => {
    const value = decodeClarityValueUnwrapped("0x070100000000000000000000000000000005");
    expect(value).toMatchObject({ type_id: ClarityTypeID.UInt, value: "5" });
  });

  test("unwraps nested (ok (some ...))", () => {
    // (ok (some u7))
    const value = decodeClarityValueUnwrapped("0x070a0100000000000000000000000000000007");
    expect(value).toMatchObject({ type_id: ClarityTypeID.UInt, value: "7" });
  });

  test("preserves (err ...) wrappers", () => {
    // (err u1)
    const value = decodeClarityValueUnwrapped("0x080100000000000000000000000000000001");
    expect(value).toMatchObject({
      type_id: ClarityTypeID.ResponseError,
      value: { type_id: ClarityTypeID.UInt, value: "1" },
    });
  });

  test("returns plain values untouched", () => {
    const value = decodeClarityValueUnwrapped("0x03");
    expect(value).toMatchObject({ type_id: ClarityTypeID.BoolTrue, value: true });
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
});
