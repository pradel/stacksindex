import { ClarityTypeID, type ClarityValue, decodeClarityValue } from "@stacks/codec";

/**
 * JSON-compatible value produced by decoding a Clarity value. `bigint` is kept
 * for UInt / Int so callers keep exact integer precision.
 */
export type ClarityJsonValue =
  | bigint
  | boolean
  | string
  | null
  | ClarityJsonValue[]
  | { [key: string]: ClarityJsonValue };

/**
 * Converts a ClarityValue AST into a plain JavaScript / JSON-compatible value.
 *
 * - UInt / Int -> bigint
 * - BoolTrue / BoolFalse -> boolean
 * - StringAscii / StringUtf8 -> string
 * - PrincipalStandard -> address string (e.g. "SP3K8...")
 * - PrincipalContract -> formatted principal string (e.g. "SP3K8...contract-name")
 * - Buffer -> hex string ("0x...")
 * - Tuple -> { [key: string]: ClarityJsonValue }
 * - List -> ClarityJsonValue[]
 * - OptionalSome -> unwrapped value
 * - OptionalNone -> null
 * - ResponseOk -> { ok: value }
 * - ResponseError -> { error: value }
 */
export function cvToJSON(cv: ClarityValue): ClarityJsonValue {
  switch (cv.type_id) {
    case ClarityTypeID.UInt:
    case ClarityTypeID.Int:
      return BigInt(cv.value);

    case ClarityTypeID.BoolTrue:
      return true;

    case ClarityTypeID.BoolFalse:
      return false;

    case ClarityTypeID.StringAscii:
    case ClarityTypeID.StringUtf8:
      return cv.data;

    case ClarityTypeID.PrincipalStandard:
      return cv.address;

    case ClarityTypeID.PrincipalContract:
      return `${cv.address}.${cv.contract_name}`;

    case ClarityTypeID.Buffer:
      return cv.buffer.startsWith("0x") ? cv.buffer : `0x${cv.buffer}`;

    case ClarityTypeID.OptionalSome:
      return cvToJSON(cv.value);

    case ClarityTypeID.OptionalNone:
      return null;

    case ClarityTypeID.ResponseOk:
      return { ok: cvToJSON(cv.value) };

    case ClarityTypeID.ResponseError:
      return { error: cvToJSON(cv.value) };

    case ClarityTypeID.List:
      return cv.list.map((item) => cvToJSON(item));

    case ClarityTypeID.Tuple: {
      const result: { [key: string]: ClarityJsonValue } = {};

      for (const [key, value] of Object.entries(cv.data)) {
        result[key] = cvToJSON(value);
      }

      return result;
    }

    default: {
      const exhaustiveCheck: never = cv;
      throw new Error(`Unsupported ClarityTypeID: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Decodes a Clarity hex string into a plain JavaScript / JSON-compatible object.
 *
 * @param hex - Hex encoded Clarity value (with or without '0x' prefix)
 * @returns Decoded JavaScript value
 */
export function decodeHex(hex: string): ClarityJsonValue {
  const decoded = decodeClarityValue(hex);

  return cvToJSON(decoded);
}

/**
 * Encodes a bigint into a Clarity uint128 hex string (e.g. for contract call args).
 */
export function encodeUint(value: bigint): string {
  const hex = value.toString(16).padStart(32, "0");

  return `0x01${hex}`;
}

export { ClarityTypeID, type ClarityValue, decodeClarityValue };
