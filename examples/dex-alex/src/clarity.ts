import { ClarityTypeID, type ClarityValue } from "stacksindex";

type MaybeClarity = ClarityValue | undefined;

function asTuple(value: MaybeClarity): Record<string, ClarityValue> | undefined {
  return typeof value === "object" && value.type_id === ClarityTypeID.Tuple
    ? value.data
    : undefined;
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
    (field.type_id === ClarityTypeID.StringAscii || field.type_id === ClarityTypeID.StringUtf8)
    ? field.data
    : undefined;
}

/** Read `key` from a tuple value as a uint. */
export function extractUint(value: MaybeClarity, key: string): bigint | undefined {
  const field = asTuple(value)?.[key];
  return field !== undefined && field.type_id === ClarityTypeID.UInt
    ? BigInt(field.value)
    : undefined;
}

/** Read `key` from a tuple value as a bool. */
export function extractBool(value: MaybeClarity, key: string): boolean | undefined {
  const field = asTuple(value)?.[key];
  if (
    field !== undefined &&
    (field.type_id === ClarityTypeID.BoolTrue || field.type_id === ClarityTypeID.BoolFalse)
  ) {
    return field.value;
  }
  return undefined;
}

/** Read `key` from a tuple value as a principal (`address` or `address.contract`). */
export function extractPrincipal(value: MaybeClarity, key: string): string | undefined {
  const field = asTuple(value)?.[key];
  if (field === undefined) {
    return undefined;
  }
  if (field.type_id === ClarityTypeID.PrincipalStandard) {
    return field.address;
  }
  if (field.type_id === ClarityTypeID.PrincipalContract) {
    return `${field.address}.${field.contract_name}`;
  }
  return undefined;
}

/** Encode a `uint` Clarity value as hex, for read-only call arguments. */
export function encodeUint(value: bigint): string {
  return `0x01${value.toString(16).padStart(32, "0")}`;
}
