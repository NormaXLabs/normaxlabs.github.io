import React, { useEffect, useMemo, useState } from "react";
import { Contract, ethers, isAddress } from "ethers";

/**
 * DistributorPage (NEW, compat)
 * Goal: same UX/features as DistributorPage_OLD.jsx, but compatible with new contracts where:
 * - proposeMint / proposeBurn are methods on the token (SecurityTokenBase proxy)
 * - Market is used only to discover listed assets and their token proxy address
 *
 * Features mirrored from OLD:
 * - Top instrument select: Stable vs any listed asset
 * - Wallet balance for selected instrument
 * - Propose Mint/Burn for selected instrument (stable or asset)
 * - minBuyAmount check for asset propose
 * - Transfer selected instrument to another wallet (with Max)
 * - Refresh button
 * - orderId supports raw 0x..32bytes or hashed from text
 */
export default function DistributorPage({
  provider,
  account,
  marketAddress,
  stableAddress,
  expectedChainId, // optional (App NEW passes it, ok to ignore)
  onError,
}) {
  const [status, setStatus] = useState("");
  const [lastTx, setLastTx] = useState("");

  // stable meta + wallet
  const [stableDec, setStableDec] = useState(18);
  const [stableSym, setStableSym] = useState("USD");
  const [walletStable, setWalletStable] = useState("0");

  // assets meta + wallet
  const [assetMetas, setAssetMetas] = useState([]); // [{id, token, symbol, decimals, minBuyAmountHuman, listed}]
  const [walletAssets, setWalletAssets] = useState([]); // [{id, symbol, balanceBN, decimals}]

  // selection: stable vs asset
  const [activeKind, setActiveKind] = useState("asset"); // 'asset' | 'stable'
  const [selId, setSelId] = useState(""); // bytes32 asset id (string)
  const [selToken, setSelToken] = useState(""); // token proxy address
  const [selSym, setSelSym] = useState("ASSET");
  const [selDec, setSelDec] = useState(18);
  const [minAmountHuman, setMinAmountHuman] = useState("0"); // string (human)

  // propose fields
  const [propInvestor, setPropInvestor] = useState(""); // (OLD: propMaker)
  const [propOrderId, setPropOrderId] = useState("ORDER-1");

  // amounts (strings for inputs)
  const [amtStable, setAmtStable] = useState("");
  const [qtyAsset, setQtyAsset] = useState("");

  // transfers
  const [xferTo, setXferTo] = useState("");
  const [xferAmt, setXferAmt] = useState("");

  const [xferAssetTo, setXferAssetTo] = useState("");
  const [xferAssetAmt, setXferAssetAmt] = useState("");

  // role check (NEW: PLATFORM_ROLE on selected token)
  const [hasPlatformRole, setHasPlatformRole] = useState(null); // null/true/false

  // refresh trigger
  const [refreshNonce, setRefreshNonce] = useState(0);

  // ───────── ABIs (minimal) ─────────
  const MARKET_ABI = [
    // new
    "function getAllAssetIds() view returns (bytes32[])",
    // old-ish fallback
    "function fullInventory() view returns (address[] makers,uint256[] makerStable, bytes32[] assetIds, uint256[][] balances)",
    // common
    "function assets(bytes32) view returns (address token,string symbolText,uint8 tokenDecimals,bool listed,uint256 minBuyAmount)",
    "function tokenAddress(bytes32) view returns (address)",
  ];

  // SecurityTokenBase proxy (and stable) should behave like ERC20 + platform proposals + RBAC
  const TOKEN_ABI = [
  // ERC20-ish
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",

  // AccessControl
  "function PLATFORM_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",

  // propose
  "function proposeMint(address investor, uint256 netAmount, bytes32 orderId)",
  "function proposeBurn(address investor, uint256 shares, bytes32 orderId)",

  // ✅ EVENTS (fondamentali per debug receipt)
  "event MintProposed(address indexed investor, uint256 netAmount, bytes32 orderId)",
  "event BurnProposed(address indexed investor, uint256 shares, bytes32 orderId)",
];


  const market = useMemo(() => {
    if (!provider || !marketAddress) return null;
    return new Contract(marketAddress, MARKET_ABI, provider);
  }, [provider, marketAddress]);

  const stable = useMemo(() => {
    if (!provider || !stableAddress) return null;
    return new Contract(stableAddress, TOKEN_ABI, provider);
  }, [provider, stableAddress]);

  const selectedTokenAddress = activeKind === "stable" ? stableAddress : selToken;

  const selectedToken = useMemo(() => {
    if (!provider || !selectedTokenAddress) return null;
    return new Contract(selectedTokenAddress, TOKEN_ABI, provider);
  }, [provider, selectedTokenAddress]);

  // ───────── utils ─────────
  const fmt = (v, dec = 18) => {
    try {
      return ethers.formatUnits(v ?? 0n, dec);
    } catch {
      return String(v ?? 0);
    }
  };

  // OLD behavior: if already bytes32 hex => keep; else hash string
  const normalizeOrderId = (s) => (/^0x[0-9a-fA-F]{64}$/.test(String(s || "").trim()) ? String(s).trim() : ethers.id(String(s)));

    // ───────── DEBUG helper: parse events from receipt logs ─────────
  const parseReceiptLogs = (rc, onlyAddress) => {
  try {
    const iface = new ethers.Interface(TOKEN_ABI);
    const out = [];
    for (const log of (rc?.logs || [])) {
      if (onlyAddress && String(log.address).toLowerCase() !== String(onlyAddress).toLowerCase()) continue;
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name) out.push({ name: parsed.name, args: parsed.args, address: log.address });
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
};




  // top select helper
  const topSelectValue =
    activeKind === "stable" ? "stable" : selId ? `asset:${selId}` : "stable";

  function onTopSelectChange(v) {
    if (v === "stable") {
      setActiveKind("stable");
      return;
    }
    if (v.startsWith("asset:")) {
      const id = v.slice(6);
      setActiveKind("asset");
      setSelId(id);
    }
  }

  // default investor = current account (OLD did this for propMaker)
  useEffect(() => {
    setPropInvestor(account || "");
  }, [account]);

  // ───────── load stable meta + stable wallet ─────────
  useEffect(() => {
    (async () => {
      if (!stable || !account) return;
      try {
        const [d, s, bal] = await Promise.all([
          stable.decimals(),
          stable.symbol(),
          stable.balanceOf(account),
        ]);
        setStableDec(Number(d));
        setStableSym(String(s || "USD"));
        setWalletStable(fmt(bal, Number(d)));
      } catch {
        // keep defaults
      }
    })();
  }, [stable, account, refreshNonce]);

  // ───────── load asset list from Market ─────────
  useEffect(() => {
    (async () => {
      if (!market || !provider) {
        setAssetMetas([]);
        return;
      }
      try {
        let ids = [];
        // prefer new
        try {
          ids = await market.getAllAssetIds();
        } catch {
          // fallback: old fullInventory
          try {
            const out = await market.fullInventory();
            ids = out?.assetIds || out?.[2] || [];
          } catch {
            ids = [];
          }
        }

        const uniq = Array.from(new Set((ids || []).map((x) => String(x))));
        const metas = await Promise.all(
          uniq.map(async (id) => {
            try {
              const info = await market.assets(id);
              const tokenAddr = info.token ?? info[0];
              const sym = info.symbolText ?? info[1] ?? "ASSET";
              const dec = Number(info.tokenDecimals ?? info[2] ?? 18);
              const listed = Boolean(info.listed ?? info[3] ?? true);
              const minBuyRaw = info.minBuyAmount ?? info[4] ?? 0n;

              return {
                id: String(id),
                token: tokenAddr,
                symbol: String(sym),
                decimals: dec,
                listed,
                minBuyAmountRaw: minBuyRaw,
                minBuyAmountHuman: fmt(minBuyRaw, dec),
              };
            } catch {
              // fallback: tokenAddress + token meta
              try {
                const taddr = await market.tokenAddress(id);
                if (taddr && taddr !== ethers.ZeroAddress) {
                  const tok = new Contract(taddr, TOKEN_ABI, provider);
                  const [sym, dec] = await Promise.all([tok.symbol(), tok.decimals()]);
                  return {
                    id: String(id),
                    token: taddr,
                    symbol: String(sym || "ASSET"),
                    decimals: Number(dec || 18),
                    listed: true,
                    minBuyAmountRaw: 0n,
                    minBuyAmountHuman: "0",
                  };
                }
              } catch {}
              return {
                id: String(id),
                token: ethers.ZeroAddress,
                symbol: "ASSET",
                decimals: 18,
                listed: true,
                minBuyAmountRaw: 0n,
                minBuyAmountHuman: "0",
              };
            }
          })
        );

        const listedMetas = metas.filter((m) => m.listed && m.token && m.token !== ethers.ZeroAddress);
        setAssetMetas(listedMetas);

        // default selection like OLD: first asset if any, else stable
        if (!selId && listedMetas.length) {
          const m = listedMetas[0];
          setSelId(String(m.id));
          setSelToken(m.token);
          setSelSym(m.symbol);
          setSelDec(m.decimals);
          setMinAmountHuman(m.minBuyAmountHuman || "0");
          setActiveKind("asset");
        }
        if (listedMetas.length === 0) {
          setActiveKind("stable");
        }
      } catch (e) {
        const msg = e?.shortMessage || e?.reason || e?.message || String(e);
        setStatus(`⚠️ impossible to read asset list: ${msg}`);
        onError && onError(msg);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, provider, refreshNonce]);

  // ───────── when selId changes, update selected meta + refresh balances ─────────
  useEffect(() => {
    const m = assetMetas.find((a) => String(a.id) === String(selId));
    if (m) {
      setSelToken(m.token);
      setSelSym(m.symbol);
      setSelDec(m.decimals);
      setMinAmountHuman(m.minBuyAmountHuman || "0");
    }
    refreshBalances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId, assetMetas, activeKind]);

  // ───────── role check: PLATFORM_ROLE on selected token ─────────
  useEffect(() => {
    (async () => {
      setHasPlatformRole(null);
      if (!selectedToken || !account) return;

      try {
        const role = await selectedToken.PLATFORM_ROLE();
        const ok = await selectedToken.hasRole(role, account);
        setHasPlatformRole(Boolean(ok));
      } catch {
        // if token doesn't expose it, keep "unknown" and do not hard-block
        setHasPlatformRole(null);
      }
    })();
  }, [selectedToken, account, refreshNonce]);

  // ───────── balances ─────────
  async function refreshBalances() {
    // stable wallet
    if (stable && account) {
      try {
        const bal = await stable.balanceOf(account);
        setWalletStable(fmt(bal, stableDec));
      } catch {}
    }

    // assets wallet
    if (!provider || !account) return;
    try {
      const outs = await Promise.all(
        assetMetas.map(async (a) => {
          try {
            const tokenAddr = a.token;
            if (!tokenAddr || tokenAddr === ethers.ZeroAddress) return null;
            const tok = new Contract(tokenAddr, TOKEN_ABI, provider);
            const bal = await tok.balanceOf(account);
            return { id: a.id, symbol: a.symbol, balanceBN: bal, decimals: a.decimals };
          } catch {
            return null;
          }
        })
      );
      setWalletAssets(outs.filter(Boolean));
    } catch {
      /* ignore */
    }
  }

  // ───────── validations ─────────
  const validateCommon = () => {
    if (!provider || !account) return "First connect wallet.";
    if (!selectedToken) return "Select an instrument.";
    if (!propInvestor || !isAddress(propInvestor)) return "Investor address not valid.";
    if (!propOrderId) return "OrderId missing.";
    // we warn but don't hard-block if unknown
    if (hasPlatformRole === false) return "Not PLATFORM_ROLE on selected token (tx will fail).";
    return null;
  };

  const validateStable = () => {
    const v = validateCommon();
    if (v) return v;
    if (!amtStable || Number(amtStable) <= 0) return "Amount must be > 0.";
    return null;
  };

  const validateAsset = () => {
    const v = validateCommon();
    if (v) return v;
    if (!selId) return "Select an asset.";
    if (!qtyAsset || Number(qtyAsset) <= 0) return "Qty must be > 0.";

    const minN = Number(minAmountHuman || "0");
    if (minN > 0 && Number(qtyAsset) < minN) {
      return `Qty must be ≥ min buy amount (${minAmountHuman}).`;
    }
    return null;
  };

  // ───────── propose ─────────
  async function doProposeStable(kind) {
  setStatus("");
  setLastTx("");

  const v = validateStable();
  if (v) return setStatus(`⚠️ ${v}`);

  try {
    const signer = await provider.getSigner();
    const t = stable.connect(signer);

    const amt = ethers.parseUnits(String(amtStable || "0"), stableDec);
    const oid = normalizeOrderId(propOrderId);

    const tx =
      kind === "MINT"
        ? await t.proposeMint(propInvestor, amt, oid)
        : await t.proposeBurn(propInvestor, amt, oid);

    setLastTx(tx.hash);

    const rc = await tx.wait();

    console.log("[DIST] proposeStable", {
      kind,
      stableAddress,
      stableSym,
      stableDec,
      amtStable,
      amtBN: amt.toString(),
      investor: propInvestor,
      orderId: oid,
      tx: tx.hash,
      status: rc?.status,
    });

    const addr = await t.getAddress();
    const parsed = parseReceiptLogs(rc, addr);
    console.log("[DIST] receipt parsed events (TOKEN_ABI only):", parsed);
    if (!parsed.length) console.log("[DIST] receipt raw logs:", rc?.logs);


    setStatus(`✅ Propose Stable ${kind} sent: ${tx.hash}`);
    await refreshBalances();
  } catch (e) {
    const msg = e?.shortMessage || e?.reason || e?.message || String(e);
    console.log("[DIST] proposeStable error", e);
    setStatus(`❌ Propose Stable ${kind}: ${msg}`);
    onError && onError(msg);
  }
}


  async function doProposeAsset(kind) {
  setStatus("");
  setLastTx("");

  const v = validateAsset();
  if (v) return setStatus(`⚠️ ${v}`);

  try {
    const signer = await provider.getSigner();
    const t = selectedToken.connect(signer);

    const qty = ethers.parseUnits(String(qtyAsset || "0"), selDec);
    const oid = normalizeOrderId(propOrderId);

    const tx =
      kind === "MINT"
        ? await t.proposeMint(propInvestor, qty, oid)
        : await t.proposeBurn(propInvestor, qty, oid);

    setLastTx(tx.hash);

    const rc = await tx.wait();

    console.log("[DIST] proposeAsset", {
      kind,
      tokenAddr_state: selectedTokenAddress,
      tokenAddr_selToken: selToken,
      tokenAddr_contract: await t.getAddress(),
      selSym,
      selDec,
      qtyAsset,
      qtyBN: qty.toString(),
      investor: propInvestor,
      orderId: oid,
      tx: tx.hash,
      status: rc?.status,
    });

    const addr = await t.getAddress();
    const parsed = parseReceiptLogs(rc, addr);
    console.log("[DIST] receipt parsed events (TOKEN_ABI only):", parsed);
    if (!parsed.length) console.log("[DIST] receipt raw logs:", rc?.logs);



    setStatus(`✅ Propose Asset ${kind} sent: ${tx.hash}`);
    await refreshBalances();
  } catch (e) {
    const msg = e?.shortMessage || e?.reason || e?.message || String(e);
    console.log("[DIST] proposeAsset error", e);
    setStatus(`❌ Propose Asset ${kind}: ${msg}`);
    onError && onError(msg);
  }
}


  // ───────── transfers ─────────
  async function doTransferStable() {
    setStatus("");
    setLastTx("");

    if (!provider || !account || !stable) return setStatus("⚠️ configure provider / contracts.");
    if (!xferTo || !isAddress(xferTo)) return setStatus("⚠️ destination address not valid.");

    try {
      const amt = ethers.parseUnits(String(xferAmt || "0"), stableDec);
      if (amt <= 0n) return setStatus("⚠️ amount must be > 0.");

      const signer = await provider.getSigner();
      const tx = await stable.connect(signer).transfer(xferTo, amt);
      setLastTx(tx.hash);
      await tx.wait();

      setStatus(
        `✅ Transfer ${fmt(amt, stableDec)} ${stableSym} → ${xferTo.slice(0, 6)}…${xferTo.slice(-4)}: ${tx.hash}`
      );
      setXferAmt("");
      await refreshBalances();
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Transfer stable: ${msg}`);
      onError && onError(msg);
    }
  }

  async function doTransferAsset() {
    setStatus("");
    setLastTx("");

    if (!provider || !account || !selectedToken) return setStatus("⚠️ configure provider / contracts.");
    if (!selId) return setStatus("⚠️ select an asset.");
    if (!xferAssetTo || !isAddress(xferAssetTo)) return setStatus("⚠️ destination address not valid.");

    try {
      const amt = ethers.parseUnits(String(xferAssetAmt || "0"), selDec);
      if (amt <= 0n) return setStatus("⚠️ amount must be > 0.");

      const signer = await provider.getSigner();
      const tx = await selectedToken.connect(signer).transfer(xferAssetTo, amt);
      setLastTx(tx.hash);
      await tx.wait();

      setStatus(
        `✅ Transfer ${fmt(amt, selDec)} ${selSym} → ${xferAssetTo.slice(0, 6)}…${xferAssetTo.slice(-4)}: ${tx.hash}`
      );
      setXferAssetAmt("");
      await refreshBalances();
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Transfer asset: ${msg}`);
      onError && onError(msg);
    }
  }

  // wallet view for selected asset
  const selWalletAsset = walletAssets.find((w) => String(w.id) === String(selId));
  const connected = !!provider && !!account;

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-5 space-y-4">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h2 className="text-xl md:text-2xl bg-clip-text text-transparent bg-gradient-to-r from-indigo-300 via-fuchsia-300 to-cyan-300">
          Distributor
        </h2>

        <div
          className={`px-3 py-1 rounded-xl text-xs border ${
            hasPlatformRole
              ? "bg-emerald-900/20 border-emerald-800 text-emerald-200"
              : hasPlatformRole === false
              ? "bg-red-900/20 border-red-800 text-red-200"
              : "bg-neutral-900/40 border-neutral-700 text-neutral-300"
          }`}
        >
          {connected
            ? hasPlatformRole === null
              ? "Role check: unknown"
              : hasPlatformRole
              ? "✔ PLATFORM_ROLE"
              : "✖ no PLATFORM_ROLE"
            : "Wallet not connected"}
        </div>
      </div>

      {/* Top instrument selection */}
      <div className="rounded-xl p-4 border border-white/10 bg-white/5">
        <div className="text-sm text-neutral-300 mb-2">Asset</div>
        <div className="grid md:grid-cols-2 gap-2">
          <select
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
            value={topSelectValue}
            onChange={(e) => onTopSelectChange(e.target.value)}
          >
            <option value="stable">
              Stable {stableSym} {stableAddress ? `· ${stableAddress.slice(0, 6)}…${stableAddress.slice(-4)}` : ""}
            </option>
            {assetMetas.map((a) => (
              <option key={String(a.id)} value={`asset:${a.id}`}>
                {a.symbol} · {a.token ? `${String(a.token).slice(0, 6)}…${String(a.token).slice(-4)}` : "—"}
              </option>
            ))}

          </select>

          {activeKind === "asset" ? (
            <div className="text-xs text-neutral-400 self-center">
              Selected asset: <span className="font-mono">{selSym}</span> · decimals {selDec}
              {Number(minAmountHuman || "0") > 0 ? <> · min buy {minAmountHuman}</> : null}
            </div>
          ) : (
            <div className="text-xs text-neutral-400 self-center">
              Stable: <span className="font-mono">{stableSym}</span> · decimals {stableDec}
              {expectedChainId ? <span className="text-neutral-500"> · chain expected {expectedChainId}</span> : null}
            </div>
          )}
        </div>
      </div>

      {/* Wallet balance (selected instrument only) */}
      <div className="grid md:grid-cols-3 gap-2 mb-3 text-sm">
        {activeKind === "stable" ? (
          <div className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-3">
            <div className="text-neutral-400">Wallet {stableSym}</div>
            <div className="font-mono">{walletStable}</div>
          </div>
        ) : (
          <div className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-3">
            <div className="text-neutral-400">Wallet {selSym}</div>
            <div className="font-mono">
              {selWalletAsset ? fmt(selWalletAsset.balanceBN, selWalletAsset.decimals) : "—"}
            </div>
          </div>
        )}
      </div>

      {/* Stable propose */}
      {activeKind === "stable" && (
        <div className="rounded-xl p-4 border border-white/10 bg-white/5">
          <div className="text-sm text-neutral-300 mb-2 flex items-center justify-between">
            <span>Propose Stable Mint/Burn</span>
            {hasPlatformRole === false && (
              <span className="text-red-400 text-xs">Not PLATFORM_ROLE: tx will fail.</span>
            )}
          </div>

          <div className="grid md:grid-cols-3 gap-2 mb-2">
            <input
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
              placeholder="Order Id (text or 0x…32 bytes)"
              value={propOrderId}
              onChange={(e) => setPropOrderId(e.target.value)}
            />
            <input
              className="flex-1 px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
              placeholder={`Amount ${stableSym}`}
              value={amtStable}
              onChange={(e) => setAmtStable(e.target.value)}
            />
            <input
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
              placeholder="Investor address (0x…)"
              value={propInvestor}
              onChange={(e) => setPropInvestor(e.target.value)}
            />
          </div>

          <div className="grid md:grid-cols-2 gap-2">
            <button
              onClick={() => doProposeStable("MINT")}
              className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-emerald-500 disabled:opacity-60"
              disabled={hasPlatformRole === false}
            >
              Propose Mint
            </button>
            <button
              onClick={() => doProposeStable("BURN")}
              className="px-4 py-2 rounded-xl bg-neutral-800 border border-neutral-700 hover:border-red-500 disabled:opacity-60"
              disabled={hasPlatformRole === false}
            >
              Propose Burn
            </button>
          </div>

          <p className="mt-2 text-xs text-neutral-400">
            (Attention: <code>orderId</code> is automatically converted to <code>bytes32</code> with{" "}
            <code>keccak256</code> if you send plain text)
          </p>
        </div>
      )}

      {/* Asset propose */}
      {activeKind === "asset" && (
        <div className="rounded-xl p-4 border border-white/10 bg-white/5">
          <div className="text-sm text-neutral-300 mb-2 flex items-center justify-between">
            <span>Propose Asset Mint/Burn</span>
            {hasPlatformRole === false && (
              <span className="text-red-400 text-xs">Not PLATFORM_ROLE: tx will fail.</span>
            )}
          </div>

          <div className="grid md:grid-cols-3 gap-2 mb-2">
            <input
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
              placeholder="Order Id (text or 0x…32 bytes)"
              value={propOrderId}
              onChange={(e) => setPropOrderId(e.target.value)}
            />
            <input
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
              placeholder={`Qty ${selSym}${Number(minAmountHuman || "0") > 0 ? ` (min ${minAmountHuman})` : ""} (dec ${selDec})`}
              value={qtyAsset}
              onChange={(e) => setQtyAsset(e.target.value)}
            />
            <input
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
              placeholder="Investor address (0x…)"
              value={propInvestor}
              onChange={(e) => setPropInvestor(e.target.value)}
            />
          </div>

          <div className="grid md:grid-cols-2 gap-2">
            <button
              onClick={() => doProposeAsset("MINT")}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60"
              disabled={hasPlatformRole === false}
            >
              Propose Mint
            </button>
            <button
              onClick={() => doProposeAsset("BURN")}
              className="px-4 py-2 rounded-xl bg-neutral-800 border border-neutral-700 hover:border-red-500 disabled:opacity-60"
              disabled={hasPlatformRole === false}
            >
              Propose Burn
            </button>
          </div>

          <p className="mt-2 text-xs text-neutral-400">
            (Attention: <code>orderId</code> is automatically converted to <code>bytes32</code> with{" "}
            <code>keccak256</code> if you send plain text)
          </p>
        </div>
      )}

      {/* Stable transfer */}
      {activeKind === "stable" && (
        <div className="rounded-xl p-4 border border-white/10 bg-white/5">
          <div className="text-sm text-neutral-300 mb-2">Transfer Stable To Investor</div>
          <div className="grid md:grid-cols-3 gap-2">
            <input
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
              placeholder="To address (0x…)"
              value={xferTo}
              onChange={(e) => setXferTo(e.target.value)}
            />
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
                placeholder={`Amount ${stableSym}`}
                value={xferAmt}
                onChange={(e) => setXferAmt(e.target.value)}
              />
              <button
                onClick={() => setXferAmt(walletStable)}
                className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500"
              >
                Max
              </button>
            </div>
            <button
              onClick={doTransferStable}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
            >
              Transfer
            </button>
          </div>
          <p className="mt-2 text-xs text-neutral-400">
            Transfer {stableSym} from distributor to investor wallet.
          </p>
        </div>
      )}

      {/* Asset transfer */}
      {activeKind === "asset" && (
        <div className="rounded-xl p-4 border border-white/10 bg-white/5">
          <div className="text-sm text-neutral-300 mb-2">Transfer Selected Asset</div>
          <div className="grid md:grid-cols-3 gap-2">
            <input
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
              placeholder="To address (0x…)"
              value={xferAssetTo}
              onChange={(e) => setXferAssetTo(e.target.value)}
            />
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
                placeholder={`Amount ${selSym} (dec ${selDec})`}
                value={xferAssetAmt}
                onChange={(e) => setXferAssetAmt(e.target.value)}
              />
              <button
                onClick={() => {
                  if (!selWalletAsset) return;
                  setXferAssetAmt(fmt(selWalletAsset.balanceBN, selWalletAsset.decimals));
                }}
                className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500"
              >
                Max
              </button>
            </div>
            <button
              onClick={doTransferAsset}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
            >
              Transfer
            </button>
          </div>
          <p className="mt-2 text-xs text-neutral-400">
            Selected asset: <span className="font-mono">{selSym}</span> · decimals {selDec}
          </p>
        </div>
      )}

      {/* Footer status + refresh */}
      <div className="mt-3 flex items-center justify-between text-sm gap-3">
        <button
          onClick={() => setRefreshNonce((x) => x + 1)}
          className="px-3 py-1.5 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500"
        >
          Refresh
        </button>

        <div className="flex-1 text-right">
          {lastTx && (
            <div className="text-xs text-neutral-400">
              Last tx: <span className="font-mono break-all">{lastTx}</span>
            </div>
          )}
          {status && <div className="text-neutral-300 whitespace-pre-wrap">{status}</div>}
        </div>
      </div>
    </section>
  );
}
