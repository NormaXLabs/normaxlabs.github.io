import { TypedDataEncoder, concat, keccak256 } from "ethers";
import type { Call } from "../../src/eip712";

const callTypes = {
  Call: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
  ],
} as const;

export function hashCallStruct(call: Call): string {
  // hashStruct NON include domain (è la hash del struct Call, coerente con EIP-712)
  return TypedDataEncoder.hashStruct("Call", callTypes as any, {
    to: call.to,
    value: BigInt(call.value),
    data: call.data,
    operation: call.operation,
  });
}

export function hashCalls(calls: Call[]): string {
  const hashes = calls.map(hashCallStruct);
  return keccak256(concat(hashes));
}
