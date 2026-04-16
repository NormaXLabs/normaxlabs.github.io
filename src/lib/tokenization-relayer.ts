import {
  JsonRpcProvider,
  Wallet,
  Contract,
  verifyTypedData,
  getAddress,
  Signature,
  isAddress,
  dataSlice,
  id,
} from "ethers";

import {
  domain,
  types,
  type ExecuteRequest,
  type ExecuteBatchRequest,
  type Call,
} from "../../tokenization-relayer/eip712";
import { hashCalls } from "../../tokenization-relayer/src/hashCalls";
import {
  PROXY_WALLET_ABI,
  RELAY_BUNDLER_ABI,
  ERC20_PERMIT_READ_ABI,
  FACTORY_ABI,
} from "../../tokenization-relayer/src/abi";

const META_ENV = ((import.meta as any).env ?? {}) as Record<string, string | undefined>;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

type RelayedTx = {
  time: number;
  route: string;
  status: "pending" | "success" | "revert";
  txHash: string;
  owner?: string;
  proxyWallet?: string;
  to?: string;
  token?: string;
  feeToken?: string;
  feeRecipient?: string;
  feeAmount?: string;
  blockNumber?: number;
  error?: string;
};

type JsonResponse = {
  status?: number;
  body: unknown;
};

const relayedTxs: RelayedTx[] = [];

const MARKET_ABI = [
  "function getAllAssetIds() view returns (bytes32[])",
  "function fullInventory() view returns (address[] makers,uint256[] makerStable, bytes32[] assetIds, uint256[][] balances)",
  "function assets(bytes32) view returns (address token,string symbolText,uint8 tokenDecimals,bool listed,uint256 minBuyAmount)",
  "function tokenAddress(bytes32) view returns (address)",
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: any): boolean {
  const message =
    error?.info?.error?.message ||
    error?.error?.message ||
    error?.shortMessage ||
    error?.message ||
    String(error);
  return (
    String(message).includes("request limit reached") ||
    String(message).includes("rate limit") ||
    String(message).includes("429") ||
    error?.code === -32007
  );
}

