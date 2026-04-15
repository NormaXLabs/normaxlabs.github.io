import React, { useEffect, useMemo, useState } from "react";
import { Contract, ethers, isAddress } from "ethers";

/**
 * MakerPage (NEW)
 * Goal: replicate MakerPage_OLD.jsx features, but compatible with the NEW contracts layout.
 * - Deposit/Withdraw Stable into Market inventory
 * - Deposit/Withdraw selected Asset into Market inventory
 * - Propose Mint/Burn events (Stable + Asset) for Depositary workflow
 * - Show wallet + inventory balances, and Maker role verification (INVENTORY_ROLE)
 *
 * Props:
 *  - provider: ethers BrowserProvider (or compatible)
 *  - account: connected address
 *  - marketAddress: Market contract address
 *  - stableAddress: stable ERC20 address (USD token)
 *  - onError(msg)
 */
export default function MakerPage({ provider, account, marketAddress, stableAddress, onError }) {
  const [status, setStatus] = useState("");
  const [isMaker, setIsMaker] = useState(null);

  // stable info
  const [stableDec, setStableDec] = useState(18);
  const [stableSym, setStableSym] = useState("USD");
  const [walletStable, setWalletStable] = useState("0");
  const [walletAssets, setWalletAssets] = useState([]); // [{id, symbol, balance, decimals}]

  // amounts (string per input)
  const [amtStable, setAmtStable] = useState("");
  const [qtyAsset, setQtyAsset] = useState("");

  // assets list & selection
  const [assetMetas, setAssetMetas] = useState([]); // [{id, symbol, decimals, token?}]
  const [selId, setSelId] = useState("");           // bytes32 id
  const [selDec, setSelDec] = useState(18);
  const [selSym, setSelSym] = useState("ASSET");

  // inventory balances (maker)
  const [invStable, setInvStable] = useState("0");
  const [invSelAsset, setInvSelAsset] = useState("0");

  // propose fields
  const [propInvestor, setPropInvestor] = useState("");
  const [propOrderId, setPropOrderId] = useState("ORDER-1");
  const [stablePlatformOk, setStablePlatformOk] = useState(null);
  const [assetPlatformOk, setAssetPlatformOk] = useState(null);

  // transfer stable (wallet → altro wallet)
  const [xferTo, setXferTo] = useState("");
  const [xferAmt, setXferAmt] = useState("");

  // ───────── ABIs minimi (retro-compat) ─────────
  const MARKET_ABI = [
    // role gating (may exist)
    "function INVENTORY_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",

    // assets discovery
    "function getAllAssetIds() view returns (bytes32[])",

    // assets metadata (Market.sol)
    "function assets(bytes32) view returns (address token,string symbolText,uint8 tokenDecimals,bool listed,uint256 minBuyAmount)",

    // optional old helper
    "function tokenAddress(bytes32) view returns (address)",

    // balances
    "function invStable(address) view returns (uint256)",
    "function invAsset(address,bytes32) view returns (uint256)",

    // inventory actions
    "function depositStable(uint256)",
    "function withdrawStable(uint256)",
    "function depositAsset(bytes32,uint256)",
    "function withdrawAsset(bytes32,uint256)",

    // events
    "event AssetListed(bytes32 indexed id, address token, string symbol)"
  ];

  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function approve(address,uint256) returns (bool)",

    // stable propose entrypoints (if stable token implements them)
    "function proposeMint(address maker, uint256 netAmount, bytes32 orderId)",
    "function proposeBurn(address maker, uint256 netAmount, bytes32 orderId)",
  ];

  const ROLE_ABI = [
    "function PLATFORM_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
  ];

  const market = useMemo(
    () => (provider && marketAddress ? new Contract(marketAddress, MARKET_ABI, provider) : null),
    [provider, marketAddress]
  );

  const stable = useMemo(
    () => (provider && stableAddress ? new Contract(stableAddress, ERC20_ABI, provider) : null),
    [provider, stableAddress]
  );

  const fmt = (v, dec = 18) => {
    try {
      return ethers.formatUnits(v ?? 0n, dec);
    } catch {
      return String(v ?? 0);
    }
  };

  const normalizeOrderId = (s) => {
    const t = String(s ?? "").trim();
    if (!t) return ethers.id("ORDER-0");
    if (/^0x[0-9a-fA-F]{64}$/.test(t)) return t;
    return ethers.id(t);
  };

  async function ensureApprove(token, owner, spender, amount) {
    const cur = await token.allowance(owner, spender);
    if (cur >= amount) return;
    const signer = await provider.getSigner();
    const tx = await token.connect(signer).approve(spender, amount);
    await tx.wait();
  }

  async function checkPlatformRole(tokenAddr) {
    if (!provider || !account) return null;
    if (!tokenAddr || tokenAddr === ethers.ZeroAddress) return null;
    try {
      const t = new Contract(tokenAddr, ROLE_ABI, provider);
      const role = await t.PLATFORM_ROLE();
      const ok = await t.hasRole(role, account);
      return Boolean(ok);
    } catch {
      return null; // unknown / not supported
    }
  }

  // ───────── helpers ─────────
  async function safeAssetTokenAddress(id, hint) {
    // hint may already contain token address (from assets())
    if (hint && hint !== ethers.ZeroAddress) return hint;

    // try assets(id) again
    try {
      const info = await market.assets(id);
      const tokenAddr = info?.token ?? info?.[0];
      if (tokenAddr && tokenAddr !== ethers.ZeroAddress) return tokenAddr;
    } catch {}

    // fallback tokenAddress(id)
    try {
      const tokenAddr = await market.tokenAddress(id);
      if (tokenAddr && tokenAddr !== ethers.ZeroAddress) return tokenAddr;
    } catch {}

    return ethers.ZeroAddress;
  }

  async function loadAssetsList() {
    if (!market || !provider) return [];
    let ids = [];

    // Prefer on-chain list (may be admin-only)
    try {
      ids = await market.getAllAssetIds();
    } catch {
      ids = [];
    }

    // Fallback: scan AssetListed events (public)
    if (!ids.length) {
      try {
        const logAddr = marketAddress || market?.target;
        if (!logAddr) return [];
        const topic0 = ethers.id("AssetListed(bytes32,address,string)");
        const logs = await provider.getLogs({
          address: logAddr,
          topics: [topic0],
          fromBlock: 0n,
          toBlock: "latest",
        });
        const seen = new Set();
        const out = [];
        for (const lg of logs) {
          const id = lg.topics?.[1];
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push(id);
        }
        ids = out;
      } catch {
        ids = [];
      }
    }

    const uniq = Array.from(new Set((ids || []).map((x) => String(x))));
    // Need original bytes32 objects; if strings are fine for ethers v6, keep as strings
    const metas = await Promise.all(
      uniq.map(async (id) => {
        try {
          const info = await market.assets(id);
          const tokenAddr = info?.token ?? info?.[0] ?? ethers.ZeroAddress;
          const symbol = info?.symbolText ?? info?.[1] ?? "ASSET";
          const decimals = Number(info?.tokenDecimals ?? info?.[2] ?? 18);
          const listed = Boolean(info?.listed ?? info?.[3] ?? true);
          return { id: String(id), symbol, decimals, token: tokenAddr, listed };
        } catch {
          // fallback: try tokenAddress + ERC20 meta
          try {
            const tokenAddr = await market.tokenAddress(id);
            if (tokenAddr && tokenAddr !== ethers.ZeroAddress) {
              const tok = new Contract(tokenAddr, ERC20_ABI, provider);
              const [sym, dec] = await Promise.all([tok.symbol(), tok.decimals()]);
              return { id: String(id), symbol: sym, decimals: Number(dec), token: tokenAddr, listed: true };
            }
          } catch {}
          return { id: String(id), symbol: "ASSET", decimals: 18, token: ethers.ZeroAddress, listed: true };
        }
      })
    );

    // Keep only listed, if field exists
    return metas.filter((m) => m.listed !== false);
  }

  async function refreshWalletBalances(currentAssetMetas = assetMetas) {
    if (!stable || !account) return;

    try {
      const wbal = await stable.balanceOf(account);
      setWalletStable(fmt(wbal, stableDec));
    } catch {}

    // wallet assets balances (best effort)
    try {
      const outs = await Promise.all(
        (currentAssetMetas || []).map(async (a) => {
          try {
            const tokenAddr = await safeAssetTokenAddress(a.id, a.token);
            if (!tokenAddr || tokenAddr === ethers.ZeroAddress) return null;
            const token = new Contract(tokenAddr, ERC20_ABI, provider);
            const bal = await token.balanceOf(account);
            const dec = typeof a.decimals === "number" ? a.decimals : Number(await token.decimals());
            const sym = a.symbol || (await token.symbol());
            return { id: a.id, symbol: sym, balance: bal, decimals: dec };
          } catch {
            return null;
          }
        })
      );
      setWalletAssets(outs.filter(Boolean));
    } catch {
      // ignore
    }
  }

  async function refreshInventoryBalances() {
    if (!market || !account) return;
    try {
      const [st, a] = await Promise.all([
        market.invStable(account),
        selId ? market.invAsset(account, selId) : 0n,
      ]);
      setInvStable(fmt(st, stableDec));
      setInvSelAsset(fmt(a, selDec));
    } catch {
      // ignore
    }
  }

  // ───────── bootstrap ─────────
  useEffect(() => {
    setPropInvestor(account || "");
  }, [account]);

  useEffect(() => {
    (async () => {
      setStatus("");
      if (!provider || !account || !market) {
        setIsMaker(null);
        setAssetMetas([]);
        return;
      }

      // role verification (best-effort)
      try {
        let ok = true;
        try {
          const role = await market.INVENTORY_ROLE();
          ok = await market.hasRole(role, account);
        } catch {
          ok = true; // if not supported, don't block UI
        }
        setIsMaker(Boolean(ok));
      } catch {
        setIsMaker(null);
      }

      // stable meta + wallet balance
      if (stable) {
        try {
          const [d, s, wbal] = await Promise.all([
            stable.decimals(),
            stable.symbol(),
            stable.balanceOf(account),
          ]);
          setStableDec(Number(d));
          setStableSym(String(s));
          setWalletStable(fmt(wbal, Number(d)));
          const ok = await checkPlatformRole(stableAddress);
          setStablePlatformOk(ok);
        } catch {}
      }

      // assets list
      try {
        const metas = await loadAssetsList();
        setAssetMetas(metas);

        if ((!selId || selId === "") && metas.length) {
          setSelId(metas[0].id);
          setSelSym(metas[0].symbol);
          setSelDec(metas[0].decimals);
        }
        // populate wallet assets list (best effort)
        await refreshWalletBalances(metas);
      } catch (e) {
        const msg = e?.shortMessage || e?.reason || e?.message || String(e);
        setStatus(`⚠️ Asset discovery failed: ${msg}`);
        onError && onError(msg);
      }

      // inventory balances
      await refreshInventoryBalances();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, account, marketAddress, stableAddress]);

  // Update selection meta and refresh balances when selection changes
  useEffect(() => {
    const m = assetMetas.find((a) => String(a.id) === String(selId));
    if (m) {
      setSelSym(m.symbol);
      setSelDec(m.decimals);
    }
    (async () => {
      if (!market || !provider || !selId) {
        setAssetPlatformOk(null);
        return;
      }
      const tokenAddr = await safeAssetTokenAddress(
        selId,
        assetMetas.find((a) => String(a.id) === String(selId))?.token
      );
      const ok = await checkPlatformRole(tokenAddr);
      setAssetPlatformOk(ok);
    })();
    refreshInventoryBalances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId, assetMetas]);

  // ───────── actions: deposit/withdraw ─────────
  async function doDepositStable() {
    setStatus("");
    if (!provider || !account || !market || !stable) return setStatus("⚠️ configure provider / contracts.");
    try {
      const amt = ethers.parseUnits(String(amtStable || "0"), stableDec);
      if (amt <= 0n) return setStatus("⚠️ amount must be > 0.");
      await ensureApprove(stable, account, marketAddress, amt);
      const signer = await provider.getSigner();
      const tx = await market.connect(signer).depositStable(amt);
      await tx.wait();
      setStatus(`✅ Deposit stable ok: ${tx.hash}`);
      await refreshWalletBalances();
      await refreshInventoryBalances();
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Deposit stable: ${msg}`);
      onError && onError(msg);
    }
  }

  async function doWithdrawStable() {
    setStatus("");
    if (!provider || !account || !market) return setStatus("⚠️ configure provider / contracts.");
    try {
      const amt = ethers.parseUnits(String(amtStable || "0"), stableDec);
      if (amt <= 0n) return setStatus("⚠️ amount must be > 0.");
      const signer = await provider.getSigner();
      const tx = await market.connect(signer).withdrawStable(amt);
      await tx.wait();
      setStatus(`✅ Withdraw stable ok: ${tx.hash}`);
      await refreshWalletBalances();
      await refreshInventoryBalances();
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Withdraw stable: ${msg}`);
      onError && onError(msg);
    }
  }

  async function doDepositAsset() {
    setStatus("");
    if (!provider || !account || !market || !selId) return setStatus("⚠️ select an asset.");
    try {
      const amt = ethers.parseUnits(String(qtyAsset || "0"), selDec);
      if (amt <= 0n) return setStatus("⚠️ qty must be > 0.");
      const tokenAddr = await safeAssetTokenAddress(selId, assetMetas.find(a => String(a.id)===String(selId))?.token);
      if (!tokenAddr || tokenAddr === ethers.ZeroAddress) throw new Error("Token address not available");
      const token = new Contract(tokenAddr, ERC20_ABI, provider);

      await ensureApprove(token, account, marketAddress, amt);
      const signer = await provider.getSigner();
      const tx = await market.connect(signer).depositAsset(selId, amt);
      await tx.wait();
      setStatus(`✅ Deposit ${selSym} ok: ${tx.hash}`);
      await refreshWalletBalances();
      await refreshInventoryBalances();
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Deposit asset: ${msg}`);
      onError && onError(msg);
    }
  }

  async function doWithdrawAsset() {
    setStatus("");
    if (!provider || !account || !market || !selId) return setStatus("⚠️ select an asset.");
    try {
      const amt = ethers.parseUnits(String(qtyAsset || "0"), selDec);
      if (amt <= 0n) return setStatus("⚠️ qty must be > 0.");
      const signer = await provider.getSigner();
      const tx = await market.connect(signer).withdrawAsset(selId, amt);
      await tx.wait();
      setStatus(`✅ Withdraw ${selSym} ok: ${tx.hash}`);
      await refreshWalletBalances();
      await refreshInventoryBalances();
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Withdraw asset: ${msg}`);
      onError && onError(msg);
    }
  }

  // ───────── propose mint/burn ─────────
  function validateProposal(amountStr, dec, needsInvestorAddr = true, platformOk = null) {
    if (!provider || !account) return "First connect wallet.";
    if (!market) return "Market not configured.";
    if (!amountStr || Number(amountStr) <= 0) return "Qty must be > 0.";
    if (needsInvestorAddr && (!propInvestor || !isAddress(propInvestor))) return "Investor address not valid.";
    if (!propOrderId) return "OrderId missing.";
    if (!dec && dec !== 0) return "Decimals missing.";
    if (platformOk === false) return "Not PLATFORM_ROLE on selected token (tx will fail).";
    return null;
  }

  async function doProposeStable(kind) {
    setStatus("");
    if (!stable) return setStatus("⚠️ stable not configured.");
    const v = validateProposal(amtStable, stableDec, true, stablePlatformOk);
    if (v) return setStatus(`⚠️ ${v}`);

    try {
      const amt = ethers.parseUnits(String(amtStable || "0"), stableDec);
      const oid = normalizeOrderId(propOrderId);
      const signer = await provider.getSigner();
      const st = stable.connect(signer);

      // stable token implements proposeMint/proposeBurn
      const tx =
        kind === "MINT"
          ? await st.proposeMint(propInvestor, amt, oid)
          : await st.proposeBurn(propInvestor, amt, oid);

      await tx.wait();
      setStatus(`✅ Propose Stable ${kind} sent: ${tx.hash}`);
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Propose Stable ${kind}: ${msg}`);
      onError && onError(msg);
    }
  }

  async function doProposeAsset(kind) {
    setStatus("");
    const v = validateProposal(qtyAsset, selDec, true, assetPlatformOk);
    if (v) return setStatus(`⚠️ ${v}`);
    if (!selId) return setStatus("⚠️ select an asset.");

    try {
      const amt = ethers.parseUnits(String(qtyAsset || "0"), selDec);
      const oid = normalizeOrderId(propOrderId);
      const tokenAddr = await safeAssetTokenAddress(
        selId,
        assetMetas.find((a) => String(a.id) === String(selId))?.token
      );
      if (!tokenAddr || tokenAddr === ethers.ZeroAddress) {
        throw new Error("Token address not available for selected asset.");
      }
      const signer = await provider.getSigner();
      const token = new Contract(tokenAddr, ERC20_ABI, provider).connect(signer);

      const tx =
        kind === "MINT"
          ? await token.proposeMint(propInvestor, amt, oid)
          : await token.proposeBurn(propInvestor, amt, oid);

      await tx.wait();
      setStatus(`✅ Propose ${kind} sent: ${tx.hash}`);
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Propose ${kind}: ${msg}`);
      onError && onError(msg);
    }
  }

  // ───────── transfer stable (wallet → altro wallet) ─────────
  async function doTransferStable() {
    setStatus("");
    if (!provider || !account || !stable) return setStatus("⚠️ configure provider / contracts.");
    if (!xferTo || !isAddress(xferTo)) return setStatus("⚠️ invalid recipient address.");
    try {
      const amt = ethers.parseUnits(String(xferAmt || "0"), stableDec);
      if (amt <= 0n) return setStatus("⚠️ amount must be > 0.");
      const signer = await provider.getSigner();
      const tx = await stable.connect(signer).transfer(xferTo, amt);
      await tx.wait();
      setStatus(`✅ Transfer ${fmt(amt, stableDec)} ${stableSym}: ${tx.hash}`);
      setXferAmt("");
      await refreshWalletBalances();
      await refreshInventoryBalances();
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Transfer stable: ${msg}`);
      onError && onError(msg);
    }
  }

  const connected = !!provider && !!account;

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-5 space-y-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xl md:text-2xl bg-clip-text text-transparent bg-gradient-to-r from-indigo-300 via-fuchsia-300 to-cyan-300">
          Maker • Inventory
        </h2>

        <div
          className={`px-3 py-1 rounded-xl text-xs border ${
            isMaker
              ? "bg-emerald-900/20 border-emerald-800 text-emerald-200"
              : isMaker === false
              ? "bg-red-900/20 border-red-800 text-red-200"
              : "bg-neutral-900/40 border-neutral-700 text-neutral-300"
          }`}
        >
          {connected
            ? isMaker === null
              ? "Verification role…"
              : isMaker
              ? "✔ Maker wallet"
              : "✖ not Maker wallet"
            : "Wallet not connected"}
        </div>
      </div>

      {/* Balances */}
      <div className="grid md:grid-cols-3 gap-2 mb-3 text-sm">
        <div className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-3">
          <div className="text-neutral-400">Wallet {stableSym}</div>
          <div className="font-mono">{walletStable}</div>
        </div>

        {walletAssets && walletAssets.length ? (
          walletAssets.map((w) => (
            <div key={String(w.id)} className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-3">
              <div className="text-neutral-400">Wallet {w.symbol}</div>
              <div className="font-mono">{fmt(w.balance, w.decimals)}</div>
            </div>
          ))
        ) : (
          <div className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-3">Assets: —</div>
        )}

        <div className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-3">
          <div className="text-neutral-400">Inv {stableSym}</div>
          <div className="font-mono">{invStable}</div>
        </div>

        <div className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-3">
          <div className="text-neutral-400">Inv {selSym}</div>
          <div className="font-mono">{invSelAsset}</div>
        </div>
      </div>

      {/* Stable deposit/withdraw */}
      <div className="rounded-xl p-4 border border-white/10 bg-white/5 mb-4">
        <div className="text-sm text-neutral-300 mb-3">
          Deposit Stable in the Inventory ({stableSym}, dec {stableDec})
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 md:gap-4">
          <div className="md:col-span-2 flex flex-wrap items-stretch gap-2 md:gap-3 min-w-0">
            <input
              className="w-full md:flex-1 px-4 py-3 h-12 text-base rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none min-w-0"
              placeholder={`Amount ${stableSym}`}
              value={amtStable}
              onChange={(e) => setAmtStable(e.target.value)}
            />
            <button
              onClick={() => setAmtStable(walletStable)}
              className="px-3 py-2 h-12 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 shrink-0 whitespace-nowrap"
            >
              Max Wallet
            </button>
            <button
              onClick={() => setAmtStable(invStable)}
              className="px-3 py-2 h-12 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 shrink-0 whitespace-nowrap"
            >
              Max Inventory
            </button>
          </div>

          <button onClick={doDepositStable} className="w-full md:w-auto px-3 py-2 h-12 text-sm rounded-xl bg-indigo-600 hover:bg-indigo-500">
            Deposit
          </button>

          <button onClick={doWithdrawStable} className="w-full md:w-auto px-3 py-2 h-12 text-sm rounded-xl bg-neutral-800 border border-neutral-700 hover:border-red-500">
            Withdraw
          </button>
        </div>
      </div>

      {/* Asset selection + deposit/withdraw */}
      <div className="rounded-xl p-4 border border-white/10 bg-white/5">
        <div className="text-sm text-neutral-300 mb-2">Deposit Asset in the Market</div>

        <div className="grid md:grid-cols-3 gap-2 mb-2">
          <select
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
            value={selId}
            onChange={(e) => setSelId(e.target.value)}
          >
            {assetMetas.length === 0 ? (
              <option value="">— empty asset list —</option>
            ) : (
              assetMetas.map((a) => (
              <option key={String(a.id)} value={String(a.id)}>
                {a.symbol} · {a.token ? `${String(a.token).slice(0, 6)}…${String(a.token).slice(-4)}` : "—"}
              </option>
            ))

            )}
          </select>

          <input
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
            placeholder={`Qty ${selSym} (dec ${selDec})`}
            value={qtyAsset}
            onChange={(e) => setQtyAsset(e.target.value)}
          />

          <div className="text-sm self-center text-neutral-400">decimals: {selDec}</div>
        </div>

        <div className="grid md:grid-cols-2 gap-2">
          <button onClick={doDepositAsset} className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500">
            Deposit
          </button>
          <button onClick={doWithdrawAsset} className="px-4 py-2 rounded-xl bg-neutral-800 border border-neutral-700 hover:border-red-500">
            Withdraw
          </button>
        </div>
      </div>

      {/* Stable Propose */}
      <div className="rounded-xl p-4 border border-white/10 bg-white/5">
        <div className="text-sm text-neutral-300 mb-2 flex items-center justify-between">
          <span>Propose Stable Mint/Burn</span>
          {stablePlatformOk === false && (
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
            placeholder={`Amount ${stableSym}`}
            value={amtStable}
            onChange={(e) => setAmtStable(e.target.value)}
          />
          <input
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
            placeholder="Investor (0x...)"
            value={propInvestor}
            onChange={(e) => setPropInvestor(e.target.value)}
          />
        </div>

        <div className="grid md:grid-cols-2 gap-2">
          <button
            onClick={() => doProposeStable("MINT")}
            disabled={stablePlatformOk === false}
            className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-emerald-500 disabled:opacity-60"
          >
            Propose Stable Mint
          </button>
          <button
            onClick={() => doProposeStable("BURN")}
            disabled={stablePlatformOk === false}
            className="px-4 py-2 rounded-xl bg-neutral-800 border border-neutral-700 hover:border-red-500 disabled:opacity-60"
          >
            Propose Stable Burn
          </button>
        </div>

        <p className="mt-2 text-xs text-neutral-400">
          (Note: <code>orderId</code> is automatically hashed if you send plain text)
        </p>
      </div>

      {/* Propose events for Depositary (MakerMintProposed/MakerBurnProposed) */}
      <div className="rounded-xl p-4 border border-white/10 bg-white/5">
        <div className="text-sm text-neutral-300 mb-2 flex items-center justify-between">
          <span>Propose Asset Mint/Burn</span>
          {assetPlatformOk === false && (
            <span className="text-red-400 text-xs">Not PLATFORM_ROLE: tx will fail.</span>
          )}
        </div>

        <div className="grid md:grid-cols-3 gap-2 mb-2">
          <select
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
            value={selId}
            onChange={(e) => setSelId(e.target.value)}
          >
            {assetMetas.length === 0 ? (
              <option value="">— empty asset list —</option>
            ) : (
              assetMetas.map((a) => (
                <option key={String(a.id)} value={String(a.id)}>
                  {a.symbol} · {a.token ? `${String(a.token).slice(0, 6)}…${String(a.token).slice(-4)}` : "—"}
                </option>
              ))

            )}
          </select>

          <input
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
            placeholder="Order Id (text or 0x…32 bytes)"
            value={propOrderId}
            onChange={(e) => setPropOrderId(e.target.value)}
          />

          <input
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
            placeholder={`Qty ${selSym} (dec ${selDec})`}
            value={qtyAsset}
            onChange={(e) => setQtyAsset(e.target.value)}
          />
        </div>

        <div className="grid md:grid-cols-2 gap-2">
          <button
            onClick={() => doProposeAsset("MINT")}
            disabled={assetPlatformOk === false}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60"
          >
            Propose Mint
          </button>
          <button
            onClick={() => doProposeAsset("BURN")}
            disabled={assetPlatformOk === false}
            className="px-4 py-2 rounded-xl bg-neutral-800 border border-neutral-700 hover:border-red-500 disabled:opacity-60"
          >
            Propose Burn
          </button>
        </div>

        <p className="mt-2 text-xs text-neutral-400">
          (Note: <code>orderId</code> is automatically hashed if you send plain text)
        </p>
      </div>

      {/* Transfer stable from wallet */}
      <div className="rounded-xl p-4 border border-white/10 bg-white/5 mb-4">
        <div className="text-sm text-neutral-300 mb-2">Transfer Stable from Wallet</div>

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

          <button onClick={doTransferStable} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500">
            Transfer
          </button>
        </div>

        <p className="mt-2 text-xs text-neutral-400">Transfer stable from maker wallet to an investor wallet.</p>
      </div>

      {/* Footer status + refresh */}
      <div className="mt-3 flex items-center justify-between text-sm">
        <button
          onClick={() => {
            refreshWalletBalances();
            refreshInventoryBalances();
          }}
          className="px-3 py-1.5 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500"
        >
          Refresh
        </button>

        {status && <div className="text-neutral-300 whitespace-pre-wrap">{status}</div>}
      </div>
    </section>
  );
}
