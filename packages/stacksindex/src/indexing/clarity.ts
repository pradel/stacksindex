import {
  ClarityTypeID,
  type ClarityValue,
  type ClarityValueResponseOk,
  decodeClarityValue as decodeClarityValueNative,
} from "@stacks/codec";

export { decodeClarityValue } from "@stacks/codec";
export type { ClarityValue } from "@stacks/codec";

/** Unwrap `(ok ...)` / `(some ...)` wrappers from a decoded Clarity value. */
function unwrapClarityValue(value: ClarityValue): ClarityValue {
  let current = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current.type_id === ClarityTypeID.ResponseOk) {
      current = (current as ClarityValueResponseOk).value;
      // oxlint-disable-next-line no-continue
      continue;
    }
    if (current.type_id === ClarityTypeID.OptionalSome) {
      const unwrapped = current;
      current = unwrapped.value;
      // oxlint-disable-next-line no-continue
      continue;
    }
    break;
  }
  return current;
}

/**
 * Decode a hex-encoded Clarity value, unwrapping `(ok ...)` and `(some ...)` wrappers.
 * Returns `undefined` when the value cannot be decoded.
 */
export function decodeClarityValueUnwrapped(hex: string): ClarityValue | undefined {
  try {
    const decoded = decodeClarityValueNative(hex);
    return unwrapClarityValue(decoded);
  } catch {
    return undefined;
  }
}

export interface PrincipalData {
  address: string;
  contract_name?: string;
}

/** Format a Stacks principal (`address` or `address.contract-name`). */
export function formatPrincipal(principal: PrincipalData): string {
  return principal.contract_name === undefined
    ? principal.address
    : `${principal.address}.${principal.contract_name}`;
}