async function withRpcRetry<T>(fn: () => Promise<T>, label: string, retries = 4): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt === retries) break;
      const waitMs = 600 * (attempt + 1);
      console.warn(`[relayer] ${label} rate-limited, retrying in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

function mustEnv(name: string): string {
  const v = process.env[name] ?? META_ENV[name];
  if (!v) throw new Error(`Missing ${name} in env`);
  return v;
}

function envValue(name: string): string | undefined {
  return process.env[name] ?? META_ENV[name];
}

function envFirst(...names: string[]): string | undefined {
  for (const name of names) {
    const value = envValue(name);
    if (value) return value;
  }
  return undefined;
}

function selectorOf(calldata: string): string {
  if (!calldata || calldata === "0x" || calldata.length < 10) return "0x";
  return dataSlice(calldata, 0, 4);
}

function failPolicy(msg: string): never {
  throw new Error(`POLICY_REJECTED: ${msg}`);
}

function resolveTargetList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      if (item.startsWith("0x")) return item;
      const v = envValue(item);
      if (!v) throw new Error(`ALLOWED_TARGETS references missing env var: ${item}`);
      return v;
    });
}

function createContext() {
  const RPC_URL = envFirst("RPC_URL", "SEPOLIA_RPC_URL");
  if (!RPC_URL) throw new Error("Missing RPC_URL in env");
  const RELAYER_PK = envFirst("RELAYER_PRIVATE_KEY", "SEPOLIA_PRIVATE_KEY", "PRIVATE_KEY");
  if (!RELAYER_PK) throw new Error("Missing RELAYER_PRIVATE_KEY in env");
  const provider = new JsonRpcProvider(RPC_URL);
  const relayer = new Wallet(RELAYER_PK, provider);

  const RELAYER_ADDR = getAddress(envValue("RELAYER_ADDR") ?? relayer.address);
  const tokenRaw = envFirst("TOKEN", "STABLE_ADDRESS");
  if (!tokenRaw) throw new Error("Missing TOKEN in env");
  const MUSD_TOKEN = getAddress(tokenRaw);
  const feeRaw = envFirst("FIXED_FEE", "VITE_FIXED_FEE_RAW");
  if (!feeRaw) throw new Error("Missing FIXED_FEE in env");
  const FIXED_FEE = BigInt(feeRaw);
  const bundlerRaw = envFirst("BUNDLER", "VITE_BUNDLER");
  const BUNDLER_ADDR = bundlerRaw ? getAddress(bundlerRaw) : undefined;
  const MARKET_ADDR_RAW = envFirst("MARKET_ADDRESS", "VITE_MARKET_ADDRESS", "MARKET");
  const MARKET_ADDR = MARKET_ADDR_RAW && isAddress(MARKET_ADDR_RAW) ? getAddress(MARKET_ADDR_RAW) : undefined;
  const factoryRaw = envFirst("FACTORY", "VITE_FACTORY");
  const FACTORY_ADDR = factoryRaw ? getAddress(factoryRaw) : undefined;
  const ALLOWED_TARGETS = new Set(resolveTargetList(envValue("ALLOWED_TARGETS") ?? "").map(getAddress));

  const SELECTORS_BY_TARGET: Record<string, Set<string>> = {
    [MUSD_TOKEN]: new Set([
      id("transfer(address,uint256)").slice(0, 10),
      id("transferFrom(address,address,uint256)").slice(0, 10),
      id("approve(address,uint256)").slice(0, 10),
    ]),
  };

  return {
    provider,
    relayer,
    RELAYER_ADDR,
    MUSD_TOKEN,
    FIXED_FEE,
    BUNDLER_ADDR,
    MARKET_ADDR,
    FACTORY_ADDR,
    ALLOWED_TARGETS,
    SELECTORS_BY_TARGET,
  };
}

async function loadMarketAssetTargets(ctx: ReturnType<typeof createContext>): Promise<string[]> {
  if (!ctx.MARKET_ADDR) return [];
  const market = new Contract(ctx.MARKET_ADDR, MARKET_ABI, ctx.provider);

  let ids: string[] = [];
  try {
    ids = await market.getAllAssetIds();
  } catch {
    try {
      const out = await market.fullInventory();
      ids = out?.assetIds || out?.[2] || [];
    } catch {
      ids = [];
    }
  }

  const zeroId = `0x${"0".repeat(64)}`;
  const uniq = Array.from(new Set((ids || []).map((x: any) => String(x)))).filter((item) => item !== zeroId);
  if (!uniq.length) return [];

  const targets = await Promise.all(
    uniq.map(async (assetId: string) => {
      try {
        const info = await market.assets(assetId);
        const tokenAddr = info?.token ?? info?.[0];
        if (tokenAddr && tokenAddr !== "0x0000000000000000000000000000000000000000") {
          return getAddress(tokenAddr);
        }
      } catch {}
      try {
        const tokenAddr = await market.tokenAddress(assetId);
        if (tokenAddr && tokenAddr !== "0x0000000000000000000000000000000000000000") {
          return getAddress(tokenAddr);
        }
      } catch {}
      return null;
    })
  );

  return targets.filter(Boolean) as string[];
}

async function enrichAllowedTargets(ctx: ReturnType<typeof createContext>) {
  try {
    const targets = await loadMarketAssetTargets(ctx);
    targets.forEach((target) => ctx.ALLOWED_TARGETS.add(target));
  } catch {}
}

async function enforceWalletIsFromFactory(ctx: ReturnType<typeof createContext>, owner: string, wallet: string) {
  const walletAddr = getAddress(wallet);
  if (!ctx.FACTORY_ADDR) return walletAddr;

  const factory = new Contract(ctx.FACTORY_ADDR, FACTORY_ABI, ctx.relayer);
  const predicted: string = await factory.predictWallet(getAddress(owner));

  if (getAddress(predicted) !== walletAddr) {
    failPolicy(`wallet not predicted by FACTORY. predicted=${predicted} got=${wallet}`);
  }

  const code = await ctx.provider.getCode(predicted);
  if (code && code !== "0x") return predicted;

  const tx = await withRpcRetry(
    () => factory.createWallet(getAddress(owner)),
    "factory.createWallet"
  );
  await tx.wait();

  const codeAfter = await ctx.provider.getCode(predicted);
  if (!codeAfter || codeAfter === "0x") {
    throw new Error(`Wallet not deployed at predicted address ${predicted}`);
  }
  return predicted;
}

function enforceFixedFee(ctx: ReturnType<typeof createContext>, params: { feeToken: string; feeAmount: bigint; feeRecipient: string }) {
  if (getAddress(params.feeToken) !== ctx.MUSD_TOKEN) {
    failPolicy(`feeToken must be mUSD (${ctx.MUSD_TOKEN})`);
  }
  if (params.feeAmount !== ctx.FIXED_FEE) {
    failPolicy(`feeAmount must be FIXED_FEE (${ctx.FIXED_FEE.toString()})`);
  }
  if (getAddress(params.feeRecipient) !== ctx.RELAYER_ADDR) {
    failPolicy(`feeRecipient must be RELAYER_ADDR (${ctx.RELAYER_ADDR})`);
  }
}

function enforceAllowedCall(
  ctx: ReturnType<typeof createContext>,
  call: { to: string; value: bigint; data: string; operation: number }
) {
  if (call.operation !== 0) failPolicy("operation must be CALL (0)");
  if (call.value !== 0n) failPolicy("value must be 0 (no native transfers)");

  const to = getAddress(call.to);

  if (ctx.ALLOWED_TARGETS.size > 0 && !ctx.ALLOWED_TARGETS.has(to)) {
    failPolicy(`call.to not allowed: ${to}`);
  }

  const allowedSelectors = ctx.SELECTORS_BY_TARGET[to];
  if (allowedSelectors) {
    const sel = selectorOf(call.data);
    if (!allowedSelectors.has(sel)) {
      failPolicy(`selector not allowed for ${to}: ${sel}`);
    }
  }
}

function recordTx(x: RelayedTx) {
  const idx = relayedTxs.findIndex((t) => t.txHash === x.txHash);
  if (idx >= 0) relayedTxs[idx] = { ...relayedTxs[idx], ...x };
  else relayedTxs.push(x);

  relayedTxs.sort((a, b) => b.time - a.time);
  const MAX = Number(envValue("RELAYER_HISTORY_MAX") ?? "2000");
  if (relayedTxs.length > MAX) relayedTxs.length = MAX;
}

function trackReceipt(
  tx: { hash: string; wait: () => Promise<any> },
  base: Omit<RelayedTx, "status" | "blockNumber" | "error" | "time">
) {
  recordTx({ ...base, time: Date.now(), status: "pending" });
  tx.wait()
    .then((rcpt: any) => {
      recordTx({
        ...base,
        time: Date.now(),
        status: rcpt?.status === 1 ? "success" : "revert",
        blockNumber: rcpt?.blockNumber,
      });
    })
    .catch((e: any) => {
      recordTx({
        ...base,
        time: Date.now(),
        status: "revert",
        error: e?.message ?? String(e),
      });
    });
}

async function getChainId(ctx: ReturnType<typeof createContext>): Promise<bigint> {
  const net = await ctx.provider.getNetwork();
  return net.chainId;
}

export async function handleRelayerRequest(action: string, req: Request): Promise<JsonResponse> {
  try {
    const ctx = createContext();
    await enrichAllowedTargets(ctx);

    if (action === "createWallet" && req.method === "POST") {
      const { owner } = (await req.json()) as { owner?: string };
      if (!owner || !isAddress(owner)) return { status: 400, body: { error: "Invalid owner address" } };
      if (!ctx.FACTORY_ADDR) return { status: 400, body: { error: "Missing FACTORY in relayer env" } };

      const factory = new Contract(ctx.FACTORY_ADDR, FACTORY_ABI, ctx.relayer);
      const predicted: string = await factory.predictWallet(getAddress(owner));
      const code = await ctx.provider.getCode(predicted);
      if (code && code !== "0x") return { body: { alreadyDeployed: true, wallet: predicted } };

      const tx = await withRpcRetry(
        () => factory.createWallet(getAddress(owner)),
        "createWallet"
      );
      await tx.wait();
      return { body: { txHash: tx.hash, wallet: predicted } };
    }

    if (action === "execute" && req.method === "POST") {
      const { wallet, request, signature } = (await req.json()) as {
        wallet: string;
        request: ExecuteRequest;
        signature: string;
      };

      const walletAddr = getAddress(wallet);
      const w = new Contract(walletAddr, PROXY_WALLET_ABI, ctx.relayer);
      const chainId = await getChainId(ctx);
      const dom = domain(chainId, walletAddr);
      const onchainNonce: bigint = await w.nonce();
      if (BigInt(request.nonce) !== onchainNonce) {
        return { status: 400, body: { error: "Invalid nonce", onchainNonce: onchainNonce.toString() } };
      }

      const deadline = BigInt(request.deadline);
      if (deadline !== 0n && BigInt(Math.floor(Date.now() / 1000)) > deadline) {
        return { status: 400, body: { error: "Expired" } };
      }

      const owner: string = await w.owner();
      const reqObj = {
        call: {
          to: request.call.to,
          value: BigInt(request.call.value),
          data: request.call.data,
          operation: request.call.operation,
        },
        nonce: BigInt(request.nonce),
        deadline: BigInt(request.deadline),
        executor: request.executor,
        feeToken: request.feeToken,
        feeAmount: BigInt(request.feeAmount),
        feeRecipient: request.feeRecipient,
      };

      const recovered = verifyTypedData(
        dom,
        { Call: types.Call, Execute: types.Execute } as any,
        reqObj as any,
        signature
      );

      if (getAddress(recovered) !== getAddress(owner)) {
        return { status: 400, body: { error: "Bad signature", recovered, owner } };
      }

      await enforceWalletIsFromFactory(ctx, owner, walletAddr);
      if (getAddress(reqObj.executor) !== ctx.RELAYER_ADDR) {
        return { status: 400, body: { error: "POLICY_REJECTED: executor must be RELAYER_ADDR", expected: ctx.RELAYER_ADDR, got: reqObj.executor } };
      }
      enforceFixedFee(ctx, {
        feeToken: reqObj.feeToken,
        feeAmount: reqObj.feeAmount,
        feeRecipient: reqObj.feeRecipient,
      });
      enforceAllowedCall(ctx, reqObj.call);

      const tx = await withRpcRetry(
        () =>
          w.executeWithSig(
            {
              call: reqObj.call,
              nonce: reqObj.nonce,
              deadline: reqObj.deadline,
              executor: reqObj.executor,
              feeToken: reqObj.feeToken,
              feeAmount: reqObj.feeAmount,
              feeRecipient: reqObj.feeRecipient,
            },
            signature
          ),
        "executeWithSig"
      );

      trackReceipt(tx, {
        txHash: tx.hash,
        route: "/execute",
        owner,
        proxyWallet: walletAddr,
        to: reqObj.call.to,
        feeToken: reqObj.feeToken,
        feeRecipient: reqObj.feeRecipient,
        feeAmount: reqObj.feeAmount.toString(),
      });

      return { body: { txHash: tx.hash } };
    }

    if (action === "executeBatch" && req.method === "POST") {
      const { wallet, calls, request, signature } = (await req.json()) as {
        wallet: string;
        calls: Call[];
        request: ExecuteBatchRequest;
        signature: string;
      };

      const walletAddr = getAddress(wallet);
      const w = new Contract(walletAddr, PROXY_WALLET_ABI, ctx.relayer);
      const chainId = await getChainId(ctx);
      const dom = domain(chainId, walletAddr);
      const onchainNonce: bigint = await w.nonce();
      if (BigInt(request.nonce) !== onchainNonce) {
        return { status: 400, body: { error: "Invalid nonce", onchainNonce: onchainNonce.toString() } };
      }

      const deadline = BigInt(request.deadline);
      if (deadline !== 0n && BigInt(Math.floor(Date.now() / 1000)) > deadline) {
        return { status: 400, body: { error: "Expired" } };
      }

      const computed = hashCalls(calls);
      if (computed.toLowerCase() !== request.callsHash.toLowerCase()) {
        return { status: 400, body: { error: "CallsHash mismatch", computed, provided: request.callsHash } };
      }

      const owner: string = await w.owner();
      const recovered = verifyTypedData(
        dom,
        { ExecuteBatch: types.ExecuteBatch } as any,
        {
          callsHash: request.callsHash,
          nonce: BigInt(request.nonce),
          deadline: BigInt(request.deadline),
          executor: request.executor,
          feeToken: request.feeToken,
          feeAmount: BigInt(request.feeAmount),
          feeRecipient: request.feeRecipient,
        } as any,
        signature
      );

      if (getAddress(recovered) !== getAddress(owner)) {
        return { status: 400, body: { error: "Bad signature", recovered, owner } };
      }

      await enforceWalletIsFromFactory(ctx, owner, walletAddr);
      if (getAddress(request.executor) !== ctx.RELAYER_ADDR) {
        return { status: 400, body: { error: "POLICY_REJECTED: executor must be RELAYER_ADDR", expected: ctx.RELAYER_ADDR, got: request.executor } };
      }
      enforceFixedFee(ctx, {
        feeToken: request.feeToken,
        feeAmount: BigInt(request.feeAmount),
        feeRecipient: request.feeRecipient,
      });
      for (const call of calls) {
        enforceAllowedCall(ctx, {
          to: call.to,
          value: BigInt(call.value),
          data: call.data,
          operation: call.operation,
        });
      }

      const tx = await withRpcRetry(
        () =>
          w.executeBatchWithSig(
            calls.map((call) => ({
              to: call.to,
              value: BigInt(call.value),
              data: call.data,
              operation: call.operation,
            })),
            {
              callsHash: request.callsHash,
              nonce: BigInt(request.nonce),
              deadline: BigInt(request.deadline),
              executor: request.executor,
              feeToken: request.feeToken,
              feeAmount: BigInt(request.feeAmount),
              feeRecipient: request.feeRecipient,
            },
            signature
          ),
        "executeBatchWithSig"
      );

      trackReceipt(tx, {
        txHash: tx.hash,
        route: "/executeBatch",
        owner,
        proxyWallet: walletAddr,
        to: "batch",
        feeToken: request.feeToken,
        feeRecipient: request.feeRecipient,
        feeAmount: BigInt(request.feeAmount).toString(),
      });

      return { body: { txHash: tx.hash } };
    }

    if (action === "bundleExecute" && req.method === "POST") {
      const body = (await req.json()) as {
        token: string;
        owner: string;
        proxyWallet: string;
        pullAmount: string;
        permitNonce: string;
        permitDeadline: string;
        permitSig: { v: number; r: string; s: string };
        exec: any;
        execSig: string;
        bundler?: string;
      };

      const tokenAddr = getAddress(body.token);
      const owner = getAddress(body.owner);
      const proxyWallet = getAddress(body.proxyWallet);
      const pullAmount = BigInt(body.pullAmount);
      const permitDeadline = BigInt(body.permitDeadline);
      const bundlerAddr = getAddress(body.bundler ?? ctx.BUNDLER_ADDR ?? "");
      if (!isAddress(bundlerAddr)) return { status: 400, body: { error: "Missing/invalid bundler address" } };
      if (tokenAddr !== ctx.MUSD_TOKEN) {
        return { status: 400, body: { error: `POLICY_REJECTED: bundle token must be mUSD (${ctx.MUSD_TOKEN})`, got: tokenAddr } };
      }

      const chainId = (await ctx.provider.getNetwork()).chainId;
      const execToVerify = {
        call: {
          to: body.exec.call.to,
          value: BigInt(body.exec.call.value),
          data: body.exec.call.data,
          operation: Number(body.exec.call.operation),
        },
        nonce: BigInt(body.exec.nonce),
        deadline: BigInt(body.exec.deadline),
        executor: body.exec.executor,
        feeToken: body.exec.feeToken,
        feeAmount: BigInt(body.exec.feeAmount),
        feeRecipient: body.exec.feeRecipient,
      };

      const execRecovered = verifyTypedData(
        domain(chainId, proxyWallet),
        { Call: types.Call, Execute: types.Execute } as any,
        execToVerify as any,
        body.execSig
      );
      if (getAddress(execRecovered) !== owner) {
        return { status: 400, body: { error: "Bad exec signature", recovered: execRecovered, owner } };
      }

      await enforceWalletIsFromFactory(ctx, owner, proxyWallet);
      if (getAddress(execToVerify.executor) !== bundlerAddr) {
        return { status: 400, body: { error: "POLICY_REJECTED: exec.executor must be BUNDLER", expected: bundlerAddr, got: execToVerify.executor } };
      }
      enforceFixedFee(ctx, {
        feeToken: execToVerify.feeToken,
        feeAmount: execToVerify.feeAmount,
        feeRecipient: execToVerify.feeRecipient,
      });
      enforceAllowedCall(ctx, execToVerify.call);

      const tokenRead = new Contract(tokenAddr, ERC20_PERMIT_READ_ABI, ctx.provider);
      const tokenName: string = await tokenRead.name();
      const nonceOnchain: bigint = await tokenRead.nonces(owner);
      const nonceFromClient = BigInt(body.permitNonce);
      if (nonceFromClient !== nonceOnchain) {
        return { status: 400, body: { error: "POLICY_REJECTED: permit nonce mismatch", nonceOnchain: nonceOnchain.toString(), nonceFromClient: nonceFromClient.toString() } };
      }

      const permitDomain = {
        name: tokenName,
        version: "1",
        chainId,
        verifyingContract: tokenAddr,
      };
      const permitMsg = {
        owner,
        spender: bundlerAddr,
        value: pullAmount,
        nonce: nonceFromClient,
        deadline: permitDeadline,
      };
      const permitSigRaw = Signature.from(body.permitSig).serialized;
      const permitRecovered = verifyTypedData(
        permitDomain as any,
        PERMIT_TYPES as any,
        permitMsg as any,
        permitSigRaw
      );
      if (getAddress(permitRecovered) !== owner) {
        return { status: 400, body: { error: "Bad permit signature", recovered: permitRecovered, owner } };
      }

      const bundler = new Contract(bundlerAddr, RELAY_BUNDLER_ABI, ctx.relayer);
      await bundler.permitPullToWalletAndExecute.staticCall(
        tokenAddr,
        owner,
        proxyWallet,
        pullAmount,
        permitDeadline,
        body.permitSig.v,
        body.permitSig.r,
        body.permitSig.s,
        execToVerify,
        body.execSig
      );

      const gas = await bundler.permitPullToWalletAndExecute.estimateGas(
        tokenAddr,
        owner,
        proxyWallet,
        pullAmount,
        permitDeadline,
        body.permitSig.v,
        body.permitSig.r,
        body.permitSig.s,
        execToVerify,
        body.execSig
      );

      const tx = await withRpcRetry(
        () =>
          bundler.permitPullToWalletAndExecute(
            tokenAddr,
            owner,
            proxyWallet,
            pullAmount,
            permitDeadline,
            body.permitSig.v,
            body.permitSig.r,
            body.permitSig.s,
            execToVerify,
            body.execSig,
            { gasLimit: gas + gas / 5n }
          ),
        "permitPullToWalletAndExecute"
      );

      trackReceipt(tx, {
        txHash: tx.hash,
        route: "/bundleExecute",
        owner,
        proxyWallet,
        to: execToVerify.call.to,
        token: tokenAddr,
        feeToken: execToVerify.feeToken,
        feeRecipient: execToVerify.feeRecipient,
        feeAmount: execToVerify.feeAmount.toString(),
      });

      return { body: { txHash: tx.hash, bundler: bundlerAddr } };
    }

    if (action === "relayerStatus" && req.method === "GET") {
      const net = await ctx.provider.getNetwork();
      const eth = await ctx.provider.getBalance(ctx.relayer.address);
      const t = new Contract(
        ctx.MUSD_TOKEN,
        [
          "function symbol() view returns (string)",
          "function decimals() view returns (uint8)",
          "function balanceOf(address) view returns (uint256)",
        ],
        ctx.provider
      );
      const [symbol, decimals, bal] = await Promise.all([
        t.symbol().catch(() => "mUSD"),
        t.decimals().catch(() => 18),
        t.balanceOf(ctx.relayer.address),
      ]);

      return {
        body: {
          relayer: ctx.relayer.address,
          chainId: net.chainId.toString(),
          config: {
            factory: ctx.FACTORY_ADDR ?? null,
            bundler: ctx.BUNDLER_ADDR ?? null,
            token: ctx.MUSD_TOKEN,
            relayer: ctx.RELAYER_ADDR,
            market: ctx.MARKET_ADDR ?? null,
          },
          balances: {
            eth: eth.toString(),
            musd: {
              address: ctx.MUSD_TOKEN,
              symbol,
              decimals: Number(decimals),
              balance: bal.toString(),
            },
          },
          relayedTxs,
          recentTxs: relayedTxs.slice(0, 50),
        },
      };
    }

    if (action === "relayedTxs" && req.method === "GET") {
      return { body: { relayedTxs } };
    }

    return { status: 404, body: { error: "Not found" } };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const status = String(msg).startsWith("POLICY_REJECTED:") ? 400 : 500;
    return { status, body: { error: msg } };
  }
}
