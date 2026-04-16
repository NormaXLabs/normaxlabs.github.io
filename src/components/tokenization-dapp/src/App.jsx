import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldCheck,
  Banknote,
  Settings,
  Hammer,
  Users,
  Home as HomeIcon,
  Wallet,
  Landmark,
  Copy,
  Check,
  RefreshCw,
  Save as SaveIcon,
  Handshake,
  BadgeCheck,
  PlugZap,
  X,
  ScrollText,
  AlertTriangle,
  MessageCircle,
  Bot,
  Send,
  LoaderCircle,
} from "lucide-react";

// (Se nel tuo progetto usi shadcn/ui, questi import funzionano out-of-the-box. In caso contrario, le classi Tailwind garantiscono comunque un ottimo fallback.)
// Primitivi UI leggeri (niente dipendenze esterne). Se hai shadcn/ui puoi rimettere gli import.
const Button = ({ className = "", variant = "primary", size = "md", ...props }) => {
  const base =
    "inline-flex items-center gap-2 rounded-xl transition focus:outline-none focus:ring-2 focus:ring-offset-0 disabled:opacity-60 disabled:cursor-not-allowed";
  const sizes = { sm: "px-2.5 py-1.5 text-xs", md: "px-3 py-2 text-sm" };
  const variants = {
    primary: "bg-indigo-600 hover:bg-indigo-500",
    secondary: "bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500",
  };
  return <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props} />;
};
const Card = ({ className = "", ...props }) => (
  <div className={`rounded-2xl border border-white/10 bg-white/5 backdrop-blur ${className}`} {...props} />
);
const CardHeader = ({ className = "", ...props }) => <div className={`p-4 ${className}`} {...props} />;
const CardContent = ({ className = "", ...props }) => <div className={`p-4 ${className}`} {...props} />;
const CardTitle = ({ className = "", ...props }) => <h3 className={`text-lg font-semibold ${className}`} {...props} />;
const CardDescription = ({ className = "", ...props }) => <p className={`text-sm text-neutral-400 ${className}`} {...props} />;
const Input = ({ className = "", ...props }) => (
  <input
    className={`px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 outline-none focus:ring-2 focus:ring-indigo-500 ${className}`}
    {...props}
  />
);
const Alert = ({ className = "", ...props }) => <div className={`rounded-2xl border p-3 ${className}`} {...props} />;
const AlertDescription = ({ className = "", ...props }) => <div className={`${className}`} {...props} />;

import CompliancePage from "./pages/CompliancePage.jsx";
import DepositaryPage from "./pages/DepositaryPage.jsx";
import AdminPage from "./pages/AdminPage.jsx";
import MakerPage from "./pages/MakerPage.jsx";
import DistributorPage from "./pages/DistributorPage.jsx";
import InvestorPage from "./pages/InvestorPage.jsx";
import EventRegistryPage from "./pages/EventRegistryPage.jsx";
import { api, API_BASE } from "./api.js";

// ---------- Utils ----------
function getMetaMask() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No EIP-1193 provider found. Install MetaMask.");
  const mm = eth?.providers?.find((p) => p?.isMetaMask) || (eth?.isMetaMask ? eth : null);
  if (!mm) throw new Error("MetaMask does not appear to be active. Set it as default or disable other wallets.");
  return mm;
}
export function idOf(sym) {
  return keccak256(toUtf8Bytes(sym.toUpperCase()));
}
function short(addr) {
  if (!addr || addr.length < 10) return addr || "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
function isHexAddr(v) {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}
function envAddr(key) {
  const v = import.meta.env[key];
  return isHexAddr(v) ? v : "";
}
function envNum(key, fallback = 0) {
  const v = import.meta.env[key];
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function defaultCfgFromEnv() {
  const factory = envAddr("VITE_SECURITY_TOKEN_FACTORY") || envAddr("VITE_FACTORY");
  return {
    // new (chain + events)
    chainId: envNum("VITE_CHAIN_ID", 11155111),
    marketDeployBlock: envNum("VITE_MARKET_DEPLOY_BLOCK", 0),

    // core contracts
    market: envAddr("VITE_MARKET_ADDRESS"),
    stable: envAddr("VITE_STABLE_ADDRESS"),
    oracle: envAddr("VITE_ORACLE_ADDRESS"),
    fund: envAddr("VITE_FUND_ADDRESS"),
    registry: envAddr("VITE_COMPLIANCE_REGISTRY"),

    // new (beacon factory)
    factory,
  };
}
function useLocal(key, initial) {
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return initial;
      const parsed = JSON.parse(raw);
      // ✅ merge: default + salvato
      return { ...initial, ...(parsed || {}) };
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {}
  }, [key, state]);

  return [state, setState];
}

const AGENT_SESSION_STORAGE_KEY = "openclaw-workspace-agent-session-id";
const AGENT_MESSAGES_STORAGE_KEY = "openclaw-workspace-agent-messages";

function getAgentApiBase() {
  return API_BASE;
}

function createAgentWelcomeMessages() {
  return [
    {
      id: "agent-welcome",
      role: "assistant",
      content:
        "I am the workspace assistant. I can help you use the dApp concretely, explain Compliance/Custodian/Maker/Investor flows, and prepare changes to Solidity contracts and frontend code.",
    },
  ];
}

function loadAgentMessages() {
  try {
    const raw = localStorage.getItem(AGENT_MESSAGES_STORAGE_KEY);
    if (!raw) return createAgentWelcomeMessages();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : createAgentWelcomeMessages();
  } catch {
    return createAgentWelcomeMessages();
  }
}


