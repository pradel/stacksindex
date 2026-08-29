import { ClarityTypeID, type ClarityValue } from "@stacks/codec";
import { describe, expect, test } from "vite-plus/test";

import { cvToJSON, decodeHex, encodeUint } from "./index.ts";

describe("codec", () => {
  describe("cvToJSON()", () => {
    test("converts UInt and Int to bigint", () => {
      const uintCv: ClarityValue = {
        type_id: ClarityTypeID.UInt,
        value: "100000000000000000000",
        repr: "u100000000000000000000",
        hex: "0x...",
      };
      expect(cvToJSON(uintCv)).toBe(100000000000000000000n);

      const intCv: ClarityValue = {
        type_id: ClarityTypeID.Int,
        value: "-42",
        repr: "-42",
        hex: "0x...",
      };
      expect(cvToJSON(intCv)).toBe(-42n);
    });

    test("converts booleans", () => {
      expect(
        cvToJSON({
          type_id: ClarityTypeID.BoolTrue,
          value: true,
          repr: "true",
          hex: "0x03",
        }),
      ).toBe(true);

      expect(
        cvToJSON({
          type_id: ClarityTypeID.BoolFalse,
          value: false,
          repr: "false",
          hex: "0x04",
        }),
      ).toBe(false);
    });

    test("converts strings", () => {
      expect(
        cvToJSON({
          type_id: ClarityTypeID.StringAscii,
          data: "hello",
          repr: '"hello"',
          hex: "0x...",
        }),
      ).toBe("hello");

      expect(
        cvToJSON({
          type_id: ClarityTypeID.StringUtf8,
          data: "world 🚀",
          repr: 'u"world 🚀"',
          hex: "0x...",
        }),
      ).toBe("world 🚀");
    });

    test("converts principals", () => {
      expect(
        cvToJSON({
          type_id: ClarityTypeID.PrincipalStandard,
          address: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9",
          address_version: 22,
          address_hash_bytes: "...",
          repr: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9",
          hex: "0x...",
        }),
      ).toBe("SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9");

      expect(
        cvToJSON({
          type_id: ClarityTypeID.PrincipalContract,
          address: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9",
          contract_name: "fixed-weight-pool-v1-01",
          address_version: 22,
          address_hash_bytes: "...",
          repr: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01",
          hex: "0x...",
        }),
      ).toBe("SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01");
    });

    test("converts buffer", () => {
      expect(
        cvToJSON({
          type_id: ClarityTypeID.Buffer,
          buffer: "deadbeef",
          repr: "0xdeadbeef",
          hex: "0x...",
        }),
      ).toBe("0xdeadbeef");
    });

    test("converts optionals", () => {
      expect(
        cvToJSON({
          type_id: ClarityTypeID.OptionalSome,
          value: {
            type_id: ClarityTypeID.UInt,
            value: "5",
            repr: "u5",
            hex: "0x...",
          },
          repr: "(some u5)",
          hex: "0x...",
        }),
      ).toBe(5n);

      expect(
        cvToJSON({
          type_id: ClarityTypeID.OptionalNone,
          repr: "none",
          hex: "0x09",
        }),
      ).toBeNull();
    });

    test("converts responses", () => {
      expect(
        cvToJSON({
          type_id: ClarityTypeID.ResponseOk,
          value: {
            type_id: ClarityTypeID.StringAscii,
            data: "success",
            repr: '"success"',
            hex: "0x...",
          },
          repr: '(ok "success")',
          hex: "0x...",
        }),
      ).toStrictEqual({ ok: "success" });

      expect(
        cvToJSON({
          type_id: ClarityTypeID.ResponseError,
          value: {
            type_id: ClarityTypeID.UInt,
            value: "404",
            repr: "u404",
            hex: "0x...",
          },
          repr: "(err u404)",
          hex: "0x...",
        }),
      ).toStrictEqual({ error: 404n });
    });

    test("converts list and tuple", () => {
      const tupleCv: ClarityValue = {
        type_id: ClarityTypeID.Tuple,
        data: {
          action: {
            type_id: ClarityTypeID.StringAscii,
            data: "created",
            repr: '"created"',
            hex: "0x...",
          },
          amounts: {
            type_id: ClarityTypeID.List,
            list: [
              {
                type_id: ClarityTypeID.UInt,
                value: "100",
                repr: "u100",
                hex: "0x...",
              },
              {
                type_id: ClarityTypeID.UInt,
                value: "200",
                repr: "u200",
                hex: "0x...",
              },
            ],
            repr: "[u100, u200]",
            hex: "0x...",
          },
        },
        repr: '(tuple (action "created") (amounts [u100, u200]))',
        hex: "0x...",
      };

      expect(cvToJSON(tupleCv)).toStrictEqual({
        action: "created",
        amounts: [100n, 200n],
      });
    });
  });

  describe("decodeHex()", () => {
    test("decodes Clarity uint hex string", () => {
      // 0x01 + 16-byte uint (value 8)
      const hex = "0x0100000000000000000000000000000008";
      expect(decodeHex(hex)).toBe(8n);
    });

    test("decodes Clarity ok uint hex string", () => {
      // (ok u8) -> 0x07 (ok) + encodeUint(8n)
      const hex = `0x07${encodeUint(8n).slice(2)}`;
      expect(decodeHex(hex)).toStrictEqual({ ok: 8n });
    });
  });

  describe("encodeUint()", () => {
    test("encodes bigint to hex", () => {
      expect(encodeUint(1n)).toBe("0x0100000000000000000000000000000001");
      expect(encodeUint(10n)).toBe("0x010000000000000000000000000000000a");
    });
  });
});
