import { ClarityType, cvToHex, uintCV, type ClarityValue } from "stacksindex";

type MaybeClarity = ClarityValue | undefined;

function asTuple(value: MaybeClarity): Record<string, ClarityValue> | undefined {
  return typeof value === "object" && value.type === ClarityType.Tuple ? value.value : undefined;
}

/** Read `key` from a tuple value as a nested tuple record. */
export function extractTuple(
  value: MaybeClarity,
  key: string,
): Record<string, ClarityValue> | undefined {
  return asTuple(asTuple(value)?.[key]);
}

/** Read `key` from a tuple value, keeping the value itself (e.g. a nested tuple). */
export function extractField(value: MaybeClarity, key: string): ClarityValue | undefined {
  return asTuple(value)?.[key];
}

/** Read `key` from a tuple value as an ASCII/UTF-8 string. */
export function extractString(value: MaybeClarity, key: string): string | undefined {
  const field = asTuple(value)?.[key];
  return field !== undefined &&
    (field.type === ClarityType.StringASCII || field.type === ClarityType.StringUTF8)
    ? field.value
    : undefined;
}

/** Read `key` from a tuple value as a uint. */
export function extractUint(value: MaybeClarity, key: string): bigint | undefined {
  const field = asTuple(value)?.[key];
  return field !== undefined && field.type === ClarityType.UInt ? BigInt(field.value) : undefined;
}

/** Read `key` from a tuple value as a bool. */
export function extractBool(value: MaybeClarity, key: string): boolean | undefined {
  const field = asTuple(value)?.[key];
  if (field !== undefined && field.type === ClarityType.BoolTrue) {
    return true;
  }
  if (field !== undefined && field.type === ClarityType.BoolFalse) {
    return false;
  }
  return undefined;
}

/** Format a standalone Clarity principal value; undefined for non-principals. */
export function principalFromValue(value: MaybeClarity): string | undefined {
  if (
    value !== undefined &&
    (value.type === ClarityType.PrincipalStandard || value.type === ClarityType.PrincipalContract)
  ) {
    // Principals carry their formatted id ("address" or "address.contract-name").
    return value.value;
  }
  return undefined;
}

/** Read `key` from a tuple value as a principal (`address` or `address.contract`). */
export function extractPrincipal(value: MaybeClarity, key: string): string | undefined {
  return principalFromValue(asTuple(value)?.[key]);
}

/** Encode a `uint` Clarity value as hex, for read-only call arguments. */
export function encodeUint(value: bigint): string {
  return cvToHex(uintCV(value));
}
