import { type TypedDataDomain } from "ethers";

export const domain = (chainId: bigint, verifyingContract: string): TypedDataDomain => ({
  name: "ProxyWallet",
  version: "1",
  chainId,
  verifyingContract,
});

export const types = {
  Call: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
  ],
  Execute: [
    { name: "call", type: "Call" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "executor", type: "address" },
    { name: "feeToken", type: "address" },
    { name: "feeAmount", type: "uint256" },
    { name: "feeRecipient", type: "address" },
  ],
  ExecuteBatch: [
    { name: "callsHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "executor", type: "address" },
    { name: "feeToken", type: "address" },
    { name: "feeAmount", type: "uint256" },
    { name: "feeRecipient", type: "address" },
  ],
} as const;

export type Call = {
  to: string;
  value: string; // uint256 in string per JSON
  data: string;  // 0x...
  operation: number; // 0 or 1
};

export type ExecuteRequest = {
  call: Call;
  nonce: string;
  deadline: string;
  executor: string;
  feeToken: string;
  feeAmount: string;
  feeRecipient: string;
};

export type ExecuteBatchRequest = {
  callsHash: string;
  nonce: string;
  deadline: string;
  executor: string;
  feeToken: string;
  feeAmount: string;
  feeRecipient: string;
};
