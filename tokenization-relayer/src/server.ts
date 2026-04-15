import "dotenv/config";
import express from "express";
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
} from "../eip712";
import { hashCalls } from "./hashCalls";
import {
  PROXY_WALLET_ABI,
  RELAY_BUNDLER_ABI,
  ERC20_PERMIT_READ_ABI,
  FACTORY_ABI,
} from "./abi";

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// -------------------- env helpers
function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in env`);
  return v;
}

// -------------------- base env
const RPC_URL = mustEnv("RPC_URL");
const RELAYER_PK = mustEnv("RELAYER_PRIVATE_KEY");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const provider = new JsonRpcProvider(RPC_URL);
const relayer = new Wallet(RELAYER_PK, provider);

// --------- POLICY CONFIG (OFF-CHAIN)
const RELAYER_ADDR = getAddress(process.env.RELAYER_ADDR ?? relayer.address);

// fee token is fixed to mUSD = TOKEN
const MUSD_TOKEN = getAddress(mustEnv("TOKEN"));
const FIXED_FEE = BigInt(mustEnv("FIXED_FEE"));

const BUNDLER_ADDR = process.env.BUNDLER ? getAddress(process.env.BUNDLER) : undefined;

// ALLOWED_TARGETS can be either:
// - actual addresses: 0xabc...,0xdef...
// - or env-var names: PROXY_WALLET,FACTORY,BUNDLER,TOKEN
const ALLOWED_TARGETS = new Set(
  resolveTargetList(process.env.ALLOWED_TARGETS ?? "").map(getAddress)
);

// optional Market for auto-allowing listed asset tokens
const MARKET_ADDR_RAW = process.env.MARKET_ADDRESS ?? process.env.MARKET;
const MARKET_ADDR = MARKET_ADDR_RAW && isAddress(MARKET_ADDR_RAW) ? getAddress(MARKET_ADDR_RAW) : undefined;

// facoltativo ma consigliato: assicura che il wallet sia un clone della tua factory
const FACTORY_ADDR = process.env.FACTORY ? getAddress(process.env.FACTORY) : undefined;

// (opzionale) selector allowlist per target specifici.
const SELECTORS_BY_TARGET: Record<string, Set<string>> = {
  [MUSD_TOKEN]: new Set([
    id("transfer(address,uint256)").slice(0, 10),
    id("transferFrom(address,address,uint256)").slice(0, 10),
    id("approve(address,uint256)").slice(0, 10),
  ]),
};

const MARKET_ABI = [
  "function getAllAssetIds() view returns (bytes32[])",
  "function fullInventory() view returns (address[] makers,uint256[] makerStable, bytes32[] assetIds, uint256[][] balances)",
  "function assets(bytes32) view returns (address token,string symbolText,uint8 tokenDecimals,bool listed,uint256 minBuyAmount)",
  "function tokenAddress(bytes32) view returns (address)",
];

function selectorOf(calldata: string): string {
  if (!calldata || calldata === "0x" || calldata.length < 10) return "0x";
  return dataSlice(calldata, 0, 4);
}

function failPolicy(msg: string): never {
  throw new Error(`POLICY_REJECTED: ${msg}`);
}

async function enforceWalletIsFromFactory(owner: string, wallet: string) {
  const walletAddr = getAddress(wallet);
  if (!FACTORY_ADDR) return walletAddr;

  const factory = new Contract(FACTORY_ADDR, FACTORY_ABI, relayer);
  const predicted: string = await factory.predictWallet(getAddress(owner));

  if (getAddress(predicted) !== walletAddr) {
    failPolicy(`wallet not predicted by FACTORY. predicted=${predicted} got=${wallet}`);
  }

  const code = await provider.getCode(predicted);
  if (code && code !== "0x") return predicted;

  // deploy via relayer
  const tx = await factory.createWallet(getAddress(owner));
  await tx.wait();

  const codeAfter = await provider.getCode(predicted);
  if (!codeAfter || codeAfter === "0x") {
    throw new Error(`Wallet not deployed at predicted address ${predicted}`);
  }
  return predicted;
}

function enforceFixedFee(params: { feeToken: string; feeAmount: bigint; feeRecipient: string }) {
  if (getAddress(params.feeToken) !== MUSD_TOKEN) {
    failPolicy(`feeToken must be mUSD (${MUSD_TOKEN})`);
  }
  if (params.feeAmount !== FIXED_FEE) {
    failPolicy(`feeAmount must be FIXED_FEE (${FIXED_FEE.toString()})`);
  }
  if (getAddress(params.feeRecipient) !== RELAYER_ADDR) {
    failPolicy(`feeRecipient must be RELAYER_ADDR (${RELAYER_ADDR})`);
  }
}

function enforceAllowedCall(call: { to: string; value: bigint; data: string; operation: number }) {
  if (call.operation !== 0) failPolicy("operation must be CALL (0)");
  if (call.value !== 0n) failPolicy("value must be 0 (no native transfers)");

  const to = getAddress(call.to);

  // allowlist target (if list present)
  if (ALLOWED_TARGETS.size > 0 && !ALLOWED_TARGETS.has(to)) {
    failPolicy(`call.to not allowed: ${to}`);
  }

  // selector policy (only if exists for that target)
  const allowedSelectors = SELECTORS_BY_TARGET[to];
  if (allowedSelectors) {
    const sel = selectorOf(call.data);
    if (!allowedSelectors.has(sel)) {
      failPolicy(`selector not allowed for ${to}: ${sel}`);
    }
  }
}

function resolveTargetList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      if (item.startsWith("0x")) return item;

      const v = process.env[item];
      if (!v) throw new Error(`ALLOWED_TARGETS references missing env var: ${item}`);
      return v;
    });
}

async function loadMarketAssetTargets(): Promise<string[]> {
  if (!MARKET_ADDR) return [];
  const market = new Contract(MARKET_ADDR, MARKET_ABI, provider);

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
  const uniq = Array.from(new Set((ids || []).map((x: any) => String(x)))).filter(
    (id) => id !== zeroId
  );
  if (!uniq.length) return [];

  const targets = await Promise.all(
    uniq.map(async (id: string) => {
      try {
        const info = await market.assets(id);
        const tokenAddr = info?.token ?? info?.[0];
        if (tokenAddr && tokenAddr !== "0x0000000000000000000000000000000000000000") {
          return getAddress(tokenAddr);
        }
      } catch {}
      try {
        const tokenAddr = await market.tokenAddress(id);
        if (tokenAddr && tokenAddr !== "0x0000000000000000000000000000000000000000") {
          return getAddress(tokenAddr);
        }
      } catch {}
      return null;
    })
  );

  return targets.filter(Boolean) as string[];
}

if (MARKET_ADDR) {
  loadMarketAssetTargets()
    .then((targets) => {
      if (!targets.length) return;
      targets.forEach((t) => ALLOWED_TARGETS.add(t));
      console.log(`[relayer] allowed asset targets loaded: ${targets.length}`);
    })
    .catch((e) => {
      console.warn("[relayer] failed loading asset targets", e?.message ?? e);
    });
}

// -------------------- app + history
const app = express();

type RelayedTx = {
  time: number; // Date.now()
  route: string; // "/bundleExecute" | "/execute" | ...
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

const relayedTxs: RelayedTx[] = [];

function recordTx(x: RelayedTx) {
  const idx = relayedTxs.findIndex((t) => t.txHash === x.txHash);
  if (idx >= 0) relayedTxs[idx] = { ...relayedTxs[idx], ...x };
  else relayedTxs.push(x);

  relayedTxs.sort((a, b) => b.time - a.time);

  const MAX = Number(process.env.RELAYER_HISTORY_MAX ?? "2000");
  if (relayedTxs.length > MAX) relayedTxs.length = MAX;
}

// FIX: base NON deve richiedere `time` (lo settiamo noi)
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

// -------------------- CORS (manual)
app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "1mb" }));

async function getChainId(): Promise<bigint> {
  const net = await provider.getNetwork();
  return net.chainId;
}

// -------------------- /createWallet
app.post("/createWallet", async (req, res) => {
  try {
    const { owner } = req.body as { owner?: string };
    if (!owner || !isAddress(owner)) {
      return res.status(400).json({ error: "Invalid owner address" });
    }
    if (!FACTORY_ADDR) {
      return res.status(400).json({ error: "Missing FACTORY in relayer env" });
    }

    const factory = new Contract(FACTORY_ADDR, FACTORY_ABI, relayer);
    const predicted: string = await factory.predictWallet(getAddress(owner));

    const code = await provider.getCode(predicted);
    if (code && code !== "0x") {
      return res.json({ alreadyDeployed: true, wallet: predicted });
    }

    const tx = await factory.createWallet(getAddress(owner));
    await tx.wait();

    return res.json({ txHash: tx.hash, wallet: predicted });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.error(e);
    return res.status(500).json({ error: msg });
  }
});

// -------------------- /execute (NO bundler)
app.post("/execute", async (req, res) => {
  try {
    const { wallet, request, signature } = req.body as {
      wallet: string;
      request: ExecuteRequest;
      signature: string;
    };

    const walletAddr = getAddress(wallet);
    const w = new Contract(walletAddr, PROXY_WALLET_ABI, relayer);

    const chainId = await getChainId();
    const dom = domain(chainId, walletAddr);

    const onchainNonce: bigint = await w.nonce();
    if (BigInt(request.nonce) !== onchainNonce) {
      return res.status(400).json({ error: "Invalid nonce", onchainNonce: onchainNonce.toString() });
    }

    const deadline = BigInt(request.deadline);
    if (deadline !== 0n && BigInt(Math.floor(Date.now() / 1000)) > deadline) {
      return res.status(400).json({ error: "Expired" });
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
      return res.status(400).json({ error: "Bad signature", recovered, owner });
    }

    // POLICY
    await enforceWalletIsFromFactory(owner, walletAddr);

    if (getAddress(reqObj.executor) !== RELAYER_ADDR) {
      return res.status(400).json({
        error: "POLICY_REJECTED: executor must be RELAYER_ADDR",
        expected: RELAYER_ADDR,
        got: reqObj.executor,
      });
    }

    enforceFixedFee({
      feeToken: reqObj.feeToken,
      feeAmount: reqObj.feeAmount,
      feeRecipient: reqObj.feeRecipient,
    });

    enforceAllowedCall({
      to: reqObj.call.to,
      value: reqObj.call.value,
      data: reqObj.call.data,
      operation: reqObj.call.operation,
    });

    const tx = await w.executeWithSig(
      {
        call: {
          to: reqObj.call.to,
          value: reqObj.call.value,
          data: reqObj.call.data,
          operation: reqObj.call.operation,
        },
        nonce: reqObj.nonce,
        deadline: reqObj.deadline,
        executor: reqObj.executor,
        feeToken: reqObj.feeToken,
        feeAmount: reqObj.feeAmount,
        feeRecipient: reqObj.feeRecipient,
      },
      signature
    );

    // SAME HISTORY LOGIC
    trackReceipt(tx, {
      txHash: tx.hash,
      route: "/execute",
      owner,
      proxyWallet: walletAddr,
      to: reqObj.call.to,
      token: undefined,
      feeToken: reqObj.feeToken,
      feeRecipient: reqObj.feeRecipient,
      feeAmount: reqObj.feeAmount.toString(),
    });

    return res.json({ txHash: tx.hash });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (String(msg).startsWith("POLICY_REJECTED:")) return res.status(400).json({ error: msg });
    console.error(e);
    return res.status(500).json({ error: msg });
  }
});

// -------------------- /executeBatch
app.post("/executeBatch", async (req, res) => {
  try {
    const { wallet, calls, request, signature } = req.body as {
      wallet: string;
      calls: Call[];
      request: ExecuteBatchRequest;
      signature: string;
    };

    const walletAddr = getAddress(wallet);
    const w = new Contract(walletAddr, PROXY_WALLET_ABI, relayer);

    const chainId = await getChainId();
    const dom = domain(chainId, walletAddr);

    const onchainNonce: bigint = await w.nonce();
    if (BigInt(request.nonce) !== onchainNonce) {
      return res.status(400).json({ error: "Invalid nonce", onchainNonce: onchainNonce.toString() });
    }

    const deadline = BigInt(request.deadline);
    if (deadline !== 0n && BigInt(Math.floor(Date.now() / 1000)) > deadline) {
      return res.status(400).json({ error: "Expired" });
    }

    const computed = hashCalls(calls);
    if (computed.toLowerCase() !== request.callsHash.toLowerCase()) {
      return res.status(400).json({ error: "CallsHash mismatch", computed, provided: request.callsHash });
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
      return res.status(400).json({ error: "Bad signature", recovered, owner });
    }

    // POLICY
    await enforceWalletIsFromFactory(owner, walletAddr);

    if (getAddress(request.executor) !== RELAYER_ADDR) {
      return res.status(400).json({
        error: "POLICY_REJECTED: executor must be RELAYER_ADDR",
        expected: RELAYER_ADDR,
        got: request.executor,
      });
    }

    enforceFixedFee({
      feeToken: request.feeToken,
      feeAmount: BigInt(request.feeAmount),
      feeRecipient: request.feeRecipient,
    });

    for (const c of calls) {
      enforceAllowedCall({
        to: c.to,
        value: BigInt(c.value),
        data: c.data,
        operation: c.operation,
      });
    }

    const tx = await w.executeBatchWithSig(
      calls.map((c) => ({
        to: c.to,
        value: BigInt(c.value),
        data: c.data,
        operation: c.operation,
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
    );

    // SAME HISTORY LOGIC
    trackReceipt(tx, {
      txHash: tx.hash,
      route: "/executeBatch",
      owner,
      proxyWallet: walletAddr,
      to: "batch",
      token: undefined,
      feeToken: request.feeToken,
      feeRecipient: request.feeRecipient,
      feeAmount: BigInt(request.feeAmount).toString(),
    });

    return res.json({ txHash: tx.hash });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (String(msg).startsWith("POLICY_REJECTED:")) return res.status(400).json({ error: msg });
    console.error(e);
    return res.status(500).json({ error: msg });
  }
});

// -------------------- /bundleExecute (permit + pull + execute)
app.post("/bundleExecute", async (req, res) => {
  try {
    const body = req.body as {
      token: string;
      owner: string;
      proxyWallet: string;
      pullAmount: string;
      permitNonce: string; // <-- ADD
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

    const v = body.permitSig.v;
    const r = body.permitSig.r;
    const s = body.permitSig.s;

    const bundlerAddr = getAddress(body.bundler ?? BUNDLER_ADDR ?? "");
    if (!isAddress(bundlerAddr)) {
      return res.status(400).json({ error: "Missing/invalid bundler address" });
    }

    // POLICY: bundler route must use mUSD token
    if (tokenAddr !== MUSD_TOKEN) {
      return res.status(400).json({
        error: `POLICY_REJECTED: bundle token must be mUSD (${MUSD_TOKEN})`,
        got: tokenAddr,
      });
    }

    const chainId = (await provider.getNetwork()).chainId;

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
      return res.status(400).json({ error: "Bad exec signature", recovered: execRecovered, owner });
    }

    await enforceWalletIsFromFactory(owner, proxyWallet);

    if (getAddress(execToVerify.executor) !== bundlerAddr) {
      return res.status(400).json({
        error: "POLICY_REJECTED: exec.executor must be BUNDLER",
        expected: bundlerAddr,
        got: execToVerify.executor,
      });
    }

    enforceFixedFee({
      feeToken: execToVerify.feeToken,
      feeAmount: execToVerify.feeAmount,
      feeRecipient: execToVerify.feeRecipient,
    });

    enforceAllowedCall({
      to: execToVerify.call.to,
      value: execToVerify.call.value,
      data: execToVerify.call.data,
      operation: execToVerify.call.operation,
    });

    // permit verification
    const tokenRead = new Contract(tokenAddr, ERC20_PERMIT_READ_ABI, provider);
    const tokenName: string = await tokenRead.name();
    const nonceOnchain: bigint = await tokenRead.nonces(owner);
    

    const permitDomain = {
      name: tokenName,
      version: "1",
      chainId,
      verifyingContract: tokenAddr,
    };

    const nonceFromClient = BigInt((body as any).permitNonce);

    if (nonceFromClient !== nonceOnchain) {
      return res.status(400).json({
        error: "POLICY_REJECTED: permit nonce mismatch",
        nonceOnchain: nonceOnchain.toString(),
        nonceFromClient: nonceFromClient.toString(),
      });
    }

    const permitMsg = {
      owner,
      spender: bundlerAddr,
      value: pullAmount,
      nonce: nonceFromClient,
      deadline: permitDeadline,
    };

    const permitSigRaw = Signature.from({ v, r, s }).serialized;
    const permitRecovered = verifyTypedData(
      permitDomain as any,
      PERMIT_TYPES as any,
      permitMsg as any,
      permitSigRaw
    );

    if (getAddress(permitRecovered) !== owner) {
      return res.status(400).json({ error: "Bad permit signature", recovered: permitRecovered, owner });
    }

    const bundler = new Contract(bundlerAddr, RELAY_BUNDLER_ABI, relayer);

    await bundler.permitPullToWalletAndExecute.staticCall(
      tokenAddr,
      owner,
      proxyWallet,
      pullAmount,
      permitDeadline,
      v,
      r,
      s,
      {
        call: {
          to: execToVerify.call.to,
          value: execToVerify.call.value,
          data: execToVerify.call.data,
          operation: execToVerify.call.operation,
        },
        nonce: execToVerify.nonce,
        deadline: execToVerify.deadline,
        executor: execToVerify.executor,
        feeToken: execToVerify.feeToken,
        feeAmount: execToVerify.feeAmount,
        feeRecipient: execToVerify.feeRecipient,
      },
      body.execSig
    );

    const gas = await bundler.permitPullToWalletAndExecute.estimateGas(
      tokenAddr,
      owner,
      proxyWallet,
      pullAmount,
      permitDeadline,
      v,
      r,
      s,
      {
        call: {
          to: execToVerify.call.to,
          value: execToVerify.call.value,
          data: execToVerify.call.data,
          operation: execToVerify.call.operation,
        },
        nonce: execToVerify.nonce,
        deadline: execToVerify.deadline,
        executor: execToVerify.executor,
        feeToken: execToVerify.feeToken,
        feeAmount: execToVerify.feeAmount,
        feeRecipient: execToVerify.feeRecipient,
      },
      body.execSig
    );

    const tx = await bundler.permitPullToWalletAndExecute(
      tokenAddr,
      owner,
      proxyWallet,
      pullAmount,
      permitDeadline,
      v,
      r,
      s,
      {
        call: {
          to: execToVerify.call.to,
          value: execToVerify.call.value,
          data: execToVerify.call.data,
          operation: execToVerify.call.operation,
        },
        nonce: execToVerify.nonce,
        deadline: execToVerify.deadline,
        executor: execToVerify.executor,
        feeToken: execToVerify.feeToken,
        feeAmount: execToVerify.feeAmount,
        feeRecipient: execToVerify.feeRecipient,
      },
      body.execSig,
      { gasLimit: gas + gas / 5n }
    );

    // SAME HISTORY LOGIC
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

    return res.json({ txHash: tx.hash, bundler: bundlerAddr });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (String(msg).startsWith("POLICY_REJECTED:")) return res.status(400).json({ error: msg });
    console.error(e);
    return res.status(500).json({ error: msg });
  }
});

// -------------------- monitoring endpoints
app.get("/relayerStatus", async (req, res) => {
  try {
    const net = await provider.getNetwork();
    const eth = await provider.getBalance(relayer.address);

    // usa TOKEN (MUSD_TOKEN) per la balance mUSD
    const musdAddr = getAddress(MUSD_TOKEN);
    const t = new Contract(
      musdAddr,
      [
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)",
        "function balanceOf(address) view returns (uint256)",
      ],
      provider
    );

    const [symbol, decimals, bal] = await Promise.all([
      t.symbol().catch(() => "mUSD"),
      t.decimals().catch(() => 18),
      t.balanceOf(relayer.address),
    ]);

    const musd = {
      address: musdAddr,
      symbol,
      decimals: Number(decimals),
      balance: bal.toString(),
    };

    return res.json({
      relayer: relayer.address,
      chainId: net.chainId.toString(),
      config: {
        factory: FACTORY_ADDR ?? null,
        bundler: BUNDLER_ADDR ?? null,
        token: MUSD_TOKEN,
        relayer: RELAYER_ADDR,
        market: MARKET_ADDR ?? null,
      },
      balances: {
        eth: eth.toString(),
        musd,
      },
      relayedTxs,
      recentTxs: relayedTxs.slice(0, 50),
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get("/relayedTxs", async (req, res) => {
  return res.json({ relayedTxs });
});

app.listen(PORT, HOST, () => {
  console.log(`Relayer listening on ${HOST}:${PORT}, relayer=${relayer.address}`);
});
