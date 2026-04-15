import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Contract, ethers, isAddress } from "ethers";

/**
 * AdminPage — Constant NAV (MMF-style)
 *
 * Coerente con la tua nota:
 * - NAV_t = P_t / N_t = C, costante (tipicamente 1€)
 * - Il rendimento si riflette nell'aumento delle shares visibili N_t^A = b_A * I_t
 * - La variabile globale I_t è l'indice cumulativo (qui: indexRay, 1e18)
 *
 * UI:
 * - KPI: NAV fisso 1€; Yield cumulato da I_t; Mintati in più (rebase) = totalSupply - totalBaseSupply
 * - Update: si aggiorna l'INDEX (I_t), non il NAV
 */
export default function AdminPage({ provider, account, fundAddress, onError }) {
  const [status, setStatus] = useState("");
  const [lastTx, setLastTx] = useState("");

  // auth
  const [isUpdater, setIsUpdater] = useState(null);

  // on-chain reads
  const [tokenSymbol, setTokenSymbol] = useState("FUND");
  const [indexRay, setIndexRayState] = useState(null); // bigint (1e18)
  const [totalSupply, setTotalSupply] = useState(null); // bigint (visible, 18d)
  const [totalBase, setTotalBase] = useState(null); // bigint (base)

  // update: Index
  const [mode, setMode] = useState("absolute"); // absolute | bumpPct
  const [indexHuman, setIndexHuman] = useState(""); // e.g. 1.0375 (this is I_t)
  const [bumpPctHuman, setBumpPctHuman] = useState("0.10"); // +0.10%

  // timestamp
  const [tsMode, setTsMode] = useState("now"); // now | custom
  const [tsCustom, setTsCustom] = useState("");

  // demo wallets
  const [walletListText, setWalletListText] = useState(
    [
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    ].join("\n")
  );

  const FUND_ABI = [
    // roles
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
    "function NAV_UPDATER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",

    // views
    "function symbol() view returns (string)",
    "function indexRay() view returns (uint256)",
    "function currentIndexRay() view returns (uint256)", // optional
    "function totalSupply() view returns (uint256)",
    "function totalBaseSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",

    // actions (compat)
    "function setIndexRay(uint256 newIndexRay, uint64 timestamp) external",
    "function setNavAndRebase(uint256 value, uint64 timestamp) external",
  ];

  const fund = useMemo(() => {
    if (!provider || !fundAddress || !isAddress(fundAddress)) return null;
    return new Contract(fundAddress, FUND_ABI, provider);
  }, [provider, fundAddress]);

  const connected = !!provider && !!account;

  const short = (a) =>
    a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "—";

  const parseWallets = useCallback(() => {
    const lines = String(walletListText || "")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

    const seen = new Set();
    const out = [];
    for (const x of lines) {
      const k = x.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  }, [walletListText]);

  const [balances, setBalances] = useState([]); // [{addr, bal}]
  const [balancesBefore, setBalancesBefore] = useState(null);

  const fmtToken = (v) => {
    try {
      return ethers.formatUnits(v ?? 0n, 18);
    } catch {
      return String(v ?? "0");
    }
  };

  const fmtRay = (v) => {
    try {
      return ethers.formatUnits(v ?? 0n, 18); // 1e18
    } catch {
      return "—";
    }
  };

  function pickTimestamp() {
    if (tsMode === "custom") {
      const t = Number(String(tsCustom || "").trim());
      if (!Number.isFinite(t) || t <= 0) throw new Error("Timestamp custom non valido (in secondi).");
      return t;
    }
    return Math.floor(Date.now() / 1000);
  }

  async function readIndexRayStrict() {
    if (!fund) throw new Error("Fund non inizializzato (provider/address).");
    try {
      return await fund.indexRay();
    } catch (e1) {
      try {
        return await fund.currentIndexRay();
      } catch (e2) {
        const msg =
          e2?.shortMessage || e2?.reason || e2?.message ||
          e1?.shortMessage || e1?.reason || e1?.message || "unknown error";
        throw new Error(`Impossibile leggere indexRay() / currentIndexRay(). Dettaglio: ${msg}`);
      }
    }
  }

  async function refreshAll() {
    setStatus("");
    if (!fund) return setStatus("⚠️ Configura fundAddress (proxy) correttamente.");
    if (!connected) return setStatus("⚠️ Connetti il wallet.");

    try {
      // symbol sanity-check
      const s = await fund.symbol();
      setTokenSymbol(String(s));

      // role check
      let ok = false;
      try {
        const [navRole, adminRole] = await Promise.all([
          fund.NAV_UPDATER_ROLE(),
          fund.DEFAULT_ADMIN_ROLE(),
        ]);
        const [hasNav, hasAdmin] = await Promise.all([
          fund.hasRole(navRole, account),
          fund.hasRole(adminRole, account),
        ]);
        ok = Boolean(hasNav || hasAdmin);
      } catch {
        ok = false;
      }
      setIsUpdater(ok);

      const idx = await readIndexRayStrict();
      setIndexRayState(idx);

      // prefill input only if empty
      setIndexHuman((prev) => (prev && prev.trim() ? prev : ethers.formatUnits(idx, 18)));

      // supply reads
      try {
        setTotalSupply(await fund.totalSupply());
      } catch {
        setTotalSupply(null);
      }
      try {
        setTotalBase(await fund.totalBaseSupply());
      } catch {
        setTotalBase(null);
      }

      // balances
      const addrs = parseWallets().filter((a) => isAddress(a));
      const bals = await Promise.all(
        addrs.map(async (addr) => {
          try {
            const b = await fund.balanceOf(addr);
            return { addr, bal: b };
          } catch {
            return { addr, bal: null };
          }
        })
      );
      setBalances(bals);
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Refresh failed: ${msg}`);
      onError && onError(msg);
    }
  }

  useEffect(() => {
    if (!provider || !account || !fund) return;
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, account, fundAddress]);

  async function snapshotBalancesBefore() {
    if (!fund) return;
    const addrs = parseWallets().filter((a) => isAddress(a));
    const bals = await Promise.all(
      addrs.map(async (addr) => {
        try {
          const b = await fund.balanceOf(addr);
          return { addr, bal: b };
        } catch {
          return { addr, bal: null };
        }
      })
    );
    setBalancesBefore(bals);
  }

  function computeNewIndexRay(currentIdx) {
    const oldIdx = BigInt(currentIdx);

    if (mode === "absolute") {
      const x = String(indexHuman || "").trim();
      if (!x) throw new Error("Index (Iₜ) vuoto.");
      const n = Number(x);
      if (!Number.isFinite(n) || n <= 0) throw new Error("Index (Iₜ) deve essere > 0.");
      const newIdx = ethers.parseUnits(x, 18);
      return { oldIdx, newIdx };
    }

    // bumpPct: newI = oldI * (1 + pct/100)
    const p = String(bumpPctHuman || "").trim();
    if (!p) throw new Error("Percentuale vuota.");
    const pn = Number(p);
    if (!Number.isFinite(pn)) throw new Error("Percentuale non valida.");
    if (pn < 0) throw new Error("Percentuale negativa non permessa.");

    const pctRay = ethers.parseUnits(p, 18);
    const pctOver100 = pctRay / 100n;
    const factorRay = 1000000000000000000n + pctOver100; // 1e18*(1+p/100)
    const newIdx = (oldIdx * factorRay) / 1000000000000000000n;
    return { oldIdx, newIdx };
  }

  async function doUpdateIndex() {
    setStatus("");
    setLastTx("");

    if (!fund) return setStatus("⚠️ Configura fundAddress (proxy) correttamente.");
    if (!connected) return setStatus("⚠️ Connetti il wallet.");
    if (isUpdater === false) return setStatus("⛔ Non hai i permessi (NAV_UPDATER_ROLE / Admin).");

    try {
      let idx = indexRay;
      if (idx == null) {
        const onchain = await readIndexRayStrict();
        setIndexRayState(onchain);
        idx = onchain;
      }

      await snapshotBalancesBefore();

      const ts = pickTimestamp();
      const { oldIdx, newIdx } = computeNewIndexRay(idx);

      if (newIdx <= 0n) throw new Error("Nuovo index non valido.");
      if (newIdx < oldIdx) throw new Error("Nuovo index < index attuale (non permesso).");

      const signer = await provider.getSigner();
      const f = fund.connect(signer);

      setStatus("⏳ Invio transazione (update INDEX Iₜ)…");

      let tx;
      try {
        tx = await f.setIndexRay(newIdx, ts);
      } catch {
        // fallback legacy compat
        tx = await f.setNavAndRebase(newIdx, ts);
      }

      setLastTx(tx.hash);
      await tx.wait();

      setStatus(`✅ Index aggiornato. tx=${tx.hash}`);
      await refreshAll();
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Update failed: ${msg}`);
      onError && onError(msg);
    }
  }

  // --- computed UI ---
  const It = useMemo(() => {
    if (indexRay == null) return null;
    return Number(ethers.formatUnits(indexRay, 18));
  }, [indexRay]);

  const indexText = useMemo(() => (indexRay == null ? "—" : fmtRay(indexRay)), [indexRay]);

  const yieldPctText = useMemo(() => {
    if (It == null || !Number.isFinite(It)) return "—";
    const y = (It - 1) * 100;
    const sign = y >= 0 ? "+" : "";
    return `${sign}${y.toFixed(4)}%`;
  }, [It]);

  const supplyHuman = useMemo(() => {
    try {
      if (totalSupply == null) return "—";
      return ethers.formatUnits(totalSupply, 18);
    } catch {
      return "—";
    }
  }, [totalSupply]);

  const baseHuman = useMemo(() => {
    try {
      if (totalBase == null) return "—";
      return ethers.formatUnits(totalBase, 18);
    } catch {
      return "—";
    }
  }, [totalBase]);

  const extraMinted = useMemo(() => {
    try {
      if (totalSupply == null || totalBase == null) return null;
      return totalSupply >= totalBase ? totalSupply - totalBase : 0n;
    } catch {
      return null;
    }
  }, [totalSupply, totalBase]);

  const extraMintedHuman = useMemo(() => {
    if (extraMinted == null) return "—";
    try {
      return ethers.formatUnits(extraMinted, 18);
    } catch {
      return "—";
    }
  }, [extraMinted]);

  const beforeMap = useMemo(() => {
    const m = new Map();
    (balancesBefore || []).forEach((x) => m.set(x.addr.toLowerCase(), x.bal));
    return m;
  }, [balancesBefore]);

  const preview = useMemo(() => {
    try {
      if (indexRay == null) return null;
      const { oldIdx, newIdx } = computeNewIndexRay(indexRay);
      const oldI = Number(ethers.formatUnits(oldIdx, 18));
      const newI = Number(ethers.formatUnits(newIdx, 18));
      const oldY = (oldI - 1) * 100;
      const newY = (newI - 1) * 100;
      const mult = newI / oldI;
      return { oldIdx, newIdx, oldI, newI, oldY, newY, mult };
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, indexHuman, bumpPctHuman, indexRay]);

  return (
    <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-5">
      {/* decorative glow */}
      <div className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-indigo-500/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-24 h-64 w-64 rounded-full bg-fuchsia-500/20 blur-3xl" />

      <div className="relative flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl md:text-2xl bg-clip-text text-transparent bg-gradient-to-r from-indigo-300 via-fuchsia-300 to-cyan-300">
            Admin • Constant NAV (1€) • Index Iₜ
          </h2>
          <div className="text-xs text-neutral-400 mt-1">
            NAV (prezzo quota) è <span className="font-mono">costante</span>. Lo yield si riflette nell&apos;aumento delle shares via indice globale <span className="font-mono">Iₜ</span> (<span className="font-mono">indexRay</span>).
          </div>
        </div>

        <div
          className={`px-3 py-1 rounded-xl text-xs border ${
            connected
              ? isUpdater === null
                ? "bg-neutral-900/40 border-neutral-700 text-neutral-300"
                : isUpdater
                  ? "bg-emerald-900/20 border-emerald-800 text-emerald-200"
                  : "bg-red-900/20 border-red-800 text-red-200"
              : "bg-neutral-900/40 border-neutral-700 text-neutral-300"
          }`}
        >
          {connected
            ? isUpdater === null
              ? "Verifica ruolo…"
              : isUpdater
                ? "✔ Authorized"
                : "✖ Not authorized"
            : "Wallet non connesso"}
        </div>
      </div>

      {(!fund || !isAddress(fundAddress || "")) && (
        <div className="relative mb-4 text-xs text-amber-300">
          ⚠️ fundAddress non valido o provider non pronto. Assicurati di passare il proxy del FundToken.
        </div>
      )}

      {/* Addresses */}
      <div className="relative rounded-xl p-4 border border-white/10 bg-white/5 text-xs text-neutral-300 space-y-1 mb-4">
        <div>
          Fund (proxy): <span className="font-mono break-all">{fundAddress || "—"}</span>{" "}
          <span className="text-neutral-500">({tokenSymbol})</span>
        </div>
        <div>
          Wallet: <span className="font-mono break-all">{account || "—"}</span>
        </div>
      </div>

      {/* Top KPIs */}
      <div className="relative rounded-xl p-4 border border-white/10 bg-white/5 mb-4">
        <div className="text-sm text-neutral-200 mb-2">Snapshot on-chain</div>

        <div className="grid md:grid-cols-3 gap-3 text-xs text-neutral-300">
          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="text-neutral-400">NAV (prezzo quota)</div>
            <div className="font-mono text-2xl tracking-tight">1.0000 €</div>
            <div className="text-neutral-500 mt-1">Constant NAV (MMF-style)</div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="text-neutral-400">Yield cumulato</div>
            <div className="font-mono text-2xl tracking-tight">{yieldPctText}</div>
            <div className="text-neutral-500 mt-1">
              da <span className="font-mono">Iₜ</span> = <span className="font-mono">{indexText}</span>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="text-neutral-400">Mintati in più (rebase)</div>
            <div className="font-mono text-2xl tracking-tight">{extraMintedHuman}</div>
            <div className="text-neutral-500 mt-1">totalSupply − totalBaseSupply</div>
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          <button
            onClick={refreshAll}
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 text-xs"
          >
            Refresh
          </button>
          <div className="text-xs text-neutral-500 flex items-center gap-2">
            <span className="font-mono">totalSupply:</span>{" "}
            <span className="font-mono text-neutral-300">{supplyHuman}</span>
            <span className="text-neutral-600">|</span>
            <span className="font-mono">totalBase:</span>{" "}
            <span className="font-mono text-neutral-300">{baseHuman}</span>
          </div>
        </div>
      </div>

      {/* Action: Update Index */}
      <div className="relative rounded-xl p-4 border border-white/10 bg-white/5 mb-4">
        <div className="text-sm text-neutral-200 mb-2">Aggiorna Index (Iₜ)</div>
        <div className="text-xs text-neutral-400 mb-3">
          Qui aggiorni <span className="font-mono">Iₜ</span> (indexRay). NAV resta fisso a 1€. L’aumento di <span className="font-mono">Iₜ</span> fa crescere le shares visibili.
        </div>

        <div className="grid md:grid-cols-3 gap-2">
          <select
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="absolute">Set Iₜ assoluto</option>
            <option value="bumpPct">Apply yield % (incremento)</option>
          </select>

          {mode === "absolute" ? (
            <input
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none font-mono"
              placeholder="Iₜ (es: 1.037500)"
              value={indexHuman}
              onChange={(e) => setIndexHuman(e.target.value)}
            />
          ) : (
            <input
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none font-mono"
              placeholder="+% (es: 0.10)"
              value={bumpPctHuman}
              onChange={(e) => setBumpPctHuman(e.target.value)}
            />
          )}

          <div className="flex gap-2">
            <select
              className="flex-1 px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
              value={tsMode}
              onChange={(e) => setTsMode(e.target.value)}
            >
              <option value="now">timestamp = now</option>
              <option value="custom">timestamp custom</option>
            </select>

            <input
              className="flex-1 px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none font-mono"
              placeholder="ts (sec)"
              value={tsCustom}
              disabled={tsMode !== "custom"}
              onChange={(e) => setTsCustom(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {["0.01", "0.05", "0.10", "0.50", "1.00"].map((x) => (
            <button
              key={x}
              onClick={() => {
                setMode("bumpPct");
                setBumpPctHuman(x);
              }}
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 text-xs"
            >
              +{x}%
            </button>
          ))}
          <button
            onClick={() => {
              if (indexRay != null) {
                setMode("absolute");
                setIndexHuman(ethers.formatUnits(indexRay, 18));
              }
            }}
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 text-xs"
          >
            Set Iₜ = current
          </button>
        </div>

        {/* Preview */}
        <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-xs text-neutral-300">
          <div className="text-neutral-400 mb-2">Preview (prima di inviare)</div>
          {preview ? (
            <div className="grid md:grid-cols-3 gap-3">
              <div>
                <div className="text-neutral-500">new Iₜ</div>
                <div className="font-mono text-base">{preview.newI.toFixed(6)}</div>
                <div className="text-neutral-600 mt-1 font-mono break-all">
                  newIndexRay: {ethers.formatUnits(preview.newIdx, 18)}
                </div>
              </div>
              <div>
                <div className="text-neutral-500">yield cumulato (new)</div>
                <div className="font-mono text-base">
                  {(preview.newY >= 0 ? "+" : "") + preview.newY.toFixed(4)}%
                </div>
                <div className="text-neutral-600 mt-1">
                  mult ≈ {Number.isFinite(preview.mult) ? preview.mult.toFixed(6) : "—"}
                </div>
              </div>
              <div>
                <div className="text-neutral-500">NAV (quota)</div>
                <div className="font-mono text-base">1.0000 €</div>
                <div className="text-neutral-600 mt-1">NAV resta costante (MMF-style)</div>
              </div>
            </div>
          ) : (
            <div className="text-neutral-500">—</div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={doUpdateIndex}
            disabled={!connected || !fund || isUpdater !== true}
            className={`px-4 py-2 rounded-xl text-sm transition ${
              !connected || !fund || isUpdater !== true
                ? "bg-neutral-800/50 text-neutral-400 cursor-not-allowed"
                : "bg-indigo-600 hover:bg-indigo-500 shadow-lg shadow-indigo-500/20"
            }`}
          >
            Update Iₜ (index)
          </button>

          {lastTx && (
            <span className="text-xs text-neutral-400">
              tx: <span className="font-mono">{short(lastTx)}</span>
            </span>
          )}
        </div>

        {status && (
          <div className="mt-3 text-xs text-neutral-300 whitespace-pre-wrap">
            {status}
          </div>
        )}
      </div>

      {/* Demo balances */}
      <div className="relative rounded-xl p-4 border border-white/10 bg-white/5">
        <div className="text-sm text-neutral-200 mb-2">
          Demo: balance che crescono via rebasing (NAV costante)
        </div>

        <div className="text-xs text-neutral-400 mb-2">
          Incolla qui una lista di wallet (uno per riga). Dopo <span className="font-mono">Update Iₜ</span> vedrai i balance aggiornarsi automaticamente.
        </div>

        <textarea
          className="w-full min-h-[120px] px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none font-mono text-xs"
          value={walletListText}
          onChange={(e) => setWalletListText(e.target.value)}
        />

        <div className="mt-3 flex gap-2">
          <button
            onClick={async () => {
              setBalancesBefore(null);
              await refreshAll();
            }}
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 text-xs"
          >
            Refresh balances
          </button>

          <button
            onClick={async () => {
              await snapshotBalancesBefore();
              setStatus("📌 Snapshot BEFORE salvato. Ora aggiorna Iₜ e confronta.");
            }}
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 text-xs"
          >
            Snapshot BEFORE
          </button>
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-neutral-400">
              <tr className="text-left border-b border-white/10">
                <th className="py-2 pr-2">Wallet</th>
                <th className="py-2 pr-2">BEFORE</th>
                <th className="py-2 pr-2">AFTER</th>
                <th className="py-2 pr-2">Δ</th>
              </tr>
            </thead>
            <tbody className="text-neutral-200">
              {(balances || []).map((x) => {
                const b0 = beforeMap.get(x.addr.toLowerCase()) ?? null;
                const b1 = x.bal;

                let delta = null;
                try {
                  if (b0 != null && b1 != null) delta = b1 - b0;
                } catch {}

                return (
                  <tr key={x.addr} className="border-b border-white/5">
                    <td className="py-2 pr-2 font-mono">{x.addr}</td>
                    <td className="py-2 pr-2 font-mono text-neutral-300">
                      {b0 == null ? "—" : fmtToken(b0)}
                    </td>
                    <td className="py-2 pr-2 font-mono">
                      {b1 == null ? "—" : fmtToken(b1)}
                    </td>
                    <td
                      className={`py-2 pr-2 font-mono ${
                        delta == null
                          ? "text-neutral-500"
                          : delta >= 0n
                            ? "text-emerald-300"
                            : "text-red-300"
                      }`}
                    >
                      {delta == null ? "—" : fmtToken(delta)}
                    </td>
                  </tr>
                );
              })}
              {(!balances || balances.length === 0) && (
                <tr>
                  <td className="py-3 text-neutral-500" colSpan={4}>
                    Nessun wallet valido. Incolla indirizzi (uno per riga) e premi “Refresh balances”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
