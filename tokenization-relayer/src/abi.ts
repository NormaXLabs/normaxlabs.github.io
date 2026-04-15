export const PROXY_WALLET_ABI = [
  "function owner() view returns (address)",
  "function nonce() view returns (uint256)",
  "function executeWithSig(( (address to,uint256 value,bytes data,uint8 operation) call,uint256 nonce,uint256 deadline,address executor,address feeToken,uint256 feeAmount,address feeRecipient) req, bytes signature) payable returns (bytes)",
  "function executeBatchWithSig((address to,uint256 value,bytes data,uint8 operation)[] calls, (bytes32 callsHash,uint256 nonce,uint256 deadline,address executor,address feeToken,uint256 feeAmount,address feeRecipient) req, bytes signature) payable returns (bytes[])",
] as const;

export const RELAY_BUNDLER_ABI = [
  "function permitPullToWalletAndExecute(address token,address owner,address proxyWallet,uint256 pullAmount,uint256 permitDeadline,uint8 v,bytes32 r,bytes32 s,((address to,uint256 value,bytes data,uint8 operation) call,uint256 nonce,uint256 deadline,address executor,address feeToken,uint256 feeAmount,address feeRecipient) exec,bytes execSig) returns (bytes)"
] as const;

export const ERC20_PERMIT_READ_ABI = [
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)"
] as const;

export const FACTORY_ABI = [
  "function predictWallet(address owner) view returns (address)",
  "function createWallet(address owner) returns (address)",
] as const;