const CHAIN_NAMES = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
  11155111: "Sepolia",
  31337: "Hardhat",
};

// ---------- Tiny Toast ----------
function useFlash() {
  const [flash, setFlash] = useState(null);
  const show = (msg, tone = "ok") => {
    setFlash({ msg, tone, id: Math.random().toString(36).slice(2) });
    setTimeout(() => setFlash(null), 1800);
  };
  return { flash, show };
}
function FlashToaster({ flash }) {
  return (
    <AnimatePresence>
      {flash && (
        <motion.div
          key={flash.id}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className={`fixed right-4 top-4 z-50 rounded-xl border px-4 py-2 backdrop-blur ${
            flash.tone === "err"
              ? "bg-red-950/70 border-red-800 text-red-50"
              : "bg-emerald-950/60 border-emerald-800 text-emerald-50"
          }`}
        >
          {flash.tone === "err" ? "⚠️" : "✨"} {flash.msg}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- UI Bits ----------
function StatusDot({ on }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        on ? "bg-emerald-400 shadow-[0_0_24px_2px_rgba(16,185,129,.6)]" : "bg-neutral-500"
      }`}
    />
  );
}
function Chip({ label, value, bad }) {
  return (
    <div
      className={`px-3 py-1 rounded-xl text-xs border ${
        bad ? "bg-red-900/20 border-red-800 text-red-200" : "bg-neutral-900/60 border-neutral-700 text-neutral-300"
      }`}
    >
      <span className="text-neutral-400">{label}:</span> <code className="ml-1 select-all">{value || "—"}</code>
    </div>
  );
}
function ErrorBanner({ msg, onClose }) {
  if (!msg) return null;
  return (
    <Alert className="bg-red-900/20 border-red-800 text-red-100">
      <AlertDescription className="flex items-start justify-between gap-4 text-sm">
        <span className="whitespace-pre-wrap">{msg}</span>
        <Button size="sm" variant="secondary" className="bg-red-700 hover:bg-red-600 border-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </AlertDescription>
    </Alert>
  );
}
function Copyable({ text, className = "" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 900);
    } catch {}
  };
  return (
    <button onClick={copy} className={`inline-flex items-center gap-1 hover:opacity-90 ${className}`} title="Copia">
      <span className="font-mono">{short(text)}</span>
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function PagePanel({ title, subtitle, children }) {
  return (
    <Card className="border-white/20 bg-white/10 backdrop-blur shadow-2xl">
      <CardHeader className="pb-2">
        <CardTitle className="text-xl">{title}</CardTitle>
        {subtitle && <CardDescription>{subtitle}</CardDescription>}
      </CardHeader>
      <CardContent className="p-6 md:p-7">{children}</CardContent>
    </Card>
  );
}

function AddressInput({ label, value, onChange, placeholder = "0x…" }) {
  const bad = value && !isHexAddr(value);
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-neutral-300">{label}</label>
      <div className="relative">
        <Input
          className={`w-full pr-12 bg-neutral-900/60 border ${
            bad ? "border-red-700 focus-visible:ring-red-500" : "border-neutral-700 focus-visible:ring-indigo-500"
          }`}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
        />
        <button
          type="button"
          onClick={async () => {
            try {
              const t = await navigator.clipboard.readText();
              onChange(t.trim());
            } catch {}
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 w-8 grid place-items-center rounded-lg bg-neutral-800/80 border border-neutral-700 hover:border-indigo-500"
          title="Paste from clipboard"
        >
          <PasteIcon />
        </button>
      </div>
      {bad && <p className="text-[11px] text-red-400">Invalid format: expected a 42-character 0x… address</p>}
    </div>
  );
}
function PasteIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
      <path d="M8 2a2 2 0 0 0-2 2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7v-2H5V6h1v1h6V6h1v3h2V6a2 2 0 0 0-2-2h-1a2 2 0 0 0-2-2H8Zm2 3H8V4h2v1Z" />
      <path d="M21 12h-6l2.293-2.293-1.414-1.414L11.172 12l4.707 4.707 1.414-1.414L15 13h6v-2Z" />
    </svg>
  );
}

// ---------- Decorative BG ----------
function ColorfulMesh() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 opacity-40 bg-[conic-gradient(at_50%_15%,#3b82f6,#a78bfa,#f472b6,#22d3ee,#3b82f6)]" />
      <div className="absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,rgba(255,255,255,0.10),transparent_60%)]" />
      <div className="absolute -top-32 -left-24 h-[36rem] w-[36rem] rounded-full bg-fuchsia-500/30 blur-3xl animate-[pulse_7s_ease-in-out_infinite]" />
      <div className="absolute -bottom-24 -right-24 h-[30rem] w-[30rem] rounded-full bg-cyan-400/25 blur-3xl animate-[pulse_8s_ease-in-out_infinite]" />
      <div className="absolute top-1/3 left-1/4 h-[26rem] w-[26rem] rounded-full bg-amber-300/20 blur-3xl animate-[pulse_9s_ease-in-out_infinite]" />
      <div className="absolute inset-0 opacity-[0.07] bg-[linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] bg-[size:44px_44px]" />
    </div>
  );
}

function CenterLogo({ src = "/tokenization-dapp/vite.svg" }) {
  return (
    <div aria-hidden className="pointer-events-none select-none fixed inset-0 z-0 grid place-items-center">
      <div
        className="opacity-25"
        style={{
          width: "min(65vw, 650px)",
          height: "min(65vw, 650px)",
          backgroundImage: `url(${src})`,
          backgroundSize: "contain",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center",
          WebkitMaskImage: "radial-gradient(closest-side, rgba(0,0,0,1) 88%, rgba(0,0,0,0) 100%)",
          maskImage: "radial-gradient(closest-side, rgba(0,0,0,1) 88%, rgba(0,0,0,0) 100%)",
          filter: "contrast(1.06) brightness(1.08)",
        }}
      />
    </div>
  );
}

function BrandMark({ size = 88, variant = "market", layoutId = "brandmark" }) {
  const Icon =
    variant === "registry" ? ScrollText : variant === "maker" ? Hammer : variant === "compliance" ? ShieldCheck : Landmark;

  return (
    <motion.div
      layoutId={layoutId}
      className="relative"
      style={{ width: size, height: size, overflow: "visible" }}
      initial={{ rotate: -2, scale: 0.96, opacity: 0.98 }}
      animate={{ rotate: 0, scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 220, damping: 18 }}
    >
      <div
        aria-hidden
        className="absolute inset-0 -z-10 rounded-[22%] blur-2xl"
        style={{ background: "radial-gradient(60% 60% at 50% 50%, rgba(167,139,250,0.22), transparent 70%)" }}
      />

      <motion.svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        className="block"
        style={{ overflow: "visible" }}
        role="img"
        aria-label="dApp Brand"
      >
        <defs>
          <linearGradient id="ringA" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#60a5fa" />
            <stop offset="50%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#22d3ee" />
          </linearGradient>
          <linearGradient id="ringB" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="50%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#60a5fa" />
          </linearGradient>
          <radialGradient id="glass" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.16)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.0)" />
          </radialGradient>
        </defs>

        <motion.g
          style={{ originX: "50px", originY: "50px" }}
          animate={{ rotate: 360 }}
          transition={{ duration: 48, repeat: Infinity, ease: "linear" }}
        >
          <circle cx="50" cy="50" r="46" fill="none" stroke="url(#ringA)" strokeWidth="3.8" />
          <OrbitDot r={46} angle={10} dur={54} size={3.2} />
          <OrbitDot r={46} angle={140} dur={60} size={2.6} />
          <OrbitDot r={46} angle={265} dur={66} size={2.8} />
        </motion.g>

        <motion.g
          style={{ originX: "50px", originY: "50px" }}
          animate={{ rotate: -360 }}
          transition={{ duration: 32, repeat: Infinity, ease: "linear" }}
        >
          <circle cx="50" cy="50" r="36" fill="none" stroke="url(#ringB)" strokeWidth="3.2" opacity="0.9" />
        </motion.g>

        <circle cx="50" cy="50" r="28" fill="rgba(0,0,0,0.28)" stroke="rgba(255,255,255,0.14)" strokeWidth="1" />
        <circle cx="50" cy="50" r="28" fill="url(#glass)" />

        <Spark r={22} angle={30} dur={22} />
        <Spark r={22} angle={170} dur={27} />
        <Spark r={22} angle={290} dur={33} />
      </motion.svg>

      <motion.div
        className="absolute left-1/3 top-1/4 -translate-x-1/6 -translate-y-1/2 text-white"
        initial={{ scale: 3.5, rotate: -8, opacity: 0.95 }}
        animate={{ scale: 1.58, rotate: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 16, delay: 0.05 }}
        style={{ filter: "drop-shadow(0 4px 10px rgba(0,0,0,.35))" }}
      >
        <Icon className="w-[46px] h-[46px]" style={{ width: size * 0.4, height: size * 0.46 }} />
      </motion.div>

      <motion.div
        className="absolute grid place-items-center rounded-xl border text-white"
        style={{
          width: size * 0.24,
          height: size * 0.24,
          right: -size * 0.0,
          bottom: size * 0.10,
          background: "linear-gradient(180deg, rgba(16,185,129,0.95), rgba(16,185,129,0.82))",
          borderColor: "rgba(16,185,129,0.35)",
          boxShadow: "0 6px 20px rgba(16,185,129,0.35)",
        }}
        initial={{ scale: 4, rotate: -16, opacity: 0 }}
        animate={{ scale: 2, rotate: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 16, delay: 2 }}
      >
        <BadgeCheck style={{ width: size * 0.2, height: size * 0.2 }} />
      </motion.div>
    </motion.div>
  );
}

/* Helpers */
function OrbitDot({ r, angle = 0, dur = 56, size = 3 }) {
  return (
    <motion.g
      initial={{ rotate: angle }}
      animate={{ rotate: angle + 360 }}
      transition={{ duration: dur, repeat: Infinity, ease: "linear" }}
      style={{ originX: "50px", originY: "50px" }}
    >
      <circle cx={50 + r} cy="50" r={size / 2} fill="white" opacity="0.95" />
      <circle cx={50 + r} cy="50" r={size} fill="none" stroke="white" strokeWidth="0.5" opacity="0.35" />
    </motion.g>
  );
}
function Spark({ r = 22, angle = 0, dur = 24 }) {
  return (
    <motion.g
      initial={{ rotate: angle }}
      animate={{ rotate: angle + 360 }}
      transition={{ duration: dur, repeat: Infinity, ease: "linear" }}
      style={{ originX: "50px", originY: "50px" }}
    >
      <circle cx={50 + r} cy="50" r="1.6" fill="white" />
      <circle cx={50 + r} cy="50" r="3.6" fill="none" stroke="white" strokeWidth="0.6" opacity="0.45" />
    </motion.g>
  );
}

// ---------- App ----------
export default function App() {
  const [provider, setProvider] = useState(null);
  const [signerAddress, setSignerAddress] = useState("");
  const [chainId, setChainId] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [page, setPage] = useState("home");
  const [err, setErr] = useState("");
  const { flash, show } = useFlash();

  const [cfg, setCfg] = useLocal("contractsCfg.pretty", defaultCfgFromEnv());
  const [form, setForm] = useState(cfg);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentInput, setAgentInput] = useState("");
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentAllowWrite, setAgentAllowWrite] = useState(false);
  const [agentSpeedMode, setAgentSpeedMode] = useState("fast");
  const [agentMessages, setAgentMessages] = useState(loadAgentMessages);
  const [agentProvider, setAgentProvider] = useState("pending");
  const [agentSessionId, setAgentSessionId] = useState(() => {
    try {
      return localStorage.getItem(AGENT_SESSION_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  });
  const agentLogRef = useRef(null);
  const agentApiBase = useMemo(() => getAgentApiBase(), []);

  useEffect(() => setForm(cfg), [cfg]);

  useEffect(() => {
    try {
      localStorage.setItem(AGENT_MESSAGES_STORAGE_KEY, JSON.stringify(agentMessages.slice(-30)));
    } catch {}
  }, [agentMessages]);

  useEffect(() => {
    try {
      if (agentSessionId) localStorage.setItem(AGENT_SESSION_STORAGE_KEY, agentSessionId);
      else localStorage.removeItem(AGENT_SESSION_STORAGE_KEY);
    } catch {}
  }, [agentSessionId]);

  useEffect(() => {
    if (!agentLogRef.current) return;
    agentLogRef.current.scrollTop = agentLogRef.current.scrollHeight;
  }, [agentMessages, agentLoading, agentOpen]);

  useEffect(() => {
    let active = true;
    api
      .health()
      .then((payload) => {
        if (!active) return;
        setAgentProvider(String(payload?.provider || "unknown"));
      })
      .catch(() => {
        if (!active) return;
        setAgentProvider("offline");
      });
    return () => {
      active = false;
    };
  }, []);

  const wrongNetwork = useMemo(() => {
    if (!signerAddress || !chainId) return false;
    if (!cfg?.chainId) return false;
    return Number(chainId) !== Number(cfg.chainId);
  }, [signerAddress, chainId, cfg?.chainId]);

  const autofillFromEnv = () => {
    const fromEnv = defaultCfgFromEnv();
    setForm(fromEnv);
    show("Addresses loaded from .env");
  };
  const saveCfg = () => {
    // normalizza numeri (evita stringhe)
    const cleaned = {
      ...form,
      chainId: Number(form.chainId ?? 0) || 0,
      marketDeployBlock: Number(form.marketDeployBlock ?? 0) || 0,
    };
    setCfg(cleaned);
    show("Configuration saved");
  };

  // Connect / Disconnect
  const connect = async () => {
    setErr("");
    try {
      setConnecting(true);
      const mm = getMetaMask();
      await mm.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      const accs = await mm.request({ method: "eth_requestAccounts" });
      const addr = accs[0] ? getAddress(accs[0]) : "";
      const prov = new BrowserProvider(mm);
      const net = await prov.getNetwork();
      setProvider(prov);
      setSignerAddress(addr);
      setChainId(Number(net.chainId));
      show("Wallet connected");
    } catch (e) {
      setErr(e?.shortMessage || e?.message || String(e));
      show("Failed connection", "err");
    } finally {
      setConnecting(false);
    }
  };
  const disconnect = async () => {
    setErr("");
    try {
      const mm = getMetaMask();
      await mm.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {}
    setProvider(null);
    setSignerAddress("");
    setChainId(null);
    show("Disconnected");
  };

  // Wallet listeners
  useEffect(() => {
    let mm = null;
    try {
      mm = getMetaMask();
    } catch {
      mm = null;
    }
    if (!mm) return;
    const onAccounts = async (accs) => {
      const next = accs?.[0]
        ? (() => {
            try {
              return getAddress(accs[0]);
            } catch {
              return accs[0];
            }
          })()
        : "";
      try {
        setProvider(new BrowserProvider(mm));
        setSignerAddress(next || "");
      } catch {}
    };
    const onChain = () => window.location.reload();
    mm.on?.("accountsChanged", onAccounts);
    mm.on?.("chainChanged", onChain);
    return () => {
      mm?.removeListener?.("accountsChanged", onAccounts);
      mm?.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const nav = [
    ["compliance", "Compliance", ShieldCheck],
    ["custodian", "Custodian", Banknote],
    ["admin", "Admin", Settings],
    ["maker", "Maker", Hammer],
    ["distributor", "Distributor", Handshake],
    ["investor", "Investor", Users],
    ["registry", "Registry", ScrollText],
    ["home", "Home", HomeIcon],
  ];

  const submitAgentMessage = async (event) => {
    event.preventDefault();
    const rawMessage = agentInput.trim();
    if (!rawMessage || agentLoading) return;

    setAgentMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: rawMessage,
      },
    ]);
    setAgentInput("");
    setAgentOpen(true);

    const workspaceContext = [
      `Current page: ${page}`,
      `Connected wallet: ${signerAddress || "not connected"}`,
      `Current chainId: ${chainId ?? "unknown"}`,
      `Expected chainId: ${cfg?.chainId ?? "unknown"}`,
      `Market: ${cfg?.market || "unset"}`,
      `Stable: ${cfg?.stable || "unset"}`,
      `Oracle: ${cfg?.oracle || "unset"}`,
      `Registry: ${cfg?.registry || "unset"}`,
      `Factory: ${cfg?.factory || "unset"}`,
    ].join("\n");

    setAgentLoading(true);
    try {
      const payload = await api.chatWorkspaceAgent({
        sessionId: agentSessionId || undefined,
        allowWrite: agentAllowWrite,
        model: agentSpeedMode,
        message: `Workspace context:\n${workspaceContext}\n\nUser request:\n${rawMessage}`,
      });
      const nextSessionId =
        payload?.sessionId ||
        payload?.session?.id ||
        payload?.response?.sessionId ||
        payload?.history?.sessionId ||
        "";
      const assistantContent =
        payload?.message ||
        payload?.response?.message ||
        payload?.reply ||
        payload?.history?.messages?.at?.(-1)?.content ||
        "Risposta ricevuta dal workspace agent.";

      if (nextSessionId) setAgentSessionId(nextSessionId);
      if (payload?.provider) setAgentProvider(String(payload.provider));

      setAgentMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: assistantContent,
        },
      ]);
    } catch (error) {
      const reason = error?.message || String(error);
      setAgentMessages((prev) => [
        ...prev,
        {
          id: `assistant-error-${Date.now()}`,
          role: "assistant",
          content:
            "OpenClaw backend is unreachable. Configure `VITE_AGENT_API_BASE` to point to a service exposing `POST /ai/workspace-agent/chat`, or serve the dApp behind the same host as the backend.\n\nDetail: " +
            reason,
        },
      ]);
    } finally {
      setAgentLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-gradient-to-br from-indigo-950 via-neutral-950 to-fuchsia-950 text-neutral-100">
      <ColorfulMesh />
      <CenterLogo src="/tokenization-dapp/logo.png" />
      <FlashToaster flash={flash} />

      <div className="mx-auto w-full max-w-7xl p-6 md:p-10 space-y-10">
        {/* Header */}
        <Card className="border-white/20 bg-white/10 backdrop-blur shadow-xl shadow-black/20">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <BrandMark variant="market" size={56} />
                <div>
                  <div className="text-lg font-semibold">dApp • Compliance Platform</div>
                  <div className="text-xs text-neutral-400">Inventory / KYC / Oracles</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Chip
                  label="Chain"
                  value={
                    chainId ? `${CHAIN_NAMES[chainId] || "Chain"} (${String(chainId)})` : "—"
                  }
                  bad={wrongNetwork}
                />
                {signerAddress ? (
                  <div className="flex items-center gap-2">
                    <div className="px-3 py-1 rounded-xl text-xs border bg-neutral-900/60 border-neutral-700 text-neutral-300 flex items-center gap-2">
                      <StatusDot on={!!signerAddress} />
                      <Wallet className="h-3.5 w-3.5" />
                      <Copyable text={signerAddress} />
                    </div>
                    <Button
                      onClick={disconnect}
                      variant="secondary"
                      className="rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-red-500"
                    >
                      <PlugZap className="mr-2 h-4 w-4" /> log out
                    </Button>
                  </div>
                ) : (
                  <Button onClick={connect} disabled={connecting} className="rounded-xl bg-indigo-600 hover:bg-indigo-500">
                    {connecting ? (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Connecting…
                      </>
                    ) : (
                      <>
                        <Wallet className="mr-2 h-4 w-4" /> Connect MetaMask
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>

            {wrongNetwork && (
              <div className="mt-3">
                <Alert className="bg-amber-900/20 border-amber-700 text-amber-100">
                  <AlertDescription className="flex items-start gap-3 text-sm">
                    <AlertTriangle className="h-4 w-4 mt-0.5" />
                    <div>
                      Sei connesso alla chain <b>{chainId}</b>, ma la dApp è configurata per <b>{cfg.chainId}</b>.
                      Cambia network in MetaMask oppure aggiorna <code>VITE_CHAIN_ID</code>.
                    </div>
                  </AlertDescription>
                </Alert>
              </div>
            )}
          </CardContent>
        </Card>

        <ErrorBanner msg={err} onClose={() => setErr("")} />

        {/* Contracts Card */}
        <Card className="border-white/20 bg-white/10 backdrop-blur shadow-xl shadow-black/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">Contracts</CardTitle>
            <CardDescription>Configure contract addresses used in the dApp.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pt-4 border-t border-white/10">
            <div className="flex flex-wrap items-center gap-2 justify-between">
              <div className="text-sm text-neutral-400">Suggestion: save in localStorage and use Auto-fill from .env</div>
              <div className="flex gap-2">
                <Button
                  onClick={autofillFromEnv}
                  variant="secondary"
                  className="rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 text-xs"
                >
                  <RefreshCw className="mr-2 h-3.5 w-3.5" /> Auto-fill from .env
                </Button>
                <Button onClick={saveCfg} className="rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs">
                  <SaveIcon className="mr-2 h-3.5 w-3.5" /> Save
                </Button>
              </div>
            </div>

            {/* chain + events */}
            <div className="rounded-xl border border-white/15 bg-black/20 p-4 md:p-5">
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5 text-sm">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-neutral-300">Expected Chain ID</label>
                  <Input
                    type="number"
                    value={String(form.chainId ?? "")}
                    onChange={(e) => setForm((s) => ({ ...s, chainId: Number(e.target.value) }))}
                    placeholder="11155111"
                  />
                  <p className="text-[11px] text-neutral-400">Used for the “wrong network” warning.</p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-neutral-300">Market Deploy Block</label>
                  <Input
                    type="number"
                    value={String(form.marketDeployBlock ?? "")}
                    onChange={(e) => setForm((s) => ({ ...s, marketDeployBlock: Number(e.target.value) }))}
                    placeholder="0"
                  />
                  <p className="text-[11px] text-neutral-400">FromBlock per scan eventi (EventRegistry).</p>
                </div>

                <div className="hidden lg:block" />
              </div>
            </div>

            {/* addresses */}
            <div className="rounded-xl border border-white/15 bg-black/20 p-4 md:p-5">
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5 text-sm">
                {[
                  ["market", "Market"],
                  ["stable", "Stable Token (proxy)"],
                  ["fund", "Fund Token (proxy)"],
                  ["oracle", "Oracle"],
                  ["registry", "Compliance Registry (proxy)"],
                  ["factory", "SecurityTokenBeaconFactory (NEW)"],
                ].map(([k, label]) => (
                  <AddressInput key={k} label={label} value={form[k]} onChange={(v) => setForm((s) => ({ ...s, [k]: v }))} />
                ))}
              </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <Chip label="Expected Chain" value={String(form.chainId ?? "—")} bad={!!form.chainId && !Number.isFinite(Number(form.chainId))} />
              <Chip label="Deploy Block" value={String(form.marketDeployBlock ?? "—")} bad={!!form.marketDeployBlock && !Number.isFinite(Number(form.marketDeployBlock))} />

              <Chip label="Market" value={short(form.market)} bad={!!form.market && !isHexAddr(form.market)} />
              <Chip label="Stable" value={short(form.stable)} bad={!!form.stable && !isHexAddr(form.stable)} />
              <Chip label="Oracle" value={short(form.oracle)} bad={!!form.oracle && !isHexAddr(form.oracle)} />
              <Chip label="Registry" value={short(form.registry)} bad={!!form.registry && !isHexAddr(form.registry)} />
              <Chip label="Factory" value={short(form.factory)} bad={!!form.factory && !isHexAddr(form.factory)} />
              <Chip label="Fund" value={short(form.fund)} bad={!!form.fund && !isHexAddr(form.fund)} />
            </div>
          </CardContent>
        </Card>

        {/* Tabs / Nav */}
        <nav className="relative">
          <div className="flex flex-wrap justify-center gap-2">
            {nav.map(([k, label, Icon]) => (
              <motion.button
                key={k}
                onClick={() => setPage(k)}
                className={`group relative overflow-hidden px-3 py-2 rounded-xl border transition ${
                  page === k ? "bg-indigo-600/90 border-indigo-600" : "bg-white/5 border-white/10 hover:border-indigo-500"
                }`}
                whileTap={{ scale: 0.98 }}
              >
                <div className="flex items-center gap-2 text-sm">
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                </div>
                {page === k && (
                  <motion.span
                    layoutId="tabGlow"
                    className="pointer-events-none absolute inset-0 rounded-xl bg-white/10"
                    initial={false}
                    transition={{ type: "spring", stiffness: 250, damping: 24 }}
                  />
                )}
              </motion.button>
            ))}
          </div>
        </nav>

        {/* Pages */}
        <AnimatePresence mode="wait">
          <motion.div key={page} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            {(() => {
              switch (page) {
                case "compliance":
                  return (
                    <PagePanel title="Compliance" subtitle="Whitelist/KYC and Compliance Gate">
                      <CompliancePage
                        provider={provider}
                        account={signerAddress}
                        registryAddress={cfg.registry}
                        complianceGateAddress={cfg.stable}
                        expectedChainId={cfg.chainId}
                        onError={(m) => setErr(m)}
                      />
                    </PagePanel>
                  );

                case "custodian":
                  console.log("=== PARENT DEBUG DepositaryPage (custodian) ===");
                  console.log("cfg:", cfg);
                  console.log("cfg.market:", cfg.market);
                  console.log("cfg.stable:", cfg.stable);
                  console.log("cfg.oracle:", cfg.oracle);

                  console.log("cfg.fund:", cfg.fund);
                  console.log("form.fund:", form.fund);
                  console.log("env fund:", import.meta.env.VITE_FUND_ADDRESS);

                  console.log("passing stableAddress:", cfg.stable);
                  console.log("=============================================");

                  return (
                    <PagePanel title="Custodian" subtitle="Authorize Mint/Burn Permissions">
                      <DepositaryPage
                        provider={provider}
                        account={signerAddress}
                        marketAddress={cfg.market}
                        stableAddress={cfg.stable}
                        fundsAddress={cfg.fund}
                        oracleAddress={cfg.oracle}
                        expectedChainId={cfg.chainId}
                        marketDeployBlock={cfg.marketDeployBlock}
                        onError={(m) => setErr(m)}
                      />
                    </PagePanel>
                  );


                case "admin":
                  return (
                    <PagePanel title="Admin" subtitle="Admin oracle permission">
                      <AdminPage
                        provider={provider}
                        account={signerAddress}
                        fundAddress={cfg.fund}
                        onError={(m) => setErr(m)}
                      />
                    </PagePanel>
                  );

                case "maker":
                  return (
                    <PagePanel title="Maker" subtitle="Operations market/stable">
                      <MakerPage
                        provider={provider}
                        account={signerAddress}
                        marketAddress={cfg.market}
                        stableAddress={cfg.stable}
                        expectedChainId={cfg.chainId}
                        onError={(m) => setErr(m)}
                      />
                    </PagePanel>
                  );

                case "distributor":
                  return (
                    <PagePanel title="Distributor" subtitle="Distribution assets between custodian and investor">
                      <DistributorPage
                        provider={provider}
                        account={signerAddress}
                        marketAddress={cfg.market}
                        stableAddress={cfg.stable}
                        expectedChainId={cfg.chainId}
                        onError={(m) => setErr(m)}
                      />
                    </PagePanel>
                  );

                case "investor":
                  return (
                    <PagePanel title="Investor" subtitle="Interact with Assets">
                      <InvestorPage
                        provider={provider}
                        account={signerAddress}
                        marketAddress={cfg.market}
                        stableAddress={cfg.stable}
                        oracleAddress={cfg.oracle}
                        registryAddress={cfg.registry}
                        complianceGateAddress={cfg.stable}
                        expectedChainId={cfg.chainId}
                        marketDeployBlock={cfg.marketDeployBlock}
                        onError={(m) => setErr(m)}
                      />
                    </PagePanel>
                  );

                case "registry":
                  return (
                    <PagePanel title="Registry" subtitle="All platform txs in blockchain">
                      <EventRegistryPage
                        provider={provider}
                        account={signerAddress}
                        marketAddress={cfg.market}
                        stableAddress={cfg.stable}
                        registryAddress={cfg.registry}
                        expectedChainId={cfg.chainId}
                        marketDeployBlock={cfg.marketDeployBlock}
                        onError={(m) => setErr(m)}
                      />
                    </PagePanel>
                  );

                default:
                  return (
                    <Card className="relative overflow-hidden border-white/20 bg-white/10 backdrop-blur shadow-xl">
                      <div className="pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full bg-gradient-to-br from-indigo-500/40 via-fuchsia-500/30 to-cyan-400/30 blur-2xl" />
                      <CardContent className="relative p-6 md:p-8 space-y-6">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <CardTitle className="text-xl md:text-2xl bg-clip-text text-transparent bg-gradient-to-r from-indigo-300 via-fuchsia-300 to-cyan-300">
                              Welcome to the Compliance Platform dApp
                            </CardTitle>
                            <p className="mt-1.5 text-sm text-neutral-300">
                              A unified interface to manage compliance, inventories, and on-chain trading flows.
                            </p>
                          </div>
                          <div className="hidden md:block px-3 py-1 rounded-full text-[11px] border border-white/15 bg-black/20">
                            Demo • read the steps below
                          </div>
                        </div>

                        <ul className="grid sm:grid-cols-2 gap-3 text-sm">
                          <motion.li
                            whileHover={{ y: -2, scale: 1.01 }}
                            className="group flex items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-indigo-500/60"
                          >
                            <span className="mt-0.5 h-7 w-7 shrink-0 grid place-items-center rounded-lg bg-indigo-600/80">
                              <Wallet className="h-4 w-4 text-white" />
                            </span>
                            <div className="space-y-0.5">
                              <b className="text-neutral-100">Connect your wallet</b>
                              <p className="text-neutral-400">Use MetaMask to sign and unlock role-gated actions.</p>
                            </div>
                          </motion.li>

                          <motion.li
                            whileHover={{ y: -2, scale: 1.01 }}
                            className="group flex items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-fuchsia-500/60"
                          >
                            <span className="mt-0.5 h-7 w-7 shrink-0 grid place-items-center rounded-lg bg-fuchsia-600/80">
                              <Settings className="h-4 w-4 text-white" />
                            </span>
                            <div className="space-y-0.5">
                              <b className="text-neutral-100">Set contract addresses</b>
                              <p className="text-neutral-400">
                                Fill <code>Market</code>, <code>Stable</code>, <code>Oracle</code>, <code>Registry</code>, <code>Factory</code> — or use Auto-fill from <code>.env</code>.
                              </p>
                            </div>
                          </motion.li>

                          <motion.li
                            whileHover={{ y: -2, scale: 1.01 }}
                            className="group flex items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-emerald-500/60"
                          >
                            <span className="mt-0.5 h-7 w-7 shrink-0 grid place-items-center rounded-lg bg-emerald-600/80">
                              <ShieldCheck className="h-4 w-4 text-white" />
                            </span>
                            <div className="space-y-0.5">
                              <b className="text-neutral-100">Compliance</b>
                              <p className="text-neutral-400">
                                Whitelist/KYC via Registry & token gate; enforce <code>Custodian Role</code> where required.
                              </p>
                            </div>
                          </motion.li>

                          <motion.li
                            whileHover={{ y: -2, scale: 1.01 }}
                            className="group flex items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-cyan-500/60"
                          >
                            <span className="mt-0.5 h-7 w-7 shrink-0 grid place-items-center rounded-lg bg-cyan-600/80">
                              <Banknote className="h-4 w-4 text-white" />
                            </span>
                            <div className="space-y-0.5">
                              <b className="text-neutral-100">Custodian & Inventory</b>
                              <p className="text-neutral-400">Approve mint/burn proposals; run inventory mint/burn across listed assets.</p>
                            </div>
                          </motion.li>

                          <motion.li
                            whileHover={{ y: -2, scale: 1.01 }}
                            className="group flex items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-amber-500/60"
                          >
                            <span className="mt-0.5 h-7 w-7 shrink-0 grid place-items-center rounded-lg bg-amber-500/80">
                              <Hammer className="h-4 w-4 text-white" />
                            </span>
                            <div className="space-y-0.5">
                              <b className="text-neutral-100">Admin & Maker</b>
                              <p className="text-neutral-400">Manage oracle, maker inventory, and platform actions.</p>
                            </div>
                          </motion.li>

                          <motion.li
                            whileHover={{ y: -2, scale: 1.01 }}
                            className="group flex items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-rose-500/60"
                          >
                            <span className="mt-0.5 h-7 w-7 shrink-0 grid place-items-center rounded-lg bg-rose-600/80">
                              <Users className="h-4 w-4 text-white" />
                            </span>
                            <div className="space-y-0.5">
                              <b className="text-neutral-100">Investor</b>
                              <p className="text-neutral-400">Buy/Sell listed assets and track positions.</p>
                            </div>
                          </motion.li>
                        </ul>
                      </CardContent>
                    </Card>
                  );
              }
            })()}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="fixed bottom-4 left-4 right-4 z-50 flex flex-col items-end gap-3 sm:bottom-5 sm:left-auto sm:right-5">
        <AnimatePresence>
          {agentOpen ? (
            <motion.aside
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.98 }}
              className="flex h-[min(78vh,42rem)] w-full max-w-[24rem] flex-col overflow-hidden rounded-3xl border border-white/15 bg-neutral-950/95 shadow-2xl backdrop-blur-xl"
            >
              <div className="border-b border-white/10 bg-gradient-to-r from-cyan-500/15 via-indigo-500/15 to-emerald-500/15 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-white">
                      <Bot className="h-4 w-4 text-cyan-300" />
                      <span>Workspace Agent</span>
                    </div>
                    <p className="mt-1 text-xs text-neutral-300">
                      Support for the dApp, Solidity contracts, local setup, and operational flows.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAgentOpen(false)}
                    className="rounded-full border border-white/10 bg-white/5 p-2 text-neutral-300 transition hover:border-white/20 hover:text-white"
                    aria-label="Close workspace agent"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-neutral-400">
                  <div className="flex items-center gap-2 overflow-hidden">
                    <span className="truncate">API: {agentApiBase}</span>
                    <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-neutral-300">
                      {agentProvider}
                    </span>
                  </div>
                  <label className="flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2 py-1">
                    <input
                      type="checkbox"
                      checked={agentAllowWrite}
                      onChange={(event) => setAgentAllowWrite(event.target.checked)}
                      className="h-3.5 w-3.5 accent-cyan-400"
                    />
                    <span>Allow write</span>
                  </label>
                </div>
              </div>

              <div ref={agentLogRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                {agentMessages.map((entry) => (
                  <article
                    key={entry.id}
                    className={`max-w-[92%] rounded-2xl border px-3 py-2 text-sm shadow-sm ${
                      entry.role === "user"
                        ? "ml-auto border-cyan-400/30 bg-cyan-500/15 text-cyan-50"
                        : "border-white/10 bg-white/5 text-neutral-100"
                    }`}
                  >
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
                      {entry.role === "user" ? "You" : "Agent"}
                    </div>
                    <p className="whitespace-pre-wrap break-words leading-6">{entry.content}</p>
                  </article>
                ))}

                {agentLoading ? (
                  <article className="max-w-[92%] rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-100 shadow-sm">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">Agent</div>
                    <div className="flex items-center gap-2 text-neutral-300">
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      <span>Working on your request...</span>
                    </div>
                  </article>
                ) : null}
              </div>

              <form onSubmit={submitAgentMessage} className="border-t border-white/10 bg-black/20 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="inline-flex rounded-full border border-white/10 bg-white/5 p-1">
                    <button
                      type="button"
                      onClick={() => setAgentSpeedMode("fast")}
                      className={`rounded-full px-3 py-1 text-xs transition ${
                        agentSpeedMode === "fast" ? "bg-cyan-400 text-neutral-950" : "text-neutral-300 hover:text-white"
                      }`}
                    >
                      Fast
                    </button>
                    <button
                      type="button"
                      onClick={() => setAgentSpeedMode("smart")}
                      className={`rounded-full px-3 py-1 text-xs transition ${
                        agentSpeedMode === "smart" ? "bg-cyan-400 text-neutral-950" : "text-neutral-300 hover:text-white"
                      }`}
                    >
                      Smart
                    </button>
                  </div>
                  <div className="text-[11px] text-neutral-400">
                    {agentSpeedMode === "fast" ? "Ultra low latency" : "Better reasoning"}
                  </div>
                </div>
                <textarea
                  value={agentInput}
                  onChange={(event) => setAgentInput(event.target.value)}
                  placeholder="Ask how to use the dApp, run an operational flow, or modify contracts and frontend..."
                  rows={4}
                  className="min-h-[6.5rem] w-full resize-none rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-500 focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="text-[11px] text-neutral-400">
                    Session {agentSessionId ? short(agentSessionId) : "new"} · page {page}
                  </div>
                  <Button type="submit" className="bg-cyan-500 text-neutral-950 hover:bg-cyan-400" disabled={agentLoading || !agentInput.trim()}>
                    <Send className="h-4 w-4" />
                    <span>Send</span>
                  </Button>
                </div>
              </form>
            </motion.aside>
          ) : null}
        </AnimatePresence>

        <button
          type="button"
          onClick={() => setAgentOpen((prev) => !prev)}
          aria-label={agentOpen ? "Close workspace agent" : "Open workspace agent"}
          className="group flex h-14 w-14 items-center justify-center rounded-full border border-cyan-300/30 bg-gradient-to-br from-cyan-400 via-sky-500 to-indigo-600 text-white shadow-[0_18px_40px_rgba(14,165,233,0.35)] transition hover:scale-[1.03] hover:shadow-[0_24px_52px_rgba(14,165,233,0.45)]"
        >
          <MessageCircle className="h-6 w-6 transition group-hover:scale-110" />
        </button>
      </div>
    </div>
  );
}
