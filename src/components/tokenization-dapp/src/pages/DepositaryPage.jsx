import React, { useEffect, useMemo, useRef, useState } from "react";
import { Contract, ethers, isAddress } from "ethers";

// ─────────────────── ABIs ───────────────────

// Market: nel tuo Market.sol esistono questi (coerenti col file che hai caricato)
const MARKET_ABI = [
  "function getAllAssetIds() view returns (bytes32[])",
  "function assets(bytes32) view returns (address token,string symbolText,uint8 tokenDecimals,bool listed,uint256 minBuyAmount)",
  "event AssetListed(bytes32 id, address token, string symbolText, uint8 tokenDecimals, uint256 minBuyAmount)",
  "event AssetUnlisted(bytes32 id)",
];

// SecurityTokenBase (Stable/Fund/Equity proxy): coerente con SecurityTokenBase.sol
const SECURITY_TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function authorizeMint(address investor, uint256 amount, bytes32 orderId)",
  "function authorizeBurn(address investor, uint256 shares, bytes32 orderId, uint256 netPaid)",
  "event MintProposed(address indexed investor, uint256 netAmount, bytes32 orderId)",
  "event BurnProposed(address indexed investor, uint256 shares, bytes32 orderId)",
];

// ─────────────────── helpers ───────────────────
const DEPOSITARY_ROLE = ethers.id("DEPOSITARY_ROLE");

const fmt = (v, dec = 18) => {
  try {
    return ethers.formatUnits(v ?? 0n, dec);
  } catch {
    return String(v ?? 0);
  }
};

const parseToUnitsSafe = (s, dec) => {
  try {
    if (s == null || String(s).trim() === "") return null;
    return ethers.parseUnits(String(s), dec);
  } catch {
    return null;
  }
};

const normalizeOrderId = (s) =>
  /^0x[0-9a-fA-F]{64}$/.test(String(s || "")) ? String(s) : ethers.id(String(s ?? ""));

const normIdHex = (x) => {
  try {
    return ethers.hexlify(x).toLowerCase();
  } catch {
    return String(x ?? "").toLowerCase();
  }
};

async function queryEventsChunked(contract, filter, from, to, step = 5000) {
  const out = [];
  let start = from;
  while (start <= to) {
    const end = Math.min(start + step - 1, to);
    try {
      const logs = await contract.queryFilter(filter, start, end);
      out.push(...logs);
    } catch (e) {
      if (step > 256) {
        const partial = await queryEventsChunked(contract, filter, start, end, Math.floor(step / 2));
        out.push(...partial);
      } else {
        throw e;
      }
    }
    start = end + 1;
  }
  return out;
}

async function tryGetDeploymentBlock(contract) {
  try {
    const tx = await contract.deploymentTransaction?.();
    if (tx && tx.blockNumber != null) return Number(tx.blockNumber);
  } catch {}
  return null;
}

const normTxHash = (evt) =>
  evt?.transactionHash ??
  evt?.log?.transactionHash ??
  evt?.receipt?.hash ??
  evt?.hash ??
  "";

const normLogIndex = (evt) =>
  evt?.logIndex ??
  evt?.index ??
  evt?.log?.index ??
  evt?.log?.logIndex ??
  0;

const normBlockNumber = (evt) =>
  evt?.blockNumber ??
  evt?.log?.blockNumber ??
  0;


