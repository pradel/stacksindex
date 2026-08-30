import { ClarityType, hexToCV, type ClarityValue } from "@stacks/transactions";

export {
  bufferCV,
  ClarityType,
  contractPrincipalCV,
  cvToHex,
  falseCV,
  hexToCV,
  intCV,
  listCV,
  noneCV,
  responseErrorCV,
  responseOkCV,
  someCV,
  standardPrincipalCV,
  stringAsciiCV,
  stringUtf8CV,
  trueCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
export type { ClarityValue } from "@stacks/transactions";

/** Decode a hex-encoded Clarity value. Alias of {@link hexToCV}. */
export const decodeClarityValue = hexToCV;

/** Unwrap `(ok ...)` / `(some ...)` wrappers from a decoded Clarity value. */
function unwrapClarityValue(value: ClarityValue): ClarityValue {
  let current = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current.type === ClarityType.ResponseOk) {
      current = current.value;
      // oxlint-disable-next-line no-continue
      continue;
    }
    if (current.type === ClarityType.OptionalSome) {
      current = current.value;
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
    const decoded = hexToCV(hex);
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
