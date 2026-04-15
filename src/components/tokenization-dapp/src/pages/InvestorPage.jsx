import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Contract, ethers } from "ethers";
import Chart from "chart.js/auto";

/* ───────────────────────── ABIs ───────────────────────── */
const MARKET_ABI = [
  "function getAllAssetIds() view returns (bytes32[])",
  "function fullInventory() view returns (address[] makers,uint256[] makerStable, bytes32[] assetIds, uint256[][] balances)",
  "function assets(bytes32) view returns (address token,string symbolText,uint8 tokenDecimals,bool listed,uint256 minBuyAmount)",
  "function tokenAddress(bytes32) view returns (address)",

  // makers discovery (AccessControlEnumerable)
  "function INVENTORY_ROLE() view returns (bytes32)",
  "function getRoleMemberCount(bytes32) view returns (uint256)",
  "function getRoleMember(bytes32,uint256) view returns (address)",

  "function quoteBuyFrom(bytes32,uint256) view returns (uint256 total,uint256 cost,uint256 fee,uint256 extra)",
  "function quoteSellTo(bytes32,uint256) view returns (uint256 payout,uint256 proceeds,uint256 fee,uint256 extra)",
  "function buyFrom(address,bytes32,uint256,uint256)",
  "function sellTo(address,bytes32,uint256,uint256)",

  "function invStable(address) view returns (uint256)",
  "function invAsset(address,bytes32) view returns (uint256)",

  "event AssetListed(bytes32 indexed id, address token, string symbol)"
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)"
];

const FACTORY_ABI = [
  "function predictWallet(address owner) view returns (address)"
];

const PROXY_WALLET_READ_ABI = [
  "function nonce() view returns (uint256)"
];

const ERC20_PERMIT_READ_ABI = [
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)"
];

const ORACLE_ABI = [
  "function decimals() view returns (uint8)",
  "function getReference(bytes32) view returns (uint256 value, uint256 ts)",
  "event ReferenceUpdated(bytes32 indexed id, uint256 value, uint64 ts)"
];

const REGISTRY_ABI = [
  "function isWhitelisted(address) view returns (bool)",
  "function getKycExpiry(address) view returns (uint256)",
  "function kycexpiry(address) view returns (uint256)"
];

/* ─────────────────────── Helpers ─────────────────────── */
const fmt = (v, dec = 18) => {
  try {
    return ethers.formatUnits(v, dec);
  } catch {
    return String(v);
  }
};

async function waitForReceipt(provider, txHash, opts) {
  const pollMs = opts?.pollMs ?? 800;
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const start = Date.now();
  while (true) {
    const r = await provider.getTransactionReceipt(txHash);
    if (r) return r;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timeout waiting for receipt. txHash=${txHash}.`
      );
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

async function assertSameChain(provider, relayerUrl) {
  const [net, rel] = await Promise.all([
    provider.getNetwork(),
    fetch(`${relayerUrl}/relayerStatus`)
      .then((r) => r.json())
      .catch(() => null)
  ]);
  if (rel?.chainId != null) {
    const clientChainId = Number(net.chainId);
    const relayerChainId = Number(rel.chainId);
    if (clientChainId !== relayerChainId) {
      throw new Error(
        `ChainId mismatch: dApp=${clientChainId}, relayer=${relayerChainId}.`
      );
    }
  }
}

async function getPermitNoncePending(token, owner) {
  try {
    return BigInt(await token.nonces(owner, { blockTag: "pending" }));
  } catch {
    return BigInt(await token.nonces(owner));
  }
}

const STABLE_SENTINEL = "__STABLE__";
const assetSym = (a) => a?.symbol ?? "ASSET";
const assetDec = (a, fallback = 18) =>
  typeof a?.decimals === "number" ? a.decimals : fallback;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};

const TYPES = {
  Call: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" }
  ],
  Execute: [
    { name: "call", type: "Call" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "executor", type: "address" },
    { name: "feeToken", type: "address" },
    { name: "feeAmount", type: "uint256" },
    { name: "feeRecipient", type: "address" }
  ]
};

const walletDomain = (chainId, verifyingContract) => ({
  name: "ProxyWallet",
  version: "1",
  chainId,
  verifyingContract
});

const permitDomain = (chainId, tokenName, tokenAddress) => ({
  name: tokenName,
  version: "1",
  chainId,
  verifyingContract: tokenAddress
});

/* ───────────────── Yahoo helpers (historical only) ───────────────── */
const YAHOO_CACHE_TTL_MS = 60_000;
const _yahooCache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJsonWithFallbacks(url, { signal } = {}) {
  const proxies = [
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
    (u) => `https://cors.isomorphic-git.org/${u}`
  ];

  let lastErr = null;

  for (const build of proxies) {
    const proxUrl = build(url);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(proxUrl, {
          signal,
          headers: { accept: "application/json" }
        });

        if (r.status === 429) {
          await sleep(400 * Math.pow(2, attempt));
          continue;
        }

        if (!r.ok) throw new Error(`Proxy HTTP ${r.status}`);

        const j = await r.json();
        return j;
      } catch (e) {
        if (signal?.aborted) throw e;
        lastErr = e;
        await sleep(150 * Math.pow(2, attempt));
      }
    }
  }

  throw lastErr || new Error("All CORS proxies failed");
}