// ─────────────────── Component ───────────────────
export default function DepositaryPage({
  provider,
  account,

  marketAddress,
  stableAddress, // StableToken proxy
  fundsAddress,  // FundToken proxy (opzionale, ma consigliato)
  // (oracleAddress non serve qui: nel nuovo flow non c’è oracle in Depositary)

  expectedChainId,
  marketDeployBlock = 0,

  onError,
}) {
  const [status, setStatus] = useState("");
  const [authorized, setAuthorized] = useState(null);

  // Stable meta
  const [stableSymbol, setStableSymbol] = useState("STABLE");
  const [stableDecimals, setStableDecimals] = useState(6);

  // Fund meta (optional)
  const [fundSymbol, setFundSymbol] = useState("FUND");
  const [fundDecimals, setFundDecimals] = useState(18);

  // Assets meta from Market
  const [assetMetas, setAssetMetas] = useState([]); // {id, token, symbol, decimals, listed}

  const [lastTx, setLastTx] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const fundAddrRaw = fundsAddress ?? arguments?.[0]?.fundAddress; // fallback if App passes fundAddress
  const fundAddr = typeof fundAddrRaw === "string" ? fundAddrRaw.trim() : fundAddrRaw;

  console.log("DepositaryPage debug:");
  console.log("fundsAddress prop =", fundsAddress);
  console.log("fundAddrRaw =", fundAddrRaw);
  console.log("fundAddr =", fundAddr);
  console.log("isAddress(fundAddr) =", isAddress(fundAddr));
  console.log("stableAddress =", stableAddress, "isAddress =", isAddress(stableAddress));
  console.log("assetMetas tokens =", assetMetas.map(a => ({ token: a.token, symbol: a.symbol, id: a.id })));


  const connected = !!provider && !!account;

  const market = useMemo(
    () => (provider && marketAddress ? new Contract(marketAddress, MARKET_ABI, provider) : null),
    [provider, marketAddress]
  );

  const stableToken = useMemo(
    () => (provider && stableAddress ? new Contract(stableAddress, SECURITY_TOKEN_ABI, provider) : null),
    [provider, stableAddress]
  );

   const fundToken = useMemo(
    () => (provider && isAddress(fundAddr) ? new Contract(fundAddr, SECURITY_TOKEN_ABI, provider) : null),
    [provider, fundAddr]
  );


  // ───────── role gate: check depositary role on STABLE (scelta pratica: è sempre presente) ─────────
  useEffect(() => {
    (async () => {
      if (!provider || !account) {
        setAuthorized(null);
        return;
      }
      if (!stableToken) {
        setAuthorized(false);
        setStatus("Configure Stable Token proxy address.");
        return;
      }
      try {
        const [sym, dec] = await Promise.all([
          stableToken.symbol().catch(() => "STABLE"),
          stableToken.decimals().catch(() => 6),
        ]);
        setStableSymbol(sym);
        setStableDecimals(Number(dec));

        try {
          const ok = Boolean(await stableToken.hasRole(DEPOSITARY_ROLE, account));
          setAuthorized(ok);
        } catch {
          setAuthorized(true);
          setStatus("ℹ️ Contract without hasRole: role-gate disabled.");
        }
      } catch (e) {
        const msg = e?.shortMessage || e?.reason || e?.message || String(e);
        setAuthorized(false);
        setStatus(`Error reading stable token: ${msg}`);
      }
    })();
  }, [provider, account, stableToken, refreshNonce]);

  // ───────── read fund meta ─────────
  useEffect(() => {
    (async () => {
      if (!fundToken) return;
      try {
        const [sym, dec] = await Promise.all([
          fundToken.symbol().catch(() => "FUND"),
          fundToken.decimals().catch(() => 18),
        ]);
        setFundSymbol(sym);
        setFundDecimals(Number(dec));
      } catch {}
    })();
  }, [fundToken, refreshNonce]);


  // ───────── DEBUG: probe eventi sul FUND ─────────
useEffect(() => {
  (async () => {
    if (!provider || !fundToken || !isAddress(fundAddr)) return;
    try {
      const tip = await provider.getBlockNumber();
      const from = Math.max(0, tip - 5000);

      const [m, b] = await Promise.all([
        fundToken.queryFilter(fundToken.filters.MintProposed(), from, tip),
        fundToken.queryFilter(fundToken.filters.BurnProposed(), from, tip),
      ]);

      console.log("[FUND PROBE]", {
        fundAddr,
        range: [from, tip],
        MintProposed: m.length,
        BurnProposed: b.length,
      });

      if (m[0]) console.log("[FUND PROBE sample Mint]", m[0].args);
      if (b[0]) console.log("[FUND PROBE sample Burn]", b[0].args);
    } catch (e) {
      console.log("[FUND PROBE error]", e);
    }
  })();
}, [provider, fundToken, fundAddr]);


  // ───────── asset list from Market (getter + fallback events) ─────────
  useEffect(() => {
    (async () => {
      if (!market || !provider) return;

      try {
        let metas = [];

        try {
          const ids = await market.getAllAssetIds();
          const uniq = Array.from(new Set((ids || []).map(normIdHex)));

          metas = await Promise.all(
            uniq.map(async (id) => {
              const info = await market.assets(id);
              const tokenAddr = info?.token ?? info?.[0] ?? "";
              const symbolText = info?.symbolText ?? info?.[1] ?? "—";
              const dec = Number(info?.tokenDecimals ?? info?.[2] ?? 18);
              const listed = Boolean(info?.listed ?? info?.[3] ?? true);
              return { id, token: tokenAddr, symbol: symbolText, decimals: dec, listed };
            })
          );
        } catch {
          // fallback via events
          const tip = await provider.getBlockNumber();
          const from =
            (marketDeployBlock && Number(marketDeployBlock) > 0
              ? Number(marketDeployBlock)
              : (await tryGetDeploymentBlock(market)) ?? Math.max(0, tip - 100000));

          const [listedEvts, unlistedEvts] = await Promise.all([
            queryEventsChunked(market, market.filters.AssetListed(), from, tip, 5000),
            queryEventsChunked(market, market.filters.AssetUnlisted(), from, tip, 5000),
          ]);

          const map = new Map();
          for (const e of listedEvts) {
            const { id, token, symbolText, tokenDecimals } = e.args || {};
            const k = normIdHex(id);
            if (!k) continue;
            map.set(k, { id: k, token, symbol: symbolText, decimals: Number(tokenDecimals ?? 18), listed: true });
          }
          for (const e of unlistedEvts) {
            const { id } = e.args || {};
            const k = normIdHex(id);
            const it = map.get(k);
            if (it) map.set(k, { ...it, listed: false });
          }
          metas = Array.from(map.values());
        }

        const listed = metas.filter((m) => m.listed && isAddress(m.token));
        setAssetMetas(listed);
      } catch (e) {
        const msg = e?.shortMessage || e?.reason || e?.message || String(e);
        setStatus(`⚠️ Cannot read asset list: ${msg}`);
        onError && onError(msg);
      }
    })();
  }, [market, provider, marketDeployBlock, refreshNonce]);

  // ───────── Build list of all tokens to monitor (stable + fund + equities) ─────────
  const monitoredTokens = useMemo(() => {
    const list = [];

    if (isAddress(stableAddress)) {
      list.push({
        kind: "STABLE",
        address: stableAddress,
        label: stableSymbol || "STABLE",
        decimals: stableDecimals ?? 6,
      });
    }

    if (isAddress(fundAddr)) {
      list.push({
        kind: "FUND",
        address: fundAddr,
        label: fundSymbol || "FUND",
        decimals: fundDecimals ?? 18,
      });
    }


    const stableLower = isAddress(stableAddress) ? stableAddress.toLowerCase() : "";
    const fundLower = isAddress(fundAddr) ? fundAddr.toLowerCase() : "";

    for (const a of assetMetas) {
      if (!isAddress(a.token)) continue;

      const tokenLower = a.token.toLowerCase();
      if (stableLower && tokenLower === stableLower) continue; // don't label stable as equity
      if (fundLower && tokenLower === fundLower) continue;     // don't label fund as equity

      list.push({
        kind: "EQUITY",
        address: a.token,
        label: a.symbol || "ASSET",
        decimals: a.decimals ?? 18,
        assetId: a.id,
      });
    }


    // dedupe by address
    const seen = new Set();
    return list.filter((t) => {
      const k = String(t.address).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [
    stableAddress,
    fundAddr,
    assetMetas,
    stableSymbol,
    stableDecimals,
    fundSymbol,
    fundDecimals,
  ]);

  // ───────── proposals state ─────────
  const [proposals, setProposals] = useState([]);
  
  const knownEventKeys = useRef(new Set()); // evKey (dedupe per evento)
  const rejectedKeysRef = useRef(new Set()); // persisted
  const lastScannedRef = useRef(new Map()); // Map<tokenAddrLower, lastBlockScanned>

  useEffect(() => {
    try {
      const raw = localStorage.getItem("depositary.rejected.v2");
      const arr = raw ? JSON.parse(raw) : [];
      rejectedKeysRef.current = new Set((Array.isArray(arr) ? arr : []).filter((k) => typeof k === "string"));
    } catch {}
  }, []);

  const proposalKey = (tokenAddr, kind, investor, amountOrShares, orderId) => {
    const ta = String(tokenAddr || "").toLowerCase();
    const k = String(kind || "");
    const inv = String(investor || "").toLowerCase();
    const q = typeof amountOrShares === "bigint" ? amountOrShares.toString() : String(amountOrShares ?? "");
    const oid = orderId != null ? normIdHex(orderId) : "";
    return `${ta}:${k}:${inv}:${q}:${oid}`;
  };

  const pushProposal = async ({ tokenAddr, tokenLabel, tokenDecimals, kind, investor, qty, orderId, evt }) => {
    try {
      const txh = normTxHash(evt);
      const lidx = normLogIndex(evt);
      const bno = normBlockNumber(evt);

     const pKey = proposalKey(tokenAddr, kind, investor, qty, orderId);

      // ✅ evKey = identità dell’evento (txHash + logIndex)
      const evKey = txh ? `${txh}:${lidx}` : `${bno}:${lidx}`;

      // ✅ rifiuto e dedupe devono usare evKey (non pKey)
      if (rejectedKeysRef.current.has(evKey)) return;
      if (knownEventKeys.current.has(evKey)) return;
      knownEventKeys.current.add(evKey);


      setProposals((prev) => [
        {
          key: evKey,   // <-- IMPORTANTISSIMO: key = pKey
          evKey,
          pKey,
          tokenAddr,
          tokenLabel,
          tokenDecimals,
          kind,
          investor,
          qty,
          orderId,
          txHash: txh,
          blockNumber: bno,
          netPaidStr: kind === "BURN" ? fmt(qty, tokenDecimals) : "",
        },
        ...prev,
      ]);

    } catch {}
  };

  // ───────── LIVE listeners on every monitored token ─────────
  useEffect(() => {
    if (!provider) return;
    if (!monitoredTokens.length) return;

    const contracts = monitoredTokens
      .filter((t) => isAddress(t.address))
      .map((t) => ({
        meta: t,
        c: new Contract(t.address, SECURITY_TOKEN_ABI, provider),
      }));

    const cleaners = [];

    for (const { meta, c } of contracts) {
      const onMint = (investor, netAmount, orderId, evt) => {
        pushProposal({
          tokenAddr: meta.address,
          tokenLabel: meta.label,
          tokenDecimals: meta.decimals,
          kind: "MINT",
          investor,
          qty: netAmount,
          orderId,
          evt,
        });
      };

      const onBurn = (investor, shares, orderId, evt) => {
        pushProposal({
          tokenAddr: meta.address,
          tokenLabel: meta.label,
          tokenDecimals: meta.decimals,
          kind: "BURN",
          investor,
          qty: shares,
          orderId,
          evt,
        });
      };

      c.on("MintProposed", onMint);
      c.on("BurnProposed", onBurn);

      cleaners.push(() => {
        c.off("MintProposed", onMint);
        c.off("BurnProposed", onBurn);
      });
    }

    return () => cleaners.forEach((fn) => fn());
  }, [provider, monitoredTokens, refreshNonce]);


  useEffect(() => {
    if (!provider || monitoredTokens.length === 0) return;

    let stopped = false;

    const onBlock = async (bn) => {
      if (stopped) return;

      const tip = Number(bn);

      for (const t of monitoredTokens) {
        if (!isAddress(t.address)) continue;

        const addr = t.address.toLowerCase();
        const last = lastScannedRef.current.get(addr);

        // sicurezza: se non hai mai scansionato, guarda gli ultimi 100 blocchi
        const from = last != null ? last + 1 : Math.max(0, tip - 100);

        if (from > tip) {
          lastScannedRef.current.set(addr, tip);
          continue;
        }

        const c = new Contract(t.address, SECURITY_TOKEN_ABI, provider);

        let mints = [];
        let burns = [];
        try {
          [mints, burns] = await Promise.all([
            c.queryFilter(c.filters.MintProposed(), from, tip),
            c.queryFilter(c.filters.BurnProposed(), from, tip),
          ]);
        } catch {
          // se il provider ha limiti, non bloccare tutto
        }

        for (const evt of mints) {
          const { investor, netAmount, orderId } = evt.args || {};
          await pushProposal({
            tokenAddr: t.address,
            tokenLabel: t.label,
            tokenDecimals: t.decimals,
            kind: "MINT",
            investor,
            qty: netAmount,
            orderId,
            evt,
          });
        }

        for (const evt of burns) {
          const { investor, shares, orderId } = evt.args || {};
          await pushProposal({
            tokenAddr: t.address,
            tokenLabel: t.label,
            tokenDecimals: t.decimals,
            kind: "BURN",
            investor,
            qty: shares,
            orderId,
            evt,
          });
        }

        lastScannedRef.current.set(addr, tip);
      }
    };

    provider.on("block", onBlock);

    return () => {
      stopped = true;
      provider.off("block", onBlock);
    };
  }, [provider, monitoredTokens, refreshNonce]);



  // ───────── BOOTSTRAP history (scan events on every monitored token) ─────────
  useEffect(() => {
    (async () => {
      if (!provider) return;
      if (!monitoredTokens.length) return;

      try {
        const tip = await provider.getBlockNumber();

        for (const t of monitoredTokens) {
          if (!isAddress(t.address)) continue;
          const c = new Contract(t.address, SECURITY_TOKEN_ABI, provider);

          const from =
            (await tryGetDeploymentBlock(c)) ??
            (marketDeployBlock && Number(marketDeployBlock) > 0
              ? Number(marketDeployBlock)
              : Math.max(0, tip - 100000));

          const [mints, burns] = await Promise.all([
            queryEventsChunked(c, c.filters.MintProposed(), from, tip, 5000),
            queryEventsChunked(c, c.filters.BurnProposed(), from, tip, 5000),
          ]);

          const ordered = [...mints, ...burns].sort(
            (a, b) => normBlockNumber(a) - normBlockNumber(b) || normLogIndex(a) - normLogIndex(b)
          );

          for (const evt of ordered) {
            const name = evt?.fragment?.name || evt?.event;
            if (name === "MintProposed") {
              const { investor, netAmount, orderId } = evt.args || {};
              await pushProposal({
                tokenAddr: t.address,
                tokenLabel: t.label,
                tokenDecimals: t.decimals,
                kind: "MINT",
                investor,
                qty: netAmount,
                orderId,
                evt: {
                  blockNumber: normBlockNumber(evt),
                  transactionHash: normTxHash(evt),
                  logIndex: normLogIndex(evt),
                  log: { transactionHash: normTxHash(evt), index: normLogIndex(evt) },
                },
              });
            } else {
              const { investor, shares, orderId } = evt.args || {};
              await pushProposal({
                tokenAddr: t.address,
                tokenLabel: t.label,
                tokenDecimals: t.decimals,
                kind: "BURN",
                investor,
                qty: shares,
                orderId,
                evt: {
                  blockNumber: normBlockNumber(evt),
                  transactionHash: normTxHash(evt),
                  logIndex: normLogIndex(evt),
                  log: { transactionHash: normTxHash(evt), index: normLogIndex(evt) },
                },
              });
            }
          }
        }
      } catch (e) {
        const msg = e?.shortMessage || e?.reason || e?.message || String(e);
        setStatus(`⚠️ Error bootstrapping history: ${msg}`);
      }
    })();
  }, [provider, monitoredTokens, marketDeployBlock, refreshNonce]);

  // ───────── actions ─────────
  const persistReject = (evKey) => {
    try {
      rejectedKeysRef.current.add(evKey);
      localStorage.setItem("depositary.rejected.v2", JSON.stringify(Array.from(rejectedKeysRef.current)));
    } catch {}
  };

  async function approveProposal(p) {
    if (!provider || !account) return setStatus("⚠️ Wallet not connected.");
    if (!isAddress(p.tokenAddr)) return setStatus("⚠️ Bad token address in proposal.");

    try {
      const s = await provider.getSigner();
      const t = new Contract(p.tokenAddr, SECURITY_TOKEN_ABI, s);
      const oid = normalizeOrderId(p.orderId);

      if (p.kind === "MINT") {
        setStatus("Sending authorizeMint…");
        const tx = await t.authorizeMint(p.investor, p.qty, oid);
        setLastTx(tx.hash);
        await tx.wait();
        setStatus(`✅ Mint authorized: ${tx.hash}`);
      } else {
        // Burn: need netPaid (4th param). Default is prefilled but editable.
        const netPaid = parseToUnitsSafe(p.netPaidStr, p.tokenDecimals);
        if (netPaid == null) return setStatus("⚠️ netPaid missing/invalid (Burn).");

        setStatus("Sending authorizeBurn…");
        const tx = await t.authorizeBurn(p.investor, p.qty, oid, netPaid);
        setLastTx(tx.hash);
        await tx.wait();
        setStatus(`✅ Burn authorized: ${tx.hash}`);
      }

      persistReject(p.evKey);
      setProposals((prev) => prev.filter((x) => x.evKey !== p.evKey));

    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Error authorization: ${msg}`);
      onError && onError(msg);
    }
  }

  function discardProposal(p) {
    persistReject(p.evKey);
    setProposals((prev) => prev.filter((x) => x.evKey !== p.evKey));
  }

  function refreshAll() {
    setStatus("Refreshing…");
    setProposals([]);
    knownEventKeys.current = new Set();
    lastScannedRef.current = new Map();
    setLastTx("");
    setRefreshNonce((x) => x + 1);
  }

  // ───────── UI ─────────
  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-5 space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl md:text-2xl bg-clip-text text-transparent bg-gradient-to-r from-indigo-300 via-fuchsia-300 to-cyan-300">
          Custodian Authority
        </h2>

        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={refreshAll}
            className="px-3 py-1.5 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500"
          >
            Refresh
          </button>

          <span
            className={`px-3 py-1 rounded-xl border ${
              connected
                ? "bg-emerald-900/20 border-emerald-800 text-emerald-200"
                : "bg-neutral-900/40 border-neutral-700 text-neutral-300"
            }`}
          >
            {connected ? "wallet connected" : "wallet not connected"}
          </span>

          {authorized !== null && (
            <span
              className={`px-3 py-1 rounded-xl border ${
                authorized
                  ? "bg-emerald-900/20 border-emerald-800 text-emerald-200"
                  : "bg-red-900/20 border-red-800 text-red-200"
              }`}
            >
              {authorized ? "Custodian wallet" : "not Custodian wallet"}
            </span>
          )}
        </div>
      </div>

      {/* Monitored tokens summary */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm">
        <div className="text-neutral-300 font-medium mb-2">Monitored token proxies</div>
        {monitoredTokens.length === 0 ? (
          <div className="text-neutral-400">No tokens to monitor. Configure Stable/Fund and ensure assets are listed in Market.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {monitoredTokens.map((t) => (
              <span key={t.address} className="px-3 py-1 rounded-xl border border-neutral-700 bg-neutral-900/50">
                <b className="mr-2">{t.kind}</b>
                <span className="text-neutral-300">{t.label}</span>
                <span className="text-neutral-500 ml-2 font-mono">
                  {t.address.slice(0, 6)}…{t.address.slice(-4)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Pending proposals */}
      <div className="rounded-xl border border-white/10 bg-white/5">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <div className="font-medium">Pending proposals (MintProposed / BurnProposed)</div>
          <div className="text-xs text-neutral-400">From token proxies (Stable/Fund/Equity)</div>
        </div>

        <div className="p-4">
          {proposals.length === 0 ? (
            <div className="text-sm text-neutral-400">Empty.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-neutral-300">
                  <tr className="text-left">
                    <th className="py-2 pr-3">Type</th>
                    <th className="py-2 pr-3">Token</th>
                    <th className="py-2 pr-3">Qty</th>
                    <th className="py-2 pr-3">Investor</th>
                    <th className="py-2 pr-3">OrderId</th>
                    <th className="py-2 pr-3">netPaid (Burn)</th>
                    <th className="py-2 pr-3">Tx</th>
                    <th className="py-2">Action</th>
                  </tr>
                </thead>

                <tbody>
                  {proposals.map((p) => (
                    <tr key={p.evKey} className="border-t border-white/10">
                      <td className="py-2 pr-3">
                        <span className={`px-2 py-0.5 rounded ${p.kind === "MINT" ? "bg-emerald-600/30" : "bg-red-600/30"}`}>
                          {p.kind}
                        </span>
                      </td>

                      <td className="py-2 pr-3">
                        <div className="flex flex-col">
                          <span>{p.tokenLabel || "—"}</span>
                          <code className="text-[11px] text-neutral-400">
                            {p.tokenAddr.slice(0, 6)}…{p.tokenAddr.slice(-4)}
                          </code>
                        </div>
                      </td>

                      <td className="py-2 pr-3">{fmt(p.qty, p.tokenDecimals)}</td>

                      <td className="py-2 pr-3">
                        <code className="text-[11px]">
                          {p.investor.slice(0, 8)}…{p.investor.slice(-6)}
                        </code>
                      </td>

                      <td className="py-2 pr-3">
                        <code className="text-[11px]">{String(p.orderId).slice(0, 10)}…</code>
                      </td>

                      <td className="py-2 pr-3">
                        {p.kind === "BURN" ? (
                          <input
                            className="px-2 py-1 rounded-lg bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none text-xs w-32"
                            value={p.netPaidStr}
                            onChange={(e) => {
                              const v = e.target.value;
                              setProposals((prev) => prev.map((x) => (x.evKey === p.evKey ? { ...x, netPaidStr: v } : x)));

                            }}
                            placeholder="netPaid"
                            title="authorizeBurn requires netPaid"
                          />
                        ) : (
                          <span className="text-neutral-500 text-xs">—</span>
                        )}
                      </td>

                      <td className="py-2 pr-3">
                        <code className="text-[11px]">{p.txHash?.slice(0, 10)}…</code>
                      </td>

                      <td className="py-2">
                        <div className="flex gap-2">
                          <button
                            onClick={() => approveProposal(p)}
                            className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs"
                          >
                            Authorize
                          </button>
                          <button
                            onClick={() => discardProposal(p)}
                            className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700 hover:border-red-500 text-xs"
                          >
                            Refuse
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* status */}
      <div className="grid md:grid-cols-2 gap-2 text-sm">
        <div className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-3">
          <div className="text-neutral-400">Last tx</div>
          <div className="font-mono break-all">{lastTx || "—"}</div>
        </div>
        <div className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-3">
          <div className="text-neutral-400">State</div>
          <div className="whitespace-pre-wrap">{status || "—"}</div>
        </div>
      </div>
    </section>
  );
}