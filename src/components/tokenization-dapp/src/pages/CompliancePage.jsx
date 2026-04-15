import React, { useEffect, useMemo, useRef, useState } from "react";
import { Contract, ethers, isAddress } from "ethers";

/**
 * CompliancePage (NEW)
 * Goal: same functionality as CompliancePage_OLD.jsx, but compatible with new contracts + UI closer to screenshot.
 *
 * Writes to ComplianceRegistry (UUPS proxy):
 *  - setWhitelist(address,bool)
 *  - setKycExpiry(address,uint256)
 *
 * Reads from ComplianceRegistry:
 *  - isWhitelisted(address)
 *  - kycexpiry(address)
 *
 * Role check:
 *  - Primary: hasRole(COMPLIANCE_ROLE, account) on registry (authoritative for writes)
 *  - Optional: also checks hasRole on a "gate" token/contract if provided (display/debug only)
 */
export default function CompliancePage({
  provider,
  account,
  registryAddress,
  complianceGateAddress, // optional token/gate to check hasRole(COMPLIANCE_ROLE)
  expectedChainId,       // optional chain warning
  onError,
}) {
  const COMPLIANCE_ROLE = ethers.id("COMPLIANCE_ROLE");

  const REGISTRY_ABI = [
    "function setWhitelist(address,bool)",
    "function setKycExpiry(address,uint256)",
    "function isWhitelisted(address) view returns (bool)",
    "function kycexpiry(address) view returns (uint256)",
    "function hasRole(bytes32,address) view returns (bool)",
  ];
  const ACL_ABI = ["function hasRole(bytes32,address) view returns (bool)"];

  const registry = useMemo(() => {
    if (!provider || !registryAddress) return null;
    return new Contract(registryAddress, REGISTRY_ABI, provider);
  }, [provider, registryAddress]);

  const gate = useMemo(() => {
    if (!provider || !complianceGateAddress) return null;
    return new Contract(complianceGateAddress, ACL_ABI, provider);
  }, [provider, complianceGateAddress]);

  // ─────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────
  const [authorized, setAuthorized] = useState(null); // on registry
  const [gateRole, setGateRole] = useState(null);     // optional
  const [status, setStatus] = useState("");

  const [investor, setInvestor] = useState("");
  const [allowed, setAllowed] = useState(true);
  const [expiry, setExpiry] = useState("0"); // unix seconds string (0 = not set)

  const [lastCheck, setLastCheck] = useState({ whitelisted: null, kycExpiry: null });
  const [updatedState, setUpdatedState] = useState(false);

  const checkSeq = useRef(0);
  const autoTimer = useRef(null);

  // ─────────────────────────────────────────────────────────
  // Network + Role checks
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;

    (async () => {
      setStatus("");
      setAuthorized(null);
      setGateRole(null);

      if (!provider || !account) return;

      // optional chain warning
      try {
        if (expectedChainId) {
          const net = await provider.getNetwork();
          const got = Number(net.chainId);
          if (Number(expectedChainId) !== got) {
            if (mounted) setStatus(`⚠️ Wrong network: connected ${got}, expected ${expectedChainId}`);
          }
        }
      } catch {}

      // registry role check (authoritative)
      try {
        if (!registry) {
          if (mounted) setAuthorized(null);
        } else {
          const ok = await registry.hasRole(COMPLIANCE_ROLE, account);
          if (mounted) setAuthorized(Boolean(ok));
        }
      } catch (e) {
        const msg = e?.shortMessage || e?.reason || e?.message || String(e);
        if (mounted) {
          setAuthorized(false);
          setStatus(`Error registry role check: ${msg}`);
        }
        onError && onError(msg);
      }

      // optional gate role check (debug)
      try {
        if (!gate) {
          if (mounted) setGateRole(null);
        } else {
          const ok = await gate.hasRole(COMPLIANCE_ROLE, account);
          if (mounted) setGateRole(Boolean(ok));
        }
      } catch {
        if (mounted) setGateRole(null);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [provider, account, registry, gate, expectedChainId, onError, COMPLIANCE_ROLE]);

  // ─────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────
  function normalizeInvestor(v) {
    return (v || "").trim();
  }

  function setExpiryDays(days) {
    const now = Math.floor(Date.now() / 1000);
    setExpiry(String(now + days * 24 * 60 * 60));
  }

  function validateBase() {
    if (!provider || !account) return "Connect wallet.";
    if (!registry || !registryAddress) return "Configure Compliance Registry address.";
    if (!isAddress(investor)) return "Investor wallet address not valid.";
    if (authorized === false) return "You do NOT have COMPLIANCE_ROLE on the registry.";
    return null;
  }

  function validateExpiry() {
    const t = (expiry ?? "").trim();
    if (!t) return "Expiry is required.";
    if (!/^\d+$/.test(t)) return "Expiry must be unix seconds (integer).";
    return null;
  }

  function fmtExpiry(secLike) {
    if (secLike === null || secLike === undefined) return "—";
    const s = typeof secLike === "bigint" ? secLike.toString() : String(secLike);
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return `${s} (not set up)`;
    try {
      return `${s} (${new Date(n * 1000).toLocaleString()})`;
    } catch {
      return s;
    }
  }

  async function doCheck(opts = { silent: false }) {
    const silent = !!opts?.silent;
    const mySeq = ++checkSeq.current;

    setUpdatedState(false);
    if (!registry) {
      if (!silent) setStatus("⚠️ Configure Compliance Registry address.");
      return;
    }
    if (!isAddress(investor)) {
      if (!silent) setStatus("⚠️ Investor wallet address not valid.");
      return;
    }

    try {
      if (!silent) setStatus("Reading state…");
      const [w, k] = await Promise.all([
        registry.isWhitelisted(investor),
        registry.kycexpiry(investor),
      ]);

      // ignore if newer check already started
      if (mySeq !== checkSeq.current) return;

      setLastCheck({ whitelisted: Boolean(w), kycExpiry: BigInt(k) });
      setUpdatedState(true);
      if (!silent) setStatus("✅ Updated State");
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      if (!silent) setStatus(`❌ Check failed: ${msg}`);
      onError && onError(msg);
    }
  }

  async function doApplyBoth() {
    const v = validateBase();
    if (v) return setStatus(`⚠️ ${v}`);
    const ve = validateExpiry();
    if (ve) return setStatus(`⚠️ ${ve}`);

    try {
      const s = await provider.getSigner();
      const reg = registry.connect(s);

      setStatus("⏳ Tx1: setWhitelist…");
      const tx1 = await reg.setWhitelist(investor, allowed);
      await tx1.wait();

      setStatus("⏳ Tx2: setKycExpiry…");
      const tx2 = await reg.setKycExpiry(investor, BigInt(expiry.trim()));
      await tx2.wait();

      setStatus("✅ Applied (whitelist + kyc).");
      await doCheck({ silent: false });
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Apply failed: ${msg}`);
      onError && onError(msg);
    }
  }

  // ─────────────────────────────────────────────────────────
  // Auto verify state (debounced)
  // When the investor address changes (or registry changes), auto-refresh the Verify State panel.
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    const inv = normalizeInvestor(investor);

    // clear pending
    if (autoTimer.current) {
      clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }

    if (!registry || !isAddress(inv)) {
      setUpdatedState(false);
      setLastCheck({ whitelisted: null, kycExpiry: null });
      return;
    }

    autoTimer.current = setTimeout(() => {
      doCheck({ silent: true });
    }, 350);

    return () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
      autoTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [investor, registryAddress]);

  // ─────────────────────────────────────────────────────────
  // UI helpers
  // ─────────────────────────────────────────────────────────
  const connected = !!provider && !!account;

  const roleBadge = (() => {
    if (!connected) return { text: "wallet not connected", cls: "bg-neutral-900/40 border-neutral-700 text-neutral-300" };
    if (authorized === null) return { text: "verifying role…", cls: "bg-neutral-900/40 border-neutral-700 text-neutral-300" };
    if (authorized) return { text: "✔ authorized compliance wallet", cls: "bg-emerald-900/20 border-emerald-800 text-emerald-200" };
    return { text: "✖ not authorized compliance wallet", cls: "bg-red-900/20 border-red-800 text-red-200" };
  })();

  const gateBadge = (() => {
    if (!complianceGateAddress) return null;
    if (gateRole === null) return { text: "gate role: unknown", cls: "bg-neutral-900/40 border-neutral-700 text-neutral-300" };
    if (gateRole) return { text: "gate: ✔ COMPLIANCE_ROLE", cls: "bg-cyan-900/20 border-cyan-800 text-cyan-200" };
    return { text: "gate: ✖ no role", cls: "bg-amber-900/20 border-amber-800 text-amber-200" };
  })();

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 gap-3">
        <div>
          <h2 className="text-xl md:text-2xl font-semibold text-white">Compliance</h2>
          <div className="text-xs text-neutral-400">Whitelist/KYC and Compliance Gate</div>
        </div>
      </div>

      {/* Card */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        {/* Top bar */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="text-lg md:text-xl bg-clip-text text-transparent bg-gradient-to-r from-indigo-300 via-fuchsia-300 to-cyan-300">
            Compliance Authorization
          </div>
          <div className={`px-3 py-1 rounded-xl text-xs border whitespace-nowrap ${roleBadge.cls}`}>{roleBadge.text}</div>
        </div>

        {/* Addresses (compact, optional) */}
        <div className="mb-4 text-xs text-neutral-400 space-y-1">
          <div className="flex flex-wrap gap-x-2">
            <span>Registry:</span>
            <span className="font-mono break-all text-neutral-300">{registryAddress || "—"}</span>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <span>Gate:</span>
            <span className="font-mono break-all text-neutral-300">{complianceGateAddress || "—"}</span>
            {gateBadge && <span className={`ml-2 px-2 py-0.5 rounded-lg border ${gateBadge.cls}`}>{gateBadge.text}</span>}
          </div>
        </div>

        {/* Row: investor + allowed */}
        <div className="grid md:grid-cols-2 gap-3 mb-3">
          <input
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none text-neutral-100"
            placeholder="Investor (0x...)"
            value={investor}
            onChange={(e) => setInvestor(normalizeInvestor(e.target.value))}
          />

          <div className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-neutral-200 select-none">
              <input
                type="checkbox"
                className="w-4 h-4"
                checked={allowed}
                onChange={(e) => setAllowed(e.target.checked)}
              />
              Allowed (whitelist)
            </label>
            <div className="text-xs text-neutral-400">{allowed ? "enabled" : "disabled"}</div>
          </div>
        </div>

        {/* Row: expiry + quick buttons + apply */}
        <div className="grid md:grid-cols-[1fr_auto] gap-3 mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="flex-1 min-w-[180px] px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none text-neutral-100"
              placeholder="KYC expiry (unix seconds)"
              value={expiry}
              onChange={(e) => setExpiry((e.target.value || "").trim())}
            />
            <button
              onClick={() => setExpiryDays(7)}
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 text-sm"
              type="button"
              title="Set expiry = now + 7 days"
            >
              +7d
            </button>
            <button
              onClick={() => setExpiryDays(30)}
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 text-sm"
              type="button"
              title="Set expiry = now + 30 days"
            >
              +30d
            </button>
            <button
              onClick={() => setExpiryDays(90)}
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 text-sm"
              type="button"
              title="Set expiry = now + 90 days"
            >
              +90d
            </button>
          </div>

          <button
            onClick={doApplyBoth}
            className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 font-medium"
            disabled={authorized === false}
            type="button"
            title="Apply (whitelist + kyc)"
          >
            Apply (whitelist + kyc)
          </button>
        </div>

        {/* Verify section */}
        <div className="grid md:grid-cols-3 gap-3 items-stretch">
          <button
            onClick={() => doCheck({ silent: false })}
            className="px-4 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 text-sm"
            type="button"
          >
            Verify State
          </button>

          <div className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-3">
            <div className="text-xs text-neutral-400">whitelisted</div>
            <div className="font-mono text-sm text-neutral-100">
              {lastCheck.whitelisted === null ? "—" : lastCheck.whitelisted ? "true" : "false"}
            </div>
          </div>

          <div className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-3">
            <div className="text-xs text-neutral-400">kycExpiry</div>
            <div className="font-mono text-sm text-neutral-100">{fmtExpiry(lastCheck.kycExpiry)}</div>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-2 ${updatedState ? "text-emerald-300" : "text-neutral-500"}`}>
            <span className={`inline-block w-3 h-3 rounded ${updatedState ? "bg-emerald-400/80" : "bg-neutral-500/40"}`} />
            {updatedState ? "Updated State" : "State not checked yet"}
          </span>
          {isAddress(investor) && registry && (
            <span className="text-neutral-500">(auto-refresh enabled)</span>
          )}
        </div>

        {/* Status */}
        {status && (
          <div className="mt-4 text-xs rounded-xl border border-white/10 bg-neutral-950/40 p-3 text-neutral-200 whitespace-pre-wrap">
            {status}
          </div>
        )}
      </div>
    </section>
  );
}