async function fetchSeries(sym, { signal } = {}) {
  const t = String(sym || "").trim().toUpperCase();
  if (!t) throw new Error("Ticker missing");

  const hit = _yahooCache.get(t);
  if (hit && Date.now() - hit.at < YAHOO_CACHE_TTL_MS) return hit.rows;

  const base = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    t
  )}`;

  const urls = [
    `${base}?range=1y&interval=1d`,
    `${base}?range=6mo&interval=1d`,
    `${base}?range=5y&interval=1d`
  ];

  let lastErr = null;

  for (const url of urls) {
    try {
      const j = await fetchJsonWithFallbacks(url, { signal });
      const res = j?.chart?.result?.[0];

      if (!res) {
        const msg = j?.chart?.error?.description || "Ticker not available";
        throw new Error(msg);
      }

      const timestamps = res.timestamp;
      const closes = res.indicators?.quote?.[0]?.close;

      if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
        throw new Error("Unavailable time-series for this ticker");
      }

      const rows = timestamps
        .map((sec, i) => ({
          date: new Date(sec * 1000).toISOString().slice(0, 10),
          close: closes[i]
        }))
        .filter((d) => d.close != null && Number.isFinite(d.close));

      if (!rows.length) throw new Error("Empty time-series");

      _yahooCache.set(t, { at: Date.now(), rows });
      return rows;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }

  throw lastErr || new Error("Yahoo series fetch failed");
}

function guessTickerFromAsset(asset) {
  if (!asset) return STABLE_SENTINEL;
  const sym = (asset.symbol || "").toUpperCase();
  if (/BTC|XBT/.test(sym)) return "BTC-USD";
  if (/ETH/.test(sym)) return "ETH-USD";
  if (sym.includes("-")) return sym;
  return `${sym}`;
}

/* ───────────────────── YahooChart (historical, with window) ───────────────────── */
function YahooChart({
  initialSymbol,
  labelOverride,
  className,
  windowKey = "1y"
}) {
  const [sym, setSym] = useState(initialSymbol);
  const [loading, setLoading] = useState(false);
  const [fullSeries, setFullSeries] = useState([]); // {date, close}[]
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const nf = useMemo(
    () => new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }),
    []
  );

  const destroyChart = () => {
    try {
      chartRef.current?.destroy();
    } catch {
      /* ignore */
    }
    chartRef.current = null;
  };

  const drawFromSeries = useCallback(
    (series) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      destroyChart();

      if (!series || !series.length) return;

      // window slicing
      const N_MAP = {
        "1d": 1,
        "7d": 7,
        "1m": 30,
        "3m": 90,
        "6m": 180,
        "1y": 365,
        max: Infinity
      };
      const key = windowKey || "1y";
      const n = N_MAP[key] ?? series.length;
      const useSeries =
        n >= series.length ? series : series.slice(series.length - n);

      const labels = useSeries.map((r) => r.date);
      const prices = useSeries.map((r) => r.close);

      const height = canvas.height || 300;
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "rgba(99,102,241,.25)");
      gradient.addColorStop(1, "rgba(99,102,241,0)");

      chartRef.current = new Chart(ctx, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: labelOverride ?? sym ?? "",
              data: prices,
              borderColor: "#4f46e5",
              backgroundColor: gradient,
              pointRadius: 0,
              tension: 0.25,
              fill: true
            }
          ]
        },
        options: {
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { maxTicksLimit: 10 } },
            y: {
              ticks: {
                callback: (v) => nf.format(v)
              }
            }
          }
        }
      });
    },
    [labelOverride, nf, sym, windowKey]
  );

  // Fetch full 1y series
  // dentro YahooChart
  const load = async (ticker, opts = {}) => {
    const { skipLoadingFlag } = opts;
    if (!ticker) return;

    if (!skipLoadingFlag) setLoading(true);
    let cancelled = false;

    try {
      if (!canvasRef.current) return;

      const makeStableRows = () => {
        const days = 365;
        const now = new Date();
        return Array.from({ length: days }, (_, i) => {
          const d = new Date(now);
          d.setDate(d.getDate() - (days - 1 - i));
          return {
            date: d.toISOString().slice(0, 10),
            close: 1
          };
        });
      };

      let rows;
      if (ticker === STABLE_SENTINEL) {
        rows = makeStableRows();
      } else {
        let usedFallback = false;
        try {
          rows = await fetchSeries(ticker);
        } catch (e) {
          // se il ticker non esiste, fallback a serie stabile (1)
          console.warn("Yahoo fetch failed, fallback to stable", e);
          rows = makeStableRows();
          usedFallback = true;
        }

        // ────────────────────────────────────────────────
        // Se il ticker è di Borsa Italiana (.MI), converto
        // i prezzi da EUR a USD usando l'ultimo EURUSD.
        // ────────────────────────────────────────────────
        if (!usedFallback && typeof ticker === "string" && ticker.endsWith(".MI")) {
          try {
            const fxSeries = await fetchSeries("EURUSD=X");
            if (fxSeries && fxSeries.length) {
              const lastFx = Number(
                fxSeries[fxSeries.length - 1].close
              );
              if (Number.isFinite(lastFx) && lastFx > 0) {
                rows = rows.map((r) => ({
                  ...r,
                  close: Number(r.close) * lastFx
                }));
              }
            }
          } catch (e) {
            // in caso di errore sul cambio, lascio i prezzi in EUR
            console.warn(
              "EURUSD conversion failed, using raw EUR prices",
              e
            );
          }
        }
        // ────────────────────────────────────────────────
      }

      if (cancelled) return;
      setFullSeries(rows);
    } catch (e) {
      if (!cancelled) alert(e?.message || String(e));
    } finally {
      if (!cancelled && !skipLoadingFlag) setLoading(false);
    }

    return () => {
      cancelled = true;
    };
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    const t = (sym || "").trim().toUpperCase();
    if (!t) return;
    setSym(t);
    await load(t);
  };

  // initial load
  useEffect(() => {
    if (!initialSymbol) return;
    setSym(initialSymbol);
    let cancel;
    (async () => {
      cancel = await load(initialSymbol);
    })();

    return () => {
      if (typeof cancel === "function") cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSymbol, labelOverride]);

  // redraw whenever series or window changes
  useEffect(() => {
    if (!fullSeries || !fullSeries.length) {
      destroyChart();
      return;
    }
    drawFromSeries(fullSeries);
  }, [fullSeries, drawFromSeries]);

  // cleanup
  useEffect(
    () => () => {
      destroyChart();
    },
    []
  );

  // Optional refetch trigger on visibility/focus
  useEffect(() => {
    const refetch = () => {
      if (sym && canvasRef.current) {
        load(sym, { skipLoadingFlag: true });
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") refetch();
    };
    window.addEventListener("focus", refetch);
    window.addEventListener("popstate", refetch);
    window.addEventListener("hashchange", refetch);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", refetch);
      window.removeEventListener("popstate", refetch);
      window.removeEventListener("hashchange", refetch);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [sym]);

  return (
    <div
      className={`p-4 rounded-2xl border border-white/10 bg-white/5 ${
        className || ""
      }`}
    >
      <form onSubmit={onSubmit} className="flex items-center gap-2 mb-3">
        <input
          value={sym || ""}
          onChange={(e) => setSym(e.target.value)}
          placeholder="Ticker (e.g. BTC-USD)"
          className="flex-1 px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
        />
        <button
          type="submit"
          className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500"
        >
          Set
        </button>
      </form>

      <div className="relative h-64 md:h-80">
        {loading && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="animate-spin h-6 w-6 border-2 border-white/40 border-t-transparent rounded-full" />
          </div>
        )}
        <canvas
          ref={canvasRef}
          className={`${loading ? "opacity-30" : "opacity-100"} transition-opacity`}
        />
      </div>

      <div className="mt-2 text-xs text-neutral-400">
        {initialSymbol === STABLE_SENTINEL
          ? "Synthetic data: constant function = 1."
          : "Historical price from Yahoo Finance (window selected above)."}
      </div>
    </div>
  );
}

/* ───────────────── OracleChart (history + live from events) ───────────────── */
/* Versione ottimizzata: riusa il grafico invece di ricrearlo ogni volta */
function OracleChart({ series, className }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const nf = useMemo(
    () => new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }),
    []
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Crea il grafico solo la prima volta
    if (!chartRef.current) {
      const height = canvas.height || 300;
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "rgba(34,197,94,.25)");
      gradient.addColorStop(1, "rgba(34,197,94,0)");

      chartRef.current = new Chart(ctx, {
        type: "line",
        data: {
          labels: [],
          datasets: [
            {
              label: "Reference price (on-chain)",
              data: [],
              borderColor: "#22c55e",
              backgroundColor: gradient,
              pointRadius: 0,
              tension: 0.25,
              fill: true
            }
          ]
        },
        options: {
          maintainAspectRatio: false,
          animation: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { maxTicksLimit: 8 } },
            y: {
              ticks: {
                callback: (v) => nf.format(v)
              }
            }
          }
        }
      });
    }

    const chart = chartRef.current;

    const labels = (series || []).map((pt) =>
      new Date(pt.ts * 1000).toLocaleTimeString()
    );
    const prices = (series || []).map((pt) => pt.price);

    chart.data.labels = labels;
    chart.data.datasets[0].data = prices;
    chart.update("none"); // nessuna animazione → più leggero
  }, [series, nf]);

  useEffect(
    () => () => {
      if (chartRef.current) {
        try {
          chartRef.current.destroy();
        } catch {
          /* ignore */
        }
        chartRef.current = null;
      }
    },
    []
  );

  const lastTs = series && series.length ? series[series.length - 1].ts : null;

  return (
    <div
      className={`p-4 rounded-2xl border border-white/10 bg-white/5 ${
        className || ""
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-neutral-300">
          Reference price (history + live)
        </div>
        <div className="text-xs text-neutral-400">
          {lastTs
            ? `Last update: ${new Date(lastTs * 1000).toLocaleTimeString()}`
            : "No ReferenceUpdated events for this asset yet."}
        </div>
      </div>

      <div className="relative h-64 md:h-80">
        <canvas ref={canvasRef} />
        {(!series || !series.length) && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-500">
            Waiting for on-chain ReferenceUpdated events...
          </div>
        )}
      </div>

      <div className="mt-2 text-xs text-neutral-400">
        Built from on-chain{" "}
        <code className="font-mono">
          ReferenceUpdated(bytes32 id, uint256 value, uint64 ts)
        </code>{" "}
        events of the ReferenceOracle contract.
      </div>
    </div>
  );
}

/* ───────────────────── InvestorPage ───────────────────── */
export default function InvestorPage(props) {
  const {
    provider = null,
    account = null,
    marketAddress,
    stableAddress,
    oracleAddress,
    registryAddress,
    complianceGateAddress, // not used here
    onError
  } = props || {};

  const MARKET = marketAddress || import.meta.env.VITE_MARKET_ADDRESS;
  const STABLE = stableAddress || import.meta.env.VITE_STABLE_ADDRESS;
  const ORACLE = oracleAddress || import.meta.env.VITE_ORACLE_ADDRESS;
  const RELAYER_URL = import.meta.env.VITE_RELAYER_URL;
  const FACTORY_RAW = import.meta.env.VITE_FACTORY;
  const BUNDLER_RAW = import.meta.env.VITE_BUNDLER;
  const RELAYER_ADDR_RAW = import.meta.env.VITE_RELAYER_ADDR;
  const FEE_TOKEN_RAW = import.meta.env.VITE_MUSD || STABLE;
  const FIXED_FEE_RAW = import.meta.env.VITE_FIXED_FEE_RAW;

  const FACTORY_ADDR =
    FACTORY_RAW && ethers.isAddress(FACTORY_RAW)
      ? ethers.getAddress(FACTORY_RAW)
      : "";
  const BUNDLER_ADDR =
    BUNDLER_RAW && ethers.isAddress(BUNDLER_RAW)
      ? ethers.getAddress(BUNDLER_RAW)
      : "";
  const RELAYER_ADDR =
    RELAYER_ADDR_RAW && ethers.isAddress(RELAYER_ADDR_RAW)
      ? ethers.getAddress(RELAYER_ADDR_RAW)
      : "";
  const FEE_TOKEN =
    FEE_TOKEN_RAW && ethers.isAddress(FEE_TOKEN_RAW)
      ? ethers.getAddress(FEE_TOKEN_RAW)
      : "";
  const FIXED_FEE = (() => {
    try {
      return FIXED_FEE_RAW ? BigInt(FIXED_FEE_RAW) : 0n;
    } catch {
      return 0n;
    }
  })();
  const hasRelayerConfig = Boolean(
    RELAYER_URL &&
      FACTORY_ADDR &&
      RELAYER_ADDR &&
      FEE_TOKEN &&
      FIXED_FEE_RAW !== undefined &&
      FIXED_FEE_RAW !== null &&
      FIXED_FEE_RAW !== ""
  );

  const [status, setStatus] = useState("");

  const market = useMemo(
    () =>
      provider && MARKET ? new Contract(MARKET, MARKET_ABI, provider) : null,
    [provider, MARKET]
  );
  const stable = useMemo(
    () =>
      provider && STABLE ? new Contract(STABLE, ERC20_ABI, provider) : null,
    [provider, STABLE]
  );
  const oracle = useMemo(
    () =>
      provider && ORACLE ? new Contract(ORACLE, ORACLE_ABI, provider) : null,
    [provider, ORACLE]
  );
  const registry = useMemo(
    () =>
      provider && registryAddress
        ? new Contract(registryAddress, REGISTRY_ABI, provider)
        : null,
    [provider, registryAddress]
  );
  const proxyFactory = useMemo(
    () =>
      provider && FACTORY_ADDR
        ? new Contract(FACTORY_ADDR, FACTORY_ABI, provider)
        : null,
    [provider, FACTORY_ADDR]
  );

  // stable info
  const [stableSym, setStableSym] = useState("USD");
  const [stableDec, setStableDec] = useState(6);
  const [walletStable, setWalletStable] = useState("0");
  const [walletAssets, setWalletAssets] = useState([]);

  // proxy wallet (relayer)
  const [proxyWallet, setProxyWallet] = useState("");
  const [proxyDeployed, setProxyDeployed] = useState(false);
  const [proxyNonce, setProxyNonce] = useState(0n);
  const [depositAmt, setDepositAmt] = useState("10");
  const [relayerBusy, setRelayerBusy] = useState(false);
  const [relayerFactoryWarning, setRelayerFactoryWarning] = useState("");

  // assets
  const [assets, setAssets] = useState([]); // [{id, symbol, decimals, token}]
  const [selAsset, setSelAsset] = useState(null);

  // makers
  const [makers, setMakers] = useState([]); // [{maker, invStable, invAsset}]
  const [selMaker, setSelMaker] = useState("");

  // oracle
  const [oracleDec, setOracleDec] = useState(8);
  const [lastPrice, setLastPrice] = useState("-");
  const [lastTs, setLastTs] = useState(null);
  const [oracleSeries, setOracleSeries] = useState([]); // {ts, price}[]

  // orders
  const [qty, setQty] = useState("");
  const [maxCost, setMaxCost] = useState("");
  const [minProceeds, setMinProceeds] = useState("");
  const [quote, setQuote] = useState(null);

  // unified transfer
  const [xferTo, setXferTo] = useState("");
  const [xferAmt, setXferAmt] = useState("");
  const [xferToMaker, setXferToMaker] = useState(false); // enabled only when stable
  const [xferKind, setXferKind] = useState("stable"); // 'stable' | 'asset'
  const [xferAssetId, setXferAssetId] = useState(""); // valid when asset selected

  // compliance (auto)
  const [compliance, setCompliance] = useState({
    whitelisted: null,
    kycExpiry: null
  });
  const [proxyCompliance, setProxyCompliance] = useState({
    whitelisted: null,
    kycExpiry: null
  });

  // chart mode
  const [chartMode, setChartMode] = useState("yahoo"); // 'yahoo' | 'oracle'
  const [yahooWindow, setYahooWindow] = useState("1y");

  const isStableSelected = xferKind === "stable";
  const walletAddress = useMemo(
    () => (proxyWallet ? proxyWallet : account),
    [proxyWallet, account]
  );
  const walletLabel = proxyWallet ? "Proxy Wallet" : "Wallet";

  /* unified wallet refresh (non-blocking, used everywhere) */
  const refreshWallet = useCallback(
    async () => {
      if (!provider || !walletAddress) {
        setWalletStable("0");
        setWalletAssets([]);
        return;
      }

      // ── Stable balance ───────────────────────────────
      if (stable) {
        try {
          const [sym, dec, bal] = await Promise.all([
            stable.symbol(),
            stable.decimals(),
            stable.balanceOf(walletAddress)
          ]);
          //setStableSym(sym);
          const decNum = Number(dec);
          setStableDec(decNum);
          setWalletStable(fmt(bal, decNum));
        } catch (e) {
          const msg = e?.shortMessage || e?.message || String(e);
          setStatus(`⚠️ error reading stable info: ${msg}`);
          onError && onError(msg);
        }
      }

      // ── Asset balances ───────────────────────────────
      if (assets.length && market) {
        try {
          const outs = await Promise.all(
            assets.map(async (a) => {
              try {
                const tokenAddr = a.token;
                if (!tokenAddr || tokenAddr === ethers.ZeroAddress) return null;
                const token = new Contract(tokenAddr, ERC20_ABI, provider);
                const bal = await token.balanceOf(walletAddress);
                const decimals =
                  typeof a.decimals === "number"
                    ? a.decimals
                    : Number(await token.decimals());

                return {
                  id: a.id,
                  symbol: a.symbol,
                  balance: bal,
                  decimals
                };
              } catch {
                return null;
              }
            })
          );
          setWalletAssets(outs.filter(Boolean));
        } catch {
          // ignore errors here, stable part already done
        }
      } else {
        setWalletAssets([]);
      }
    },
    [provider, walletAddress, stable, assets, market, onError]
  );

  const refreshProxyWalletState = useCallback(
    async (ownerAddr) => {
      if (!provider || !proxyFactory || !ownerAddr) {
        setProxyWallet("");
        setProxyDeployed(false);
        setProxyNonce(0n);
        return;
      }
      try {
        const predicted = await proxyFactory.predictWallet(ownerAddr);
        const pw = ethers.getAddress(predicted);
        setProxyWallet(pw);

        const code = await provider.getCode(pw);
        const deployed = !!code && code !== "0x";
        setProxyDeployed(deployed);

        if (deployed) {
          const w = new Contract(pw, PROXY_WALLET_READ_ABI, provider);
          const n = await w.nonce();
          setProxyNonce(BigInt(n));
        } else {
          setProxyNonce(0n);
        }
      } catch (e) {
        const msg = e?.shortMessage || e?.message || String(e);
        setStatus(`⚠️ proxy wallet error: ${msg}`);
        onError && onError(msg);
      }
    },
    [provider, proxyFactory, onError]
  );

  async function resolveProxyAndNonce(ownerAddr) {
    if (!provider || !proxyFactory || !ownerAddr) {
      throw new Error("ProxyWallet not configured.");
    }
    const predicted = ethers.getAddress(
      await proxyFactory.predictWallet(ownerAddr)
    );
    const code = await provider.getCode(predicted);
    const deployed = !!code && code !== "0x";
    let nonce = 0n;
    if (deployed) {
      const w = new Contract(predicted, PROXY_WALLET_READ_ABI, provider);
      nonce = BigInt(await w.nonce());
    }
    return { proxyWallet: predicted, deployed, nonce };
  }

  useEffect(() => {
    if (!account) {
      setProxyWallet("");
      setProxyDeployed(false);
      setProxyNonce(0n);
      return;
    }
    refreshProxyWalletState(account);
  }, [account, refreshProxyWalletState]);

  useEffect(() => {
    let active = true;
    if (!RELAYER_URL) return undefined;

    (async () => {
      try {
        const payload = await fetch(`${RELAYER_URL}/relayerStatus`).then((r) =>
          r.json()
        );
        const relayerFactory = payload?.config?.factory;
        if (!active) return;

        if (
          relayerFactory &&
          ethers.isAddress(relayerFactory) &&
          FACTORY_ADDR &&
          ethers.getAddress(relayerFactory) !== FACTORY_ADDR
        ) {
          setRelayerFactoryWarning(
            `Factory mismatch: dApp=${FACTORY_ADDR}, relayer=${ethers.getAddress(
              relayerFactory
            )}. Riavvia la dApp dopo il deploy locale per ricaricare gli env.`
          );
        } else {
          setRelayerFactoryWarning("");
        }
      } catch {
        if (active) setRelayerFactoryWarning("");
      }
    })();

    return () => {
      active = false;
    };
  }, [RELAYER_URL, FACTORY_ADDR]);

  async function createProxyWalletViaRelayer() {
    setStatus("");
    if (!account) return setStatus("⚠️ connect wallet first.");
    if (!RELAYER_URL)
      return setStatus("⚠️ relayer URL not configured.");
    try {
      setRelayerBusy(true);
      setStatus("Requesting relayer to create ProxyWallet…");

      const resp = await fetch(`${RELAYER_URL}/createWallet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: account })
      });
      const raw = await resp.text();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      if (!resp.ok) throw new Error(parsed?.error || raw);

      if (parsed?.txHash && provider) {
        await provider.waitForTransaction(parsed.txHash);
      }

      if (parsed?.wallet && ethers.isAddress(parsed.wallet) && provider) {
        const walletAddr = ethers.getAddress(parsed.wallet);
        setProxyWallet(walletAddr);
        const code = await provider.getCode(walletAddr);
        const deployed = !!code && code !== "0x";
        setProxyDeployed(deployed);
        if (deployed) {
          const w = new Contract(walletAddr, PROXY_WALLET_READ_ABI, provider);
          const n = await w.nonce();
          setProxyNonce(BigInt(n));
        } else {
          setProxyNonce(0n);
        }
      }

      setStatus(parsed?.alreadyDeployed ? "Already deployed" : "Created");
      try {
        await refreshProxyWalletState(account);
      } catch (refreshError) {
        const msg =
          refreshError?.shortMessage ||
          refreshError?.message ||
          String(refreshError);
        setStatus(`Created, but local ProxyWallet config looks stale. ${msg}`);
      }
      await refreshWallet();
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      setStatus(`❌ ${msg}`);
      onError && onError(msg);
    } finally {
      setRelayerBusy(false);
    }
  }

  async function gaslessDeposit() {
    setStatus("");
    if (!provider || !account)
      return setStatus("⚠️ connect wallet first.");
    if (!hasRelayerConfig)
      return setStatus("⚠️ relayer config missing.");
    if (!BUNDLER_ADDR)
      return setStatus("⚠️ bundler address missing.");
    if (!depositAmt || Number(depositAmt) <= 0)
      return setStatus("⚠️ deposit amount must be > 0.");
    try {
      setRelayerBusy(true);
      const signer = await provider.getSigner();
      const ownerAddr = ethers.getAddress(await signer.getAddress());
      const chainId = Number((await provider.getNetwork()).chainId);

      const { proxyWallet: pw, nonce } = await resolveProxyAndNonce(
        ownerAddr
      );

      const tokenRO = new Contract(
        FEE_TOKEN,
        ERC20_PERMIT_READ_ABI,
        provider
      );
      const [tokenName, tokenDecimals] = await Promise.all([
        tokenRO.name(),
        tokenRO.decimals()
      ]);
      const dec = Number(tokenDecimals);

      const permitNonce = await getPermitNoncePending(tokenRO, ownerAddr);
      const depositAmount = ethers.parseUnits(depositAmt, dec);
      const feeAmount = FIXED_FEE;
      const pullAmount = depositAmount + feeAmount;

      const now = Math.floor(Date.now() / 1000);
      const permitDeadline = BigInt(now + 300);
      const execDeadline = BigInt(now + 300);

      const pd = permitDomain(chainId, String(tokenName), FEE_TOKEN);
      const permitMsg = {
        owner: ownerAddr,
        spender: BUNDLER_ADDR,
        value: pullAmount,
        nonce: permitNonce,
        deadline: permitDeadline
      };
      const permitSigRaw = await signer.signTypedData(
        pd,
        PERMIT_TYPES,
        permitMsg
      );
      const permitSig = ethers.Signature.from(permitSigRaw);

      const erc20Iface = new ethers.Interface(ERC20_ABI);
      const noopData = erc20Iface.encodeFunctionData("transfer", [
        pw,
        0n
      ]);

      const execReq = {
        call: { to: FEE_TOKEN, value: 0n, data: noopData, operation: 0 },
        nonce,
        deadline: execDeadline,
        executor: BUNDLER_ADDR,
        feeToken: FEE_TOKEN,
        feeAmount: feeAmount,
        feeRecipient: RELAYER_ADDR
      };

      const wd = walletDomain(chainId, pw);
      const execSig = await signer.signTypedData(
        wd,
        { Call: TYPES.Call, Execute: TYPES.Execute },
        execReq
      );

      const payload = {
        token: FEE_TOKEN,
        owner: ownerAddr,
        proxyWallet: pw,
        pullAmount: pullAmount.toString(),
        permitNonce: permitNonce.toString(),
        permitDeadline: permitDeadline.toString(),
        permitSig: { v: permitSig.v, r: permitSig.r, s: permitSig.s },
        exec: {
          call: {
            to: execReq.call.to,
            value: "0",
            data: execReq.call.data,
            operation: 0
          },
          nonce: execReq.nonce.toString(),
          deadline: execReq.deadline.toString(),
          executor: execReq.executor,
          feeToken: execReq.feeToken,
          feeAmount: execReq.feeAmount.toString(),
          feeRecipient: execReq.feeRecipient
        },
        execSig,
        bundler: BUNDLER_ADDR
      };

      setStatus("Sending gasless deposit to relayer…");
      const resp = await fetch(`${RELAYER_URL}/bundleExecute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const raw = await resp.text();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      if (!resp.ok)
        throw new Error(
          typeof parsed === "string"
            ? parsed
            : parsed?.error || JSON.stringify(parsed)
        );

      const h = parsed?.txHash || "";
      if (h) {
        await assertSameChain(provider, RELAYER_URL);
        await waitForReceipt(provider, h, { pollMs: 700, timeoutMs: 45_000 });
        setStatus("Deposit confirmed");
      } else {
        setStatus("Deposit relayed");
      }

      await refreshProxyWalletState(account);
      await refreshWallet();
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      setStatus(`❌ ${msg}`);
      onError && onError(msg);
    } finally {
      setRelayerBusy(false);
    }
  }

  async function sendViaRelayer({ to, data, value = 0n, operation = 0 }) {
    if (!provider || !account) throw new Error("Connect wallet first.");
    if (!hasRelayerConfig) throw new Error("Relayer not configured.");

    const signer = await provider.getSigner();
    const ownerAddr = ethers.getAddress(await signer.getAddress());
    const chainId = Number((await provider.getNetwork()).chainId);

    const { proxyWallet: pw, deployed, nonce } = await resolveProxyAndNonce(
      ownerAddr
    );
    if (!deployed) {
      throw new Error(
        "ProxyWallet not deployed. Create it first (Relayer)."
      );
    }

    const execDeadline = BigInt(Math.floor(Date.now() / 1000) + 300);

    const execReq = {
      call: { to, value, data, operation },
      nonce,
      deadline: execDeadline,
      executor: RELAYER_ADDR,
      feeToken: FEE_TOKEN,
      feeAmount: FIXED_FEE,
      feeRecipient: RELAYER_ADDR
    };

    const wd = walletDomain(chainId, pw);
    const execSig = await signer.signTypedData(
      wd,
      { Call: TYPES.Call, Execute: TYPES.Execute },
      execReq
    );

    const payload = {
      wallet: pw,
      request: {
        call: {
          to: execReq.call.to,
          value: execReq.call.value.toString(),
          data: execReq.call.data,
          operation: execReq.call.operation
        },
        nonce: execReq.nonce.toString(),
        deadline: execReq.deadline.toString(),
        executor: execReq.executor,
        feeToken: execReq.feeToken,
        feeAmount: execReq.feeAmount.toString(),
        feeRecipient: execReq.feeRecipient
      },
      signature: execSig
    };

    const resp = await fetch(`${RELAYER_URL}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const raw = await resp.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    if (!resp.ok)
      throw new Error(
        typeof parsed === "string"
          ? parsed
          : parsed?.error || JSON.stringify(parsed)
      );

    const h = parsed?.txHash || "";
    if (h) {
      await assertSameChain(provider, RELAYER_URL);
      await waitForReceipt(provider, h, { pollMs: 700, timeoutMs: 45_000 });
    }
    await refreshProxyWalletState(account);
    return h;
  }

  async function ensureProxyApprove(tokenAddr, spender, need) {
    if (!provider || !account)
      throw new Error("Connect wallet first.");
    const { proxyWallet: pw } = await resolveProxyAndNonce(account);
    const token = new Contract(tokenAddr, ERC20_ABI, provider);
    const cur = await token.allowance(pw, spender);
    if (cur >= need) return;

    const iface = new ethers.Interface(ERC20_ABI);
    const data = iface.encodeFunctionData("approve", [spender, need]);
    await sendViaRelayer({ to: tokenAddr, data });
  }

  /* keep maker-toggle coherent with kind */
  useEffect(() => {
    if (xferKind !== "stable" && xferToMaker) setXferToMaker(false);
  }, [xferKind, xferToMaker]);

  /* compliance helpers */
  async function callBool(reg, names, arg, def = false) {
    for (const n of names) {
      const fn = reg?.[n];
      if (typeof fn === "function") {
        try {
          return Boolean(await fn(arg));
        } catch {}
      }
    }
    return def;
  }
  async function callUint(reg, names, arg, def = 0n) {
    for (const n of names) {
      const fn = reg?.[n];
      if (typeof fn === "function") {
        try {
          const v = await fn(arg);
          return typeof v === "bigint"
            ? v
            : BigInt(v?.toString?.() ?? `${v}`);
        } catch {}
      }
    }
    return def;
  }
  const fmtDate = (secStr) => {
    if (!secStr) return "—";
    const n = Number(secStr);
    if (!Number.isFinite(n) || n <= 0) return `${secStr} (not set)`;
    try {
      return `${secStr} → ${new Date(n * 1000).toLocaleString()}`;
    } catch {
      return secStr;
    }
  };

  /* load assets */
  useEffect(() => {
    (async () => {
      if (!provider || !market || !MARKET) {
        setAssets([]);
        return;
      }
      let ids = [];
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

      if (!ids.length) {
        try {
          const logAddr = MARKET || market?.target;
          if (logAddr) {
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
          }
        } catch {
          ids = [];
        }
      }

      if (!ids.length) {
        try {
          const logAddr = MARKET || market?.target;
          if (logAddr) {
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
          }
        } catch {
          ids = [];
        }
      }

      const ZERO_ID = ethers.ZeroHash ?? `0x${"0".repeat(64)}`;
      const uniq = Array.from(new Set((ids || []).map((x) => String(x)))).filter(
        (id) => id !== ZERO_ID
      );
      const metas = await Promise.all(
        uniq.map(async (id) => {
          try {
            const info = await market.assets(id);
            const tokenAddr = info.token ?? info[0];
            const sym = info.symbolText ?? info[1] ?? "ASSET";
            const dec = Number(info.tokenDecimals ?? info[2] ?? 18);
            const listed = Boolean(info.listed ?? info[3] ?? true);
            return {
              id: String(id),
              token: tokenAddr,
              symbol: String(sym),
              decimals: dec,
              listed,
            };
          } catch {
            try {
              const taddr = await market.tokenAddress(id);
              if (taddr && taddr !== ethers.ZeroAddress) {
                const tok = new Contract(taddr, ERC20_ABI, provider);
                const [sym, dec] = await Promise.all([tok.symbol(), tok.decimals()]);
                return {
                  id: String(id),
                  token: taddr,
                  symbol: String(sym || "ASSET"),
                  decimals: Number(dec || 18),
                  listed: true,
                };
              }
            } catch {}
            return {
              id: String(id),
              token: ethers.ZeroAddress,
              symbol: "ASSET",
              decimals: 18,
              listed: true,
            };
          }
        })
      );

      const listedMetas = metas.filter(
        (m) =>
          m.listed &&
          m.token &&
          m.token !== ethers.ZeroAddress &&
          String(m.id) !== ZERO_ID
      );
      setAssets(listedMetas);

      const hasSel = listedMetas.some((m) => String(m.id) === String(xferAssetId));
      if ((!xferAssetId || !hasSel) && listedMetas.length) {
        setXferAssetId(String(listedMetas[0].id));
      }
      if (listedMetas.length === 0) {
        setXferKind("stable");
      }
    })();
  }, [provider, market, MARKET]);

  // auto–refresh wallet when deps change
  useEffect(() => {
    refreshWallet();
  }, [refreshWallet]);

  /* tie TOP selector → page selected asset */
  useEffect(() => {
    if (xferKind === "asset") {
      const a = assets.find((x) => x.id === xferAssetId) || null;
      setSelAsset(a);
    } else {
      setSelAsset(null);
    }
    setQuote(null);
  }, [xferKind, xferAssetId, assets]);

  /* makers refresh function (reused everywhere) */
  // ottimizzato: non dipende più da selMaker, niente loop extra
  const refreshMaker = useCallback(
    async () => {
      if (!market || !selAsset?.id) {
        setMakers([]);
        return;
      }
      try {
        const role = await market.INVENTORY_ROLE();
        const countRaw = await market.getRoleMemberCount(role);
        const count = Number(countRaw);
        if (!Number.isFinite(count) || count <= 0) {
          setMakers([]);
          return;
        }

        const makerList = await Promise.all(
          Array.from({ length: count }, (_, i) =>
            market.getRoleMember(role, i)
          )
        );

        const out = await Promise.all(
          makerList.map(async (maker) => {
            const [invSt, invA] = await Promise.all([
              market.invStable(maker),
              market.invAsset(maker, selAsset.id),
            ]);
            return { maker, invStable: invSt, invAsset: invA };
          })
        );

        const filtered = out.filter((x) => x.invStable > 0n || x.invAsset > 0n);
        setMakers(filtered);
        if (!selMaker && filtered.length) setSelMaker(filtered[0].maker);
      } catch (e) {
        setStatus(
          `⚠️ makers not available: ${
            e?.shortMessage || e?.message || String(e)
          }`
        );
        setMakers([]);
      }
    },
    [market, selAsset?.id] // 👈 niente selMaker qui
  );

  /* makers for selected asset (auto) */
  useEffect(() => {
    refreshMaker();
  }, [refreshMaker]);

  /* compliance refresh function */
  const refreshCompliance = useCallback(
    async () => {
      if (!provider || !registry) {
        setCompliance({ whitelisted: null, kycExpiry: null });
        setProxyCompliance({ whitelisted: null, kycExpiry: null });
        return;
      }
      if (!account) {
        setCompliance({ whitelisted: null, kycExpiry: null });
      }
      if (!proxyWallet) {
        setProxyCompliance({ whitelisted: null, kycExpiry: null });
      }

      if (account) {
        try {
          const w = await callBool(registry, ["isWhitelisted"], account, false);
          const k = await callUint(
            registry,
            ["kycexpiry", "getKycExpiry"],
            account,
            0n
          );
          setCompliance({ whitelisted: w, kycExpiry: k.toString() });
        } catch {
          setCompliance({ whitelisted: null, kycExpiry: null });
        }
      }

      if (proxyWallet) {
        try {
          const w = await callBool(registry, ["isWhitelisted"], proxyWallet, false);
          const k = await callUint(
            registry,
            ["kycexpiry", "getKycExpiry"],
            proxyWallet,
            0n
          );
          setProxyCompliance({ whitelisted: w, kycExpiry: k.toString() });
        } catch {
          setProxyCompliance({ whitelisted: null, kycExpiry: null });
        }
      }
    },
    [provider, account, registry, proxyWallet]
  );

  /* compliance auto for account */
  useEffect(() => {
    refreshCompliance();
  }, [refreshCompliance]);

  useEffect(() => {
    if (!provider || !registryAddress) return;

    const filter = { address: registryAddress };
    const handler = () => {
      // as soon as there is a log on the registry, reload
      refreshCompliance();
    };

    provider.on(filter, handler);
    return () => {
      provider.off(filter, handler);
    };
  }, [provider, registryAddress, refreshCompliance]);

  /* oracle: history + last price via events + getReference */
  const reloadOracle = useCallback(
    async () => {
      if (isStableSelected) {
        setOracleDec(stableDec);
        setLastPrice("1");
        setLastTs(null);
        setOracleSeries([]);
        return;
      }
      if (!oracle || !selAsset?.id || !provider || !ORACLE) {
        setLastPrice("-");
        setLastTs(null);
        setOracleSeries([]);
        return;
      }

      try {
        const dec = Number(await oracle.decimals());
        setOracleDec(dec);

        const topic0 = ethers.id(
          "ReferenceUpdated(bytes32,uint256,uint64)"
        );
        const iface = new ethers.Interface(ORACLE_ABI);

        let series = [];
        try {
          const logs = await provider.getLogs({
            address: ORACLE,
            topics: [topic0, selAsset.id],
            fromBlock: 0n,
            toBlock: "latest"
          });

          series = logs
            .map((lg) => {
              try {
                const parsed = iface.parseLog(lg);
                const priceRaw = parsed.args.value;
                const tsRaw = parsed.args.ts;
                const tsNum = Number(tsRaw);
                const priceNum = Number(
                  ethers.formatUnits(priceRaw, dec)
                );
                if (!Number.isFinite(priceNum) || tsNum <= 0) return null;
                return { ts: tsNum, price: priceNum, raw: priceRaw };
              } catch {
                return null;
              }
            })
            .filter(Boolean)
            .sort((a, b) => a.ts - b.ts);
        } catch (e) {
          console.error("oracle history error", e);
        }

        setOracleSeries(series);

        if (series.length) {
          const last = series[series.length - 1];
          setLastTs(last.ts);
          // lastPrice è una stringa formattata, come prima
          setLastPrice(fmt(last.raw, dec));
        } else {
          // fallback: read latest reference directly
          try {
            const [p, ts] = await oracle.getReference(selAsset.id);
            const tsNum = Number(ts);
            if (tsNum > 0) {
              setLastTs(tsNum);
              setLastPrice(fmt(p, dec));
              setOracleSeries([{ ts: tsNum, price: Number(ethers.formatUnits(p, dec)) }]);
            } else {
              setLastPrice("-");
              setLastTs(null);
            }
          } catch {
            setLastPrice("-");
            setLastTs(null);
          }
        }
      } catch (e) {
        console.error("reloadOracle error", e);
        setLastPrice("-");
        setLastTs(null);
        setOracleSeries([]);
      }
    },
    [isStableSelected, stableDec, oracle, selAsset?.id, provider, ORACLE]
  );


  // auto load oracle history on asset / oracle change
  useEffect(() => {
    reloadOracle();
  }, [reloadOracle]);

  // live oracle: polling getReference per avere un plot veramente live
useEffect(() => {
  if (!oracle || !selAsset?.id || isStableSelected) return;

  let cancelled = false;
  let intervalId = null;
  let decCache = oracleDec ?? null;

  const POLL_MS = 1000; // 1 secondo, regolalo come vuoi

  const ensureDec = async () => {
    if (decCache != null && Number.isFinite(decCache)) return decCache;
    try {
      const dec = Number(await oracle.decimals());
      if (!cancelled) {
        decCache = dec;
        setOracleDec(dec);
      }
      return dec;
    } catch {
      return 8;
    }
  };

  const tick = async () => {
    if (cancelled) return;

    try {
      const dec = await ensureDec();
      const [p, ts] = await oracle.getReference(selAsset.id);

      const tsNum = Number(ts);
      const priceNum = Number(ethers.formatUnits(p, dec));

      if (!Number.isFinite(priceNum) || tsNum <= 0) return;

      setLastPrice(fmt(p, dec));
      setLastTs(tsNum);

      setOracleSeries((prev) => {
        const updated = { ts: tsNum, price: priceNum };
        const idx = prev.findIndex((pt) => pt.ts === tsNum);

        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = updated;
          return copy;
        }

        const next = [...prev, updated];
        next.sort((a, b) => a.ts - b.ts);
        if (next.length > 1000) next.shift();
        return next;
      });
    } catch (e) {
      console.error("oracle polling error", e);
    }
  };

  // primo tick subito
  tick();
  intervalId = window.setInterval(tick, POLL_MS);

  return () => {
    cancelled = true;
    if (intervalId) clearInterval(intervalId);
  };
}, [oracle, selAsset?.id, isStableSelected, oracleDec]);


  /* live auto–refresh on trade events (wallet + makers) */
  // versione ottimizzata con throttle via setTimeout
  useEffect(() => {
    if (!market) return;
    const lowerAccount = walletAddress ? walletAddress.toLowerCase() : null;

    let makerTimeout = null;
    let walletTimeout = null;

    const scheduleMakerRefresh = () => {
      if (makerTimeout) return;
      makerTimeout = setTimeout(() => {
        makerTimeout = null;
        refreshMaker();
      }, 100); // ~istantaneo, ma non per ogni singolo evento
    };

    const scheduleWalletRefresh = () => {
      if (walletTimeout) return;
      walletTimeout = setTimeout(() => {
        walletTimeout = null;
        refreshWallet();
      }, 100);
    };

    const handleBought = (
      user,
      makerAddr,
      id,
      qty,
      price,
      costStable,
      feeToMaker,
      extra
    ) => {
      scheduleMakerRefresh();
      if (lowerAccount && user && user.toLowerCase() === lowerAccount) {
        scheduleWalletRefresh();
      }
    };

    const handleSold = (
      user,
      makerAddr,
      id,
      qty,
      price,
      proceedsStable,
      feeToMaker,
      extra
    ) => {
      scheduleMakerRefresh();
      if (lowerAccount && user && user.toLowerCase() === lowerAccount) {
        scheduleWalletRefresh();
      }
    };

    market.on("BoughtFrom", handleBought);
    market.on("SoldTo", handleSold);

    return () => {
      market.off("BoughtFrom", handleBought);
      market.off("SoldTo", handleSold);
      if (makerTimeout) clearTimeout(makerTimeout);
      if (walletTimeout) clearTimeout(walletTimeout);
    };
  }, [market, walletAddress, refreshWallet, refreshMaker]);

  /* quotes */
  async function doQuoteBuy() {
    if (!market || !selAsset?.id) return;
    try {
      const amt = ethers.parseUnits(qty || "0", assetDec(selAsset));
      const [total, cost, fee, extra] = await market.quoteBuyFrom(
        selAsset.id,
        amt
      );
      setQuote({ total, cost, fee, extra });
    } catch (e) {
      setStatus(
        `❌ quote buy: ${e?.shortMessage || e?.message || String(e)}`
      );
    }
  }
  async function doQuoteSell() {
    if (!market || !selAsset?.id) return;
    try {
      const amt = ethers.parseUnits(qty || "0", assetDec(selAsset));
      const [payout, proceeds, fee, extra] = await market.quoteSellTo(
        selAsset.id,
        amt
      );
      setQuote({ payout, proceeds, fee, extra });
    } catch (e) {
      setStatus(
        `❌ quote sell: ${e?.shortMessage || e?.message || String(e)}`
      );
    }
  }

  async function buyFromMaker() {
    setStatus("");
    if (
      !provider ||
      !account ||
      !market ||
      !stable ||
      !selAsset?.id ||
      !selMaker
    )
      return setStatus("⚠️ configure account and select an asset/maker");
    try {
      const amt = ethers.parseUnits(qty || "0", assetDec(selAsset));
      const max = ethers.parseUnits(maxCost || "0", stableDec);
      await ensureProxyApprove(STABLE, MARKET, max);
      const iface = new ethers.Interface(MARKET_ABI);
      const data = iface.encodeFunctionData("buyFrom", [
        selMaker,
        selAsset.id,
        amt,
        max
      ]);
      setStatus("Relaying buy via ProxyWallet…");
      const h = await sendViaRelayer({ to: MARKET, data });
      setStatus(`✅ Buy confirmed${h ? `: ${h}` : ""}`);
      // non-blocking refresh
      refreshWallet();
      refreshMaker();
    } catch (e) {
      setStatus(
        `❌ Error Buy: ${e?.shortMessage || e?.message || String(e)}`
      );
      onError && onError(e?.message || String(e));
    }
  }

  async function sellToMaker() {
    setStatus("");
    if (!provider || !account || !market || !selAsset?.id || !selMaker)
      return setStatus("⚠️ configure account and select an asset/maker");
    try {
      const tokenAddr = await market.tokenAddress(selAsset.id);
      if (!tokenAddr || tokenAddr === ethers.ZeroAddress)
        throw new Error("Token address not available");
      const amt = ethers.parseUnits(qty || "0", assetDec(selAsset));
      const minP = ethers.parseUnits(minProceeds || "0", stableDec);
      await ensureProxyApprove(tokenAddr, MARKET, amt);
      const iface = new ethers.Interface(MARKET_ABI);
      const data = iface.encodeFunctionData("sellTo", [
        selMaker,
        selAsset.id,
        amt,
        minP
      ]);
      setStatus("Relaying sell via ProxyWallet…");
      const h = await sendViaRelayer({ to: MARKET, data });
      setStatus(`✅ Sell confirmed${h ? `: ${h}` : ""}`);
      // non-blocking refresh
      refreshWallet();
      refreshMaker();
    } catch (e) {
      setStatus(
        `❌ Error Sell: ${e?.shortMessage || e?.message || String(e)}`
      );
      onError && onError(e?.message || String(e));
    }
  }

  /* unified transfer meta */
  const transferMeta = useMemo(() => {
    if (xferKind === "stable") {
      return {
        kind: "stable",
        symbol: stableSym,
        decimals: stableDec,
        balanceFmt: walletStable,
        assetId: null,
        token: null,
      };
    }
    const a = assets.find((x) => x.id === xferAssetId) || null;
    const w = walletAssets.find((w) => w.id === xferAssetId);
    const balanceFmt = w ? fmt(w.balance, w.decimals) : "0";
    return {
      kind: "asset",
      symbol: assetSym(a),
      decimals: assetDec(a),
      balanceFmt,
      assetId: a?.id || null,
      token: a?.token || null,
    };
  }, [
    xferKind,
    xferAssetId,
    assets,
    walletAssets,
    stableSym,
    stableDec,
    walletStable
  ]);

  async function transferToken() {
    setStatus("");
    if (!provider || !account)
      return setStatus("⚠️ configure provider and contracts.");

    const to =
      xferKind === "stable" && xferToMaker ? selMaker : xferTo;
    if (xferKind === "stable" && xferToMaker && !selMaker) {
      return setStatus("⚠️ select a maker in the Asset view first.");
    }
    if (!to)
      return setStatus(
        "⚠️ specify the receiver (or select a maker)."
      );
    if (!ethers.isAddress(to))
      return setStatus("⚠️ receiver wallet not valid");

    try {
      let tokenContract = null;
      let tokenAddr = "";
      let symbol = transferMeta.symbol;
      let decimals = transferMeta.decimals;

      if (xferKind === "stable") {
        if (!stable)
          return setStatus("⚠️ stable contract not configured.");
        tokenContract = stable;
        tokenAddr = STABLE;
      } else {
        if (!transferMeta.assetId)
          return setStatus("⚠️ select an asset to transfer.");
        const a =
          assets.find((x) => x.id === transferMeta.assetId) || null;
        if (a?.token && a.token !== ethers.ZeroAddress)
          tokenAddr = a.token;
        else {
          try {
            tokenAddr = await market.tokenAddress(transferMeta.assetId);
          } catch {}
        }
        if (!tokenAddr || tokenAddr === ethers.ZeroAddress)
          return setStatus(
            "⚠️ token address for selected asset not available."
          );
        tokenContract = new Contract(tokenAddr, ERC20_ABI, provider);
        if (decimals == null) {
          try {
            decimals = Number(await tokenContract.decimals());
          } catch {}
        }
      }

      const amt = ethers.parseUnits(xferAmt || "0", decimals ?? 18);
      if (amt <= 0n)
        return setStatus("⚠️ amount must be > 0.");

      const iface = new ethers.Interface(ERC20_ABI);
      const data = iface.encodeFunctionData("transfer", [to, amt]);
      setStatus("Relaying transfer via ProxyWallet…");
      const h = await sendViaRelayer({ to: tokenAddr, data });

      setStatus(
        `✅ Transfer ${fmt(amt, decimals ?? 18)} ${symbol} → ${to.slice(
          0,
          6
        )}…${to.slice(-4)}${h ? `: ${h}` : ""}`
      );
      setXferTo("");
      setXferAmt("");

      // non-blocking refresh
      refreshWallet();
      if (xferKind === "asset") refreshMaker();
    } catch (e) {
      const msg =
        e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Transfer: ${msg}`);
      onError && onError(msg);
    }
  }

  const selectedAssetWallet = useMemo(() => {
    if (!selAsset?.id) return null;
    return walletAssets.find((w) => w.id === selAsset.id) || null;
  }, [walletAssets, selAsset?.id]);

  const yahooSymbol = useMemo(() => {
    return isStableSelected
      ? STABLE_SENTINEL
      : guessTickerFromAsset(selAsset || null);
  }, [isStableSelected, selAsset]);
  const yahooLabel = useMemo(() => {
    return isStableSelected ? "1" : assetSym(selAsset);
  }, [isStableSelected, selAsset]);

  /* ───────────────────────── UI ───────────────────────── */
  return (
    <section className="space-y-6">
      {/* Header + Compliance */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl md:text-2xl bg-clip-text text-transparent bg-gradient-to-r from-indigo-300 via-fuchsia-300 to-cyan-300">
            Investor Wallet
          </h2>
          <button
            onClick={() => {
              // all refreshes fire together, without await
              refreshCompliance();
              refreshWallet();
              refreshMaker();
              reloadOracle();
            }}
            className="px-3 py-1.5 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 text-sm"
          >
            Refresh
          </button>
        </div>

        <div className="text-right text-sm text-neutral-400">
          <div>
            {walletLabel} {stableSym}:{" "}
            <span className="font-mono">{walletStable}</span>
          </div>
          <div className="mt-0.5">
            {isStableSelected ? (
              <>
                Selected:{" "}
                <span className="font-mono">{stableSym}</span>
              </>
            ) : selAsset?.id ? (
              <>
                {walletLabel} {assetSym(selAsset)}:{" "}
                <span className="font-mono">
                  {selectedAssetWallet
                    ? fmt(
                        selectedAssetWallet.balance,
                        selectedAssetWallet.decimals
                      )
                    : "0"}
                </span>
              </>
            ) : (
              <>Selected: —</>
            )}
          </div>
          <div className="mt-0.5">
            Investor:{" "}
            <span className="font-mono">
              {account ? `${account}` : "—"}
            </span>
          </div>
          <div className="mt-0.5">
            Proxy Wallet:{" "}
            <span className="font-mono">
              {proxyWallet ? `${proxyWallet}` : "—"}
            </span>{" "}
            {proxyWallet && (
              <span className="text-xs text-neutral-500">
                ({proxyDeployed ? "deployed" : "not deployed"})
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-neutral-300 space-y-1 text-right">
            {registry ? (
              <>
                <div className="flex items-center justify-end gap-2">
                  <span
                    className={`px-2 py-0.5 rounded-lg border ${
                      compliance.whitelisted === true
                        ? "bg-emerald-900/20 border-emerald-700 text-emerald-200"
                        : compliance.whitelisted === false
                          ? "bg-red-900/20 border-red-700 text-red-200"
                          : "bg-neutral-900/40 border-neutral-700 text-neutral-300"
                    }`}
                    title="isWhitelisted(account)"
                  >
                    WL (Investor):{" "}
                    {compliance.whitelisted === null
                      ? "—"
                      : compliance.whitelisted
                        ? "yes"
                        : "no"}
                  </span>
                  <span className="text-neutral-300" title="kycExpiry">
                    KYC:{" "}
                    <span className="font-mono">
                      {fmtDate(compliance.kycExpiry)}
                    </span>
                  </span>
                </div>

                <div className="flex items-center justify-end gap-2">
                  <span
                    className={`px-2 py-0.5 rounded-lg border ${
                      proxyCompliance.whitelisted === true
                        ? "bg-emerald-900/20 border-emerald-700 text-emerald-200"
                        : proxyCompliance.whitelisted === false
                          ? "bg-red-900/20 border-red-700 text-red-200"
                          : "bg-neutral-900/40 border-neutral-700 text-neutral-300"
                    }`}
                    title="isWhitelisted(proxyWallet)"
                  >
                    WL (Proxy):{" "}
                    {proxyCompliance.whitelisted === null
                      ? "—"
                      : proxyCompliance.whitelisted
                        ? "yes"
                        : "no"}
                  </span>
                  <span className="text-neutral-300" title="kycExpiry (proxy)">
                    KYC:{" "}
                    <span className="font-mono">
                      {fmtDate(proxyCompliance.kycExpiry)}
                    </span>
                  </span>
                </div>
              </>
            ) : (
              <span className="text-neutral-500">
                Compliance: registry not set
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ────────────── Proxy Wallet (Relayer) ────────────── */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm text-neutral-300">
            Proxy Wallet (Relayer)
          </div>
          <div className="text-xs text-neutral-400">
            {proxyDeployed ? "Deployed" : "Not deployed"}
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-3">
          <div className="md:col-span-2 text-xs text-neutral-400 space-y-1">
            <div>
              Predicted:{" "}
              <span className="font-mono">
                {proxyWallet || "—"}
              </span>
            </div>
            <div>
              Factory:{" "}
              <span className="font-mono">
                {FACTORY_ADDR || "—"}
              </span>
            </div>
            <div>
              Relayer:{" "}
              <span className="font-mono">
                {RELAYER_ADDR || "—"}
              </span>
            </div>
            <div>
              Fixed fee:{" "}
              <span className="font-mono">
                {FIXED_FEE_RAW ? fmt(FIXED_FEE, stableDec) : "—"}{" "}
                {stableSym}
              </span>
            </div>
            <div>
              Cached nonce:{" "}
              <span className="font-mono">
                {proxyNonce?.toString?.() ?? "0"}
              </span>
            </div>
            {relayerFactoryWarning ? (
              <div className="text-amber-300 whitespace-pre-wrap">
                {relayerFactoryWarning}
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <button
              onClick={createProxyWalletViaRelayer}
              disabled={
                !account || relayerBusy || !RELAYER_URL || !FACTORY_ADDR
              }
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500 disabled:opacity-60"
            >
              Create ProxyWallet via Relayer
            </button>

            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
                placeholder={`Amount ${stableSym}`}
                value={depositAmt}
                onChange={(e) => setDepositAmt(e.target.value)}
              />
              <button
                onClick={gaslessDeposit}
                disabled={
                  !account ||
                  relayerBusy ||
                  !hasRelayerConfig ||
                  !BUNDLER_ADDR
                }
                className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60"
              >
                Deposit
              </button>
            </div>
          </div>
        </div>

        {!hasRelayerConfig && (
          <div className="mt-2 text-xs text-neutral-500">
            Relayer config missing. Set VITE_RELAYER_URL, VITE_FACTORY,
            VITE_MUSD, VITE_RELAYER_ADDR, VITE_FIXED_FEE_RAW
            (and VITE_BUNDLER for deposit).
          </div>
        )}
      </div>

      {/* ────────────── Transfer (driver) ────────────── */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm text-neutral-300">Transfer Token</div>

          {/* Maker toggle: ONLY visible/usable for stable */}
          {isStableSelected && (
            <label className="text-xs inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={xferToMaker}
                onChange={(e) =>
                  setXferToMaker(e.target.checked)
                }
                className="w-4 h-4 accent-indigo-600"
                disabled={!selMaker}
                title={
                  selMaker
                    ? "Send to selected maker"
                    : "Select a maker in Asset view first"
                }
              />
              <span>
                Send to selected maker{" "}
                {selMaker ? (
                  <span className="font-mono">
                    ({selMaker.slice(0, 6)}…
                    {selMaker.slice(-4)})
                  </span>
                ) : (
                  <span className="text-neutral-500">
                    (select in Asset view)
                  </span>
                )}
              </span>
            </label>
          )}
        </div>

        <div className="grid md:grid-cols-3 gap-2">
          {/* KIND + ASSET */}
          <div className="flex items-center gap-2">
            <select
              className="w-full px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
              value={
                xferKind === "stable" ? "stable" : xferAssetId || ""
              }
              onChange={(e) => {
                const val = e.target.value;
                if (val === "stable") {
                  setXferKind("stable");
                } else {
                  setXferKind("asset");
                  setXferAssetId(val);
                }
                setXferAmt("");
              }}
            >
              <option value="stable">
                {stableSym} (stable)
            </option>
            {assets.map((a) => (
              <option key={String(a.id)} value={a.id}>
                {a.symbol} · {a.token ? `${String(a.token).slice(0, 6)}…${String(a.token).slice(-4)}` : "—"}
              </option>
            ))}
          </select>
          </div>

          {/* Destination */}
          <div className="flex items-center">
            <input
              className="w-full px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none font-mono"
              placeholder="To address (0x…)"
              value={
                isStableSelected && xferToMaker
                  ? selMaker || ""
                  : xferTo
              }
              onChange={(e) =>
                !(isStableSelected && xferToMaker) &&
                setXferTo(e.target.value)
              }
              disabled={isStableSelected && xferToMaker}
            />
          </div>

          {/* Amount + Max */}
          <div className="flex gap-2">
            <input
              className="flex-1 px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
              placeholder={`Amount ${transferMeta.symbol}`}
              value={xferAmt}
              onChange={(e) => setXferAmt(e.target.value)}
            />
            <button
              onClick={() =>
                setXferAmt(transferMeta.balanceFmt)
              }
              className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500"
            >
              Max
            </button>
          </div>
        </div>

        <div className="mt-2 text-xs text-neutral-400">
          Balance:{" "}
          <span className="font-mono">
            {transferMeta.balanceFmt}
          </span>{" "}
          {transferMeta.symbol}
          {xferKind === "asset" && transferMeta.token ? (
            <>
              {" "}
              · Token:{" "}
              <span className="font-mono">
                {String(transferMeta.token).slice(0, 6)}…{String(transferMeta.token).slice(-4)}
              </span>
            </>
          ) : xferKind === "asset" && transferMeta.assetId ? (
            <>
              {" "}
              · Asset ID:{" "}
              <span className="font-mono">
                {String(transferMeta.assetId).slice(0, 6)}…{String(transferMeta.assetId).slice(-4)}
              </span>
            </>
          ) : null}
        </div>

        <div className="mt-3">
          <button
            onClick={transferToken}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
          >
            Transfer
          </button>
        </div>
      </div>

      {/* Top: selected + oracle + charts */}
      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-1 p-4 rounded-2xl border border-white/10 bg-white/5">
          <div className="text-sm text-neutral-300 mb-2">
            Selected
          </div>

          <select
            className="w-full px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
            value={
              isStableSelected ? "stable" : selAsset?.id || ""
            }
            onChange={(e) => {
              const val = e.target.value;
              if (val === "stable") {
                setXferKind("stable");
              } else {
                setXferKind("asset");
                setXferAssetId(val);
              }
              setQuote(null);
            }}
          >
            <option value="stable">
              {stableSym} (stable)
            </option>
            {assets.map((a) => (
              <option key={String(a.id)} value={a.id}>
                {a.symbol} · {a.token ? `${String(a.token).slice(0, 6)}…${String(a.token).slice(-4)}` : String(a.id).slice(0, 6) + "…" + String(a.id).slice(-4)}
              </option>
            ))}
          </select>

          <div className="mt-4 text-sm grid gap-1">
            <div>
              Type:{" "}
              <span className="font-mono">
                {isStableSelected ? "STABLE" : "ASSET"}
              </span>
            </div>
            <div>
              Decimals:{" "}
              <span className="font-mono">
                {isStableSelected
                  ? stableDec
                  : selAsset?.decimals ?? "-"}
              </span>
            </div>
            {/*<div>
              Oracle price:{" "}
              <span className="font-mono">
                {isStableSelected
                  ? "1 (constant)"
                  : lastPrice !== "-"
                    ? `${lastPrice} USD`
                    : "-"}
              </span>
            </div>
            */}
            <div>
              Oracle timestamp:{" "}
              <span className="font-mono">
                {isStableSelected
                  ? "—"
                  : lastTs
                    ? new Date(lastTs * 1000).toLocaleString()
                    : "-"}
              </span>
              {!isStableSelected && (
                <> ({oracleDec} dec)</>
              )}
            </div>
            <div>
              Oracle price:{" "}
              <span className="font-mono">
                {isStableSelected
                  ? "1"
                  : lastPrice !== "-"
                    ? lastPrice
                    : "-"}
              </span>
            </div>
          </div>

          <div className="mt-4 text-xs text-neutral-400">
            * Oracle: on-chain price
          </div>
        </div>

        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-end gap-2 text-xs text-neutral-300">
            <span className="hidden md:inline">Chart source:</span>
            <select
              className="px-2 py-1 rounded-lg bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
              value={chartMode}
              onChange={(e) => setChartMode(e.target.value)}
            >
              <option value="yahoo">History</option>
              <option value="oracle">Oracle live (on-chain)</option>
            </select>
            {chartMode === "yahoo" && (
              <>
                <span className="hidden md:inline">Window:</span>
                <select
                  className="px-2 py-1 rounded-lg bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none"
                  value={yahooWindow}
                  onChange={(e) => setYahooWindow(e.target.value)}
                >
                  <option value="1d">Last 1 day</option>
                  <option value="7d">Last 7 days</option>
                  <option value="1m">Last 1 month</option>
                  <option value="3m">Last 3 months</option>
                  <option value="6m">Last 6 months</option>
                  <option value="1y">Last 1 year</option>
                  <option value="max">Max available</option>
                </select>
              </>
            )}
          </div>

          {chartMode === "yahoo" ? (
            <YahooChart
              initialSymbol={yahooSymbol}
              labelOverride={yahooLabel}
              windowKey={yahooWindow}
            />
          ) : (
            <OracleChart series={oracleSeries} />
          )}
        </div>
      </div>

      {/* Makers */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-neutral-300">
            Select a Maker
          </div>
          <div className="text-xs text-neutral-400">
            {isStableSelected
              ? "Unavailable for stable. Select a maker in Asset view (selection persists for stable transfers)."
              : "Makers with inventory (stable / selected asset) and current Oracle price."}
          </div>
        </div>
        {isStableSelected ? (
          <div className="text-neutral-500 text-sm">
            Current maker:{" "}
            {selMaker ? (
              <span className="font-mono">
                {selMaker.slice(0, 6)}…
                {selMaker.slice(-4)}
              </span>
            ) : (
              "— (pick one while an Asset is selected)"
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-neutral-400">
                  <th className="py-2 px-2">Maker</th>
                  <th className="py-2 px-2">
                    Inventory Stable ({stableSym})
                  </th>
                  <th className="py-2 px-2">
                    Inventory Asset ({assetSym(selAsset)})
                  </th>
                  <th className="py-2 px-2">
                    Oracle Price (USD)
                  </th>
                  <th className="py-2 px-2">Select</th>
                </tr>
              </thead>
              <tbody>
                {makers.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-4 text-neutral-500"
                    >
                      No makers available
                    </td>
                  </tr>
                ) : (
                  makers.map((m) => (
                    <tr
                      key={m.maker}
                      className="border-t border-neutral-800"
                    >
                      <td className="py-2 px-2 font-mono">
                        {m.maker.slice(0, 6)}…
                        {m.maker.slice(-4)}
                      </td>
                      <td className="py-2 px-2">
                        {fmt(m.invStable, stableDec)}
                      </td>
                      <td className="py-2 px-2">
                        {fmt(m.invAsset, assetDec(selAsset))}
                      </td>
                      <td className="py-2 px-2">
                        {lastPrice !== "-" ? lastPrice : "—"}
                      </td>
                      <td className="py-2 px-2">
                        <button
                          className={`px-3 py-1 rounded-lg border ${
                            selMaker === m.maker
                              ? "bg-indigo-600 border-indigo-600"
                              : "bg-neutral-900/50 border-neutral-700 hover:border-indigo-500"
                          }`}
                          onClick={() =>
                            setSelMaker(m.maker)
                          }
                        >
                          {selMaker === m.maker
                            ? "Selected"
                            : "Choose"}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Order panel */}
      <div className="grid md:grid-cols-2 gap-5">
        {/* BUY */}
        <div
          className={`p-4 rounded-2xl border border-white/10 bg-white/5 ${
            isStableSelected ? "opacity-60" : ""
          }`}
        >
          <div className="text-sm text-neutral-300 mb-2">
            Buy from Maker Inventory
          </div>
          <div className="grid gap-2">
            <div className="grid grid-cols-2 gap-2">
              <input
                disabled={isStableSelected}
                className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none disabled:opacity-60"
                placeholder={`Qty ${assetSym(selAsset)}`}
                value={qty}
                onChange={(e) =>
                  setQty(e.target.value)
                }
              />
              <input
                disabled={isStableSelected}
                className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none disabled:opacity-60"
                placeholder={`Max cost (${stableSym})`}
                value={maxCost}
                onChange={(e) =>
                  setMaxCost(e.target.value)
                }
              />
            </div>
            <div className="flex gap-2">
              <button
                disabled={isStableSelected}
                onClick={doQuoteBuy}
                className="px-3 py-2 rounded-xl bg-neutral-800 border border-neutral-700 hover:border-indigo-500 disabled:opacity-60"
              >
                Quote
              </button>
              <button
                disabled={isStableSelected}
                onClick={buyFromMaker}
                className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60"
              >
                Buy
              </button>
            </div>
            {!isStableSelected &&
              quote?.total !== undefined && (
                <div className="text-xs text-neutral-300">
                  total=
                  <span className="font-mono">
                    {fmt(quote.total, stableDec)}
                  </span>{" "}
                  · cost=
                  <span className="font-mono">
                    {fmt(quote.cost, stableDec)}
                  </span>{" "}
                  · fee=
                  <span className="font-mono">
                    {fmt(quote.fee, stableDec)}
                  </span>{" "}
                  · extra=
                  <span className="font-mono">
                    {fmt(quote.extra, stableDec)}
                  </span>
                </div>
              )}
          </div>
        </div>

        {/* SELL */}
        <div
          className={`p-4 rounded-2xl border border-white/10 bg-white/5 ${
            isStableSelected ? "opacity-60" : ""
          }`}
        >
          <div className="text-sm text-neutral-300 mb-2">
            Sell to Maker Inventory
          </div>
          <div className="grid gap-2">
            <div className="grid grid-cols-2 gap-2">
              <input
                disabled={isStableSelected}
                className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none disabled:opacity-60"
                placeholder={`Qty ${assetSym(selAsset)}`}
                value={qty}
                onChange={(e) =>
                  setQty(e.target.value)
                }
              />
              <input
                disabled={isStableSelected}
                className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 focus:border-indigo-500 outline-none disabled:opacity-60"
                placeholder={`Min proceeds (${stableSym})`}
                value={minProceeds}
                onChange={(e) =>
                  setMinProceeds(e.target.value)
                }
              />
            </div>
            <div className="flex gap-2">
              <button
                disabled={isStableSelected}
                onClick={doQuoteSell}
                className="px-3 py-2 rounded-xl bg-neutral-800 border border-neutral-700 hover:border-indigo-500 disabled:opacity-60"
              >
                Quote
              </button>
              <button
                disabled={isStableSelected}
                onClick={sellToMaker}
                className="px-3 py-2 rounded-xl bg-red-800 border border-neutral-700 hover:border-red-500 disabled:opacity-60"
              >
                Sell
              </button>
            </div>
            {!isStableSelected &&
              quote?.payout !== undefined && (
                <div className="text-xs text-neutral-300">
                  payout=
                  <span className="font-mono">
                    {fmt(quote.payout, stableDec)}
                  </span>{" "}
                  · proceeds=
                  <span className="font-mono">
                    {fmt(quote.proceeds, stableDec)}
                  </span>{" "}
                  · fee=
                  <span className="font-mono">
                    {fmt(quote.fee, stableDec)}
                  </span>{" "}
                  · extra=
                  <span className="font-mono">
                    {fmt(quote.extra, stableDec)}
                  </span>
                </div>
              )}
          </div>
        </div>
      </div>

      {/* Footer (status only) */}
      <div className="mt-3 flex items-center justify-end text-sm">
        {status && (
          <div className="text-neutral-300 whitespace-pre-wrap">
            {status}
          </div>
        )}
      </div>
    </section>
  );
}
