import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Contract, ethers } from "ethers";

/**
 * EventRegistryPage.jsx
 *
 * Fixes:
 *  - Reads token events from the *proxy token contracts* (Fund/Equity/Stable) instead of only Market.
 *    In particular, it now captures MintProposed/BurnProposed/Subscription/Redemption* emitted by SecurityTokenBase
 *    on BOTH the stable token AND each asset token address discovered from Market.
 *  - Aligns event ABIs with the actual contracts you attached:
 *      SecurityTokenBase: ReferenceOracleSet, RegistryUpdated, Locked, Unlocked, MintProposed, BurnProposed,
 *                         Subscription, RedemptionRequested, RedemptionPaid, ForcedTransfer
 *      FundToken: FundMetadataUpdated(tuple)
 *      EquityToken: EquityMetadataUpdated(tuple), SplitApplied
 *      StableToken: PegUpdated
 *
 * Keeps previous features:
 *  - Live + historical logs across Market, Tokens (stable + assets), ComplianceRegistry
 *  - Unified feed with filters (source, event type, free-text search), newest first
 *  - Token holders panel inferred from Transfer events within the scanned window
 */
export default function EventRegistryPage({
  provider,
  account, // kept for consistency, not strictly needed
  marketAddress,
  tokenAddress, // stable token (proxy)
  registryAddress, // ComplianceRegistry
  expectedChainId,
  marketDeployBlock = 0,
  defaultBlockLookback = 100_000,
  onError,
}) {
  /* ───────────────────────── ABIs ───────────────────────── */
  const MARKET_ABI = [
    // inventory + assets (best-effort discovery)
    "function getAllAssetIds() view returns (bytes32[])",
    "function fullInventory() view returns (address[] makers,uint256[] makerStable, bytes32[] assetIds, uint256[][] balances)",
    "function assets(bytes32) view returns (address token,string symbolText,uint8 tokenDecimals,bool listed,uint256 minBuyAmount)",
    "function tokenAddress(bytes32) view returns (address)",

    // EVENTS (Market)
    "event AssetListed(bytes32 indexed id, address token, string symbol)",

    "event InventoryStableDeposited(address indexed maker, uint256 amount)",
    "event InventoryStableWithdrawn(address indexed maker, uint256 amount)",
    "event InventoryAssetDeposited(address indexed maker, bytes32 indexed id, uint256 qty)",
    "event InventoryAssetWithdrawn(address indexed maker, bytes32 indexed id, uint256 qty)",
    "event InventoryAssetMinted(address indexed maker, bytes32 indexed id, uint256 qty)",
    "event InventoryAssetBurned(address indexed maker, bytes32 indexed id, uint256 qty)",

    "event BoughtFrom(address indexed user, address indexed maker, bytes32 indexed id, uint256 qty, uint256 price, uint256 costStable, uint256 feeToMaker, uint256 extra)",
    "event SoldTo(address indexed user, address indexed maker, bytes32 indexed id, uint256 qty, uint256 price, uint256 proceedsStable, uint256 feeToMaker, uint256 extra)",

    "event FeesWithdrawn(address to, uint256 amount)",
    "event OracleDebtAccrued(uint256 amountStable, uint256 newDebt)",
    "event OracleDebtSettled(uint256 collectedStable, uint256 newDebt)",
    "event OracleSurchargePerTradeSet(uint256 amountStable)",

    "event MakerMintProposed(bytes32 id, address maker, uint256 netAmount, bytes32 orderId)",
    "event MakerBurnProposed(bytes32 id, address maker, uint256 netAmount, uint256 fee, bytes32 orderId)",
  ];

  // Union of SecurityTokenBase + derived tokens events (matches the Solidity you attached)
  const SECURITY_TOKEN_EVENTS_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",

    // base events
    "event ReferenceOracleSet(address indexed oracle, bytes32 indexed refId)",
    "event RegistryUpdated(address indexed newRegistry)",
    "event Locked(address indexed owner, uint256 amount)",
    "event Unlocked(address indexed owner, uint256 amount)",
    "event MintProposed(address indexed investor, uint256 netAmount, bytes32 orderId)",
    "event BurnProposed(address indexed investor, uint256 shares, bytes32 orderId)",
    "event Subscription(address indexed investor, uint256 gross, uint256 net, bytes32 orderId)",
    "event RedemptionRequested(address indexed investor, uint256 shares, bytes32 orderId)",
    "event RedemptionPaid(address indexed investor, uint256 net, bytes32 orderId)",
    "event ForcedTransfer(address indexed from, address indexed to, uint256 amount)",
    "event IndexUpdated(uint256 oldIndexRay, uint256 newIndexRay, uint64 timestamp)",

    // FundToken
    "event FundMetadataUpdated((string fundName,string managerName,string depositoryName,string shareClass,string isin,string termsUri) meta)",

    // EquityToken
    "event EquityMetadataUpdated((string issuerName,string isin,string shareClass,string termsUri) meta)",
    "event SplitApplied(uint256 ratioBps)",

    // StableToken
    "event PegUpdated(string peg)",
  ];

  const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ];

  // ComplianceRegistry events
  const REGISTRY_ABI = [
    "event WhitelistSet(address indexed account, bool allowed)",
    "event BlacklistSet(address indexed account, bool banned)",
    "event KycExpirySet(address indexed account, uint256 expiry)",
    "event PositionWalletSet(bytes32 indexed investorIdHash, address indexed wallet)",
  ];

  const MARKET_IFACE = useMemo(() => new ethers.Interface(MARKET_ABI), []);
  const TOKEN_IFACE = useMemo(() => new ethers.Interface(SECURITY_TOKEN_EVENTS_ABI), []);
  const ERC20_IFACE = useMemo(() => new ethers.Interface(ERC20_ABI), []);
  const REGISTRY_IFACE = useMemo(() => new ethers.Interface(REGISTRY_ABI), []);

  const TRANSFER_TOPIC = useMemo(() => ethers.id("Transfer(address,address,uint256)"), []);

  const market = useMemo(() => {
    if (!provider || !marketAddress) return null;
    return new Contract(marketAddress, MARKET_ABI, provider);
  }, [provider, marketAddress]);

  const stable = useMemo(() => {
    if (!provider || !tokenAddress) return null;
    return new Contract(tokenAddress, SECURITY_TOKEN_EVENTS_ABI, provider);
  }, [provider, tokenAddress]);

  const registry = useMemo(() => {
    if (!provider || !registryAddress) return null;
    return new Contract(registryAddress, REGISTRY_ABI, provider);
  }, [provider, registryAddress]);

  /* ───────────────────────── Helpers ───────────────────────── */
  const isBigInt = (v) => typeof v === "bigint";

  const hexLower = (x) => {
    try {
      return ethers.hexlify(x).toLowerCase();
    } catch {
      return String(x ?? "").toLowerCase();
    }
  };

  const onlyNamedArgs = (args) =>
    Object.fromEntries(Object.entries(args || {}).filter(([k]) => isNaN(Number(k))));

  function shortHex(s, left = 6, right = 6) {
    if (!s) return "—";
    const x = String(s);
    if (x.length <= 2 + left + right) return x;
    if (x.startsWith("0x")) return `${x.slice(0, 2 + left)}…${x.slice(-right)}`;
    return `${x.slice(0, left)}…${x.slice(-right)}`;
  }

  async function tryDeploymentBlock(contract) {
    try {
      const tx = await contract.deploymentTransaction?.();
      if (tx && tx.blockNumber != null) return Number(tx.blockNumber);
    } catch {}
    return null;
  }

  async function queryFilterChunked(contract, filter, from, to, step = 5000) {
    const out = [];
    let start = from;
    while (start <= to) {
      const end = Math.min(start + step - 1, to);
      try {
        const logs = await contract.queryFilter(filter, start, end);
        out.push(...logs);
      } catch (e) {
        if (step > 256) {
          const partial = await queryFilterChunked(contract, filter, start, end, Math.floor(step / 2));
          out.push(...partial);
        } else {
          throw e;
        }
      }
      start = end + 1;
    }
    return out;
  }

  const evtKey = (evt) => {
    const txh = evt?.log?.transactionHash ?? evt?.transactionHash ?? evt?.hash ?? "";
    const idx = evt?.log?.index ?? evt?.index ?? evt?.logIndex ?? 0;
    return `${txh}:${idx}`;
  };

  const evtBlock = (evt) => evt?.blockNumber ?? evt?.log?.blockNumber ?? 0;

  function buildArgsList(parsed, prettyFn, idHexForDec) {
    try {
      const inputs = parsed?.fragment?.inputs || [];
      const list = [];
      for (let i = 0; i < inputs.length; i++) {
        const inp = inputs[i];
        const name = inp?.name && inp.name !== "" ? inp.name : `arg${i}`;
        const type = String(inp?.type || "");
        const raw = parsed.args?.[i];

        let value = raw;
        if (prettyFn) value = prettyFn(name, raw, idHexForDec, type);

        // For tuples/structs (metadata), ethers gives Result objects; make them readable
        if (value && typeof value === "object" && !Array.isArray(value) && !isBigInt(value)) {
          try {
            const named = onlyNamedArgs(value);
            if (Object.keys(named).length > 0) value = named;
          } catch {}
        }

        list.push({ index: i, name, type, value, raw });
      }
      return list;
    } catch {
      return [];
    }
  }

  function signatureString(name, argsList) {
    const parts = argsList.map(({ name, value }) => {
      if (value && typeof value === "object") return `${name}=${JSON.stringify(value)}`;
      return `${name}=${value}`;
    });
    return `${name}(${parts.join(", ")})`;
  }

  function makePrettyValue(stableDecimals, stableSymbol, decMap) {
    return (k, v, idHex, inputType = "") => {
      const type = String(inputType || "").toLowerCase();

      if (type.startsWith("address")) {
        try {
          return ethers.getAddress(String(v));
        } catch {
          return String(v);
        }
      }

      if (isBigInt(v)) {
        const lower = k.toLowerCase();
        const isStableVal = /(amount|gross|net|price|fee|proceeds|cost|debt|paid|surcharge|shares|ratiobps|expiry)/.test(
          lower
        );

        // default pretty format for uints
        if (isStableVal && !/qty/.test(lower)) {
          // NOTE: This is just pretty-printing; amounts may refer to asset shares (18) on Mint/Burn,
          // but keeping the same behavior as before: treat "amount/net/gross/fee/etc." as stable units.
          try {
            return `${ethers.formatUnits(v, stableDecimals)} ${stableSymbol}`;
          } catch {
            return v.toString();
          }
        }

        if (/qty/.test(lower)) {
          const aDec = idHex && decMap?.[idHex] != null ? decMap[idHex] : 18;
          try {
            return `${ethers.formatUnits(v, aDec)}`;
          } catch {
            return v.toString();
          }
        }

        return v.toString();
      }

      const s = String(v ?? "");
      if (s.startsWith("0x") && s.length > 18) return shortHex(s);
      return s;
    };
  }

  /* ───────────────────────── State ───────────────────────── */
  const [status, setStatus] = useState("");

  // stable meta
  const [stableSymbol, setStableSymbol] = useState("STABLE");
  const [stableDecimals, setStableDecimals] = useState(6);

  // assets meta
  const [assetMetas, setAssetMetas] = useState([]); // {id, symbol, decimals, token}
  const decMap = useMemo(
    () => Object.fromEntries(assetMetas.map((a) => [hexLower(a.id), a.decimals])),
    [assetMetas]
  );
  const tokenDecMap = useMemo(
    () =>
      Object.fromEntries(
        assetMetas
          .filter((a) => a.token && a.token !== ethers.ZeroAddress)
          .map((a) => [hexLower(a.token), a.decimals])
      ),
    [assetMetas]
  );
  const tokenSymMap = useMemo(
    () =>
      Object.fromEntries(
        assetMetas
          .filter((a) => a.token && a.token !== ethers.ZeroAddress)
          .map((a) => [hexLower(a.token), a.symbol])
      ),
    [assetMetas]
  );

  const pretty = useMemo(() => makePrettyValue(stableDecimals, stableSymbol, decMap), [
    stableDecimals,
    stableSymbol,
    decMap,
  ]);

  // logs
  const [rows, setRows] = useState([]);
  const known = useRef(new Set());

  // filters / UI
  const [srcFilter, setSrcFilter] = useState("ALL"); // ALL | PLATFORM | STABLE | ASSET | REGISTRY
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(true);

  // balances: tokenAddrLower -> { holderLower -> bigint }
  const [balances, setBalances] = useState({});

  // token holders selection: "stable" or "asset:<idLower>"
  const [selectedTokenChoice, setSelectedTokenChoice] = useState("");

  // per-token watchers (stable + assets)
  const liveWatchers = useRef(new Map()); // addrLower -> unsubscribe fn

  // network warning
  useEffect(() => {
    (async () => {
      if (!provider || !expectedChainId) return;
      try {
        const net = await provider.getNetwork();
        const got = Number(net.chainId);
        if (Number(expectedChainId) !== got) {
          setStatus(`⚠️ Wrong network: connected ${got}, expected ${expectedChainId}`);
        }
      } catch {}
    })();
  }, [provider, expectedChainId]);

  /* ───────── stable meta ───────── */
  useEffect(() => {
    (async () => {
      if (!stable) return;
      try {
        const [sym, dec] = await Promise.all([
          stable.symbol().catch(() => "STABLE"),
          stable.decimals().catch(() => 6),
        ]);
        setStableSymbol(sym || "STABLE");
        setStableDecimals(Number(dec ?? 6));
      } catch {}
    })();
  }, [stable]);

  /* ───────── load assets (NEW-aware) ───────── */
  useEffect(() => {
    (async () => {
      if (!market || !provider) return;
      try {
        let ids = [];
        // prefer getAllAssetIds()
        try {
          ids = await market.getAllAssetIds();
        } catch {
          ids = [];
        }
        // fallback fullInventory()
        if (!ids || ids.length === 0) {
          try {
            const inv = await market.fullInventory();
            ids = inv.assetIds ?? inv[2] ?? [];
          } catch {
            ids = [];
          }
        }

        const uniq = Array.from(new Set((ids || []).map(hexLower)));
        const metas = await Promise.all(
          uniq.map(async (id) => {
            let symbol = "—";
            let decimals = 18;
            let tokenAddr = ethers.ZeroAddress;

            // try assets(id)
            try {
              const info = await market.assets(id);
              symbol = info.symbolText ?? info[1] ?? symbol;
              decimals = Number(info.tokenDecimals ?? info[2] ?? decimals);
              const tMaybe = info.token ?? info[0];
              if (tMaybe && tMaybe !== ethers.ZeroAddress) tokenAddr = tMaybe;
            } catch {}

            // try tokenAddress(id)
            try {
              const taddr = await market.tokenAddress(id);
              if (taddr && taddr !== ethers.ZeroAddress) tokenAddr = taddr;
            } catch {}

            // if tokenAddr exists but symbol/decimals missing, ask ERC20
            if (tokenAddr && tokenAddr !== ethers.ZeroAddress) {
              try {
                const erc = new Contract(tokenAddr, ERC20_ABI, provider);
                const [sym, dec] = await Promise.all([
                  erc.symbol().catch(() => symbol),
                  erc.decimals().catch(() => decimals),
                ]);
                if (sym && sym !== "—") symbol = sym;
                if (dec != null) decimals = Number(dec);
              } catch {}
            }

            return { id, symbol, decimals, token: tokenAddr };
          })
        );

        setAssetMetas((prev) => {
          const byId = new Map(prev.map((a) => [hexLower(a.id), a]));
          for (const m of metas) {
            const k = hexLower(m.id);
            const old = byId.get(k);
            if (!old) byId.set(k, m);
            else {
              byId.set(k, {
                ...old,
                ...m,
                symbol: m.symbol !== "—" ? m.symbol : old.symbol,
                decimals: m.decimals || old.decimals,
                token: m.token && m.token !== ethers.ZeroAddress ? m.token : old.token,
              });
            }
          }
          return Array.from(byId.values());
        });
      } catch {}
    })();
  }, [market, provider]);

  /* ───────── default selection for holders card ───────── */
  useEffect(() => {
    if (selectedTokenChoice) return;
    if (assetMetas.length > 0) setSelectedTokenChoice(`asset:${hexLower(assetMetas[0].id)}`);
    else if (tokenAddress) setSelectedTokenChoice("stable");
  }, [assetMetas, tokenAddress, selectedTokenChoice]);

  /* ───────── ensure per-token watcher (stable + asset proxies) ───────── */
  function ensureTokenWatcher(tokenAddr, source) {
    if (!provider || !tokenAddr || tokenAddr === ethers.ZeroAddress) return;
    const addrL = hexLower(tokenAddr);
    if (liveWatchers.current.has(addrL)) return;

    const filter = { address: tokenAddr }; // all logs from this token (includes Transfer + MintProposed etc.)
    const onAny = (log) => {
      if (!live) return;
      pushEvt({ source, evt: log });
    };

    provider.on(filter, onAny);
    const off = () => provider.off(filter, onAny);
    liveWatchers.current.set(addrL, off);
  }

  /* ───────── upsert asset from AssetListed ───────── */
  async function upsertAssetFromListed(idHex, tokenAddr, symbol) {
    try {
      const idL = hexLower(idHex);
      let decimals = 18;
      try {
        const erc = new Contract(tokenAddr, ERC20_ABI, provider);
        decimals = Number(await erc.decimals().catch(() => 18));
      } catch {}
      setAssetMetas((prev) => {
        const byId = new Map(prev.map((a) => [hexLower(a.id), a]));
        const old = byId.get(idL);
        const merged = {
          id: idHex,
          token: tokenAddr,
          symbol: symbol || old?.symbol || "—",
          decimals: decimals || old?.decimals || 18,
        };
        byId.set(idL, { ...(old || {}), ...merged });
        return Array.from(byId.values());
      });
      ensureTokenWatcher(tokenAddr, "ASSET");
    } catch {}
  }

  /* ───────────────────────── Core: push event ───────────────────────── */
  async function pushEvt({ source, evt }) {
    try {
      const key = evtKey(evt);
      if (known.current.has(key)) return;
      known.current.add(key);

      const log = evt?.log ?? evt;
      const top0 = log?.topics?.[0];

      let parsed = null;
      let name = "Unknown";

      // 1) Transfer
      if (top0 && top0 === TRANSFER_TOPIC) {
        try {
          parsed = ERC20_IFACE.parseLog(log);
          name = parsed?.name || "Transfer";
        } catch {}
      }

      // 2) Market / Registry / Token (non-Transfer)
      if (!parsed) {
        try {
          let iface;
          if (source === "PLATFORM") iface = MARKET_IFACE;
          else if (source === "REGISTRY") iface = REGISTRY_IFACE;
          else iface = TOKEN_IFACE; // STABLE or ASSET token logs
          parsed = iface.parseLog(log);
          name = parsed?.name || "Unknown";
        } catch {}
      }

      if (!parsed) return;

      // AssetListed => update metas + watcher
      if (source === "PLATFORM" && name === "AssetListed") {
        const named = onlyNamedArgs(parsed.args || {});
        const idHex = named.id ?? named[0];
        const tokenAddr = named.token ?? named[1];
        const sym = named.symbol ?? named[2];
        if (idHex && tokenAddr) upsertAssetFromListed(idHex, tokenAddr, sym);
      }

      // Update balances if Transfer
      const ZERO_L = hexLower(ethers.ZeroAddress);
      if (name === "Transfer") {
        try {
          const tokenAddr = ethers.getAddress(log.address);
          const tokenKey = hexLower(tokenAddr);
          const fromAddr = ethers.getAddress(parsed.args.from);
          const toAddr = ethers.getAddress(parsed.args.to);
          const rawVal = parsed.args.value;
          const val = isBigInt(rawVal) ? rawVal : BigInt(rawVal);

          if (val !== 0n) {
            const fromKey = hexLower(fromAddr);
            const toKey = hexLower(toAddr);

            setBalances((prev) => {
              const prevForToken = prev[tokenKey] || {};
              const nextForToken = { ...prevForToken };

              if (fromKey !== ZERO_L) {
                const prevFrom = prevForToken[fromKey] != null ? BigInt(prevForToken[fromKey]) : 0n;
                const newFrom = prevFrom - val;
                if (newFrom === 0n) delete nextForToken[fromKey];
                else nextForToken[fromKey] = newFrom;
              }

              if (toKey !== ZERO_L) {
                const prevTo = prevForToken[toKey] != null ? BigInt(prevForToken[toKey]) : 0n;
                const newTo = prevTo + val;
                if (newTo === 0n) delete nextForToken[toKey];
                else nextForToken[toKey] = newTo;
              }

              return { ...prev, [tokenKey]: nextForToken };
            });
          }
        } catch {
          // ignore
        }
      }

      // Build pretty args list (Transfer gets token-specific units)
      let argsList = buildArgsList(parsed, (k, v, idH, t) => pretty(k, v, idH, t));
      if (name === "Transfer") {
        const addrL = hexLower(log.address);
        const isStable = tokenAddress && addrL === hexLower(tokenAddress);
        const dec = isStable ? stableDecimals : tokenDecMap[addrL] ?? 18;
        const sym = isStable ? stableSymbol : tokenSymMap[addrL] ?? "";
        argsList = argsList.map((a) => {
          if (a.name === "value" && isBigInt(a.raw)) {
            try {
              return { ...a, value: `${ethers.formatUnits(a.raw, dec)}${sym ? ` ${sym}` : ""}` };
            } catch {
              return a;
            }
          }
          return a;
        });
      }
      // For token events (MintProposed/BurnProposed/Subscription/Redemption/etc.), format uints in the token's own units
      if (name !== "Transfer" && (source === "STABLE" || source === "ASSET")) {
        const addrL2 = hexLower(log.address);
        const isStable2 = tokenAddress && addrL2 === hexLower(tokenAddress);
        const dec2 = isStable2 ? stableDecimals : tokenDecMap[addrL2] ?? 18;
        const sym2 = isStable2 ? stableSymbol : tokenSymMap[addrL2] ?? "";
        argsList = argsList.map((a) => {
          if (isBigInt(a.raw)) {
            try {
              return { ...a, value: `${ethers.formatUnits(a.raw, dec2)}${sym2 ? ` ${sym2}` : ""}` };
            } catch {
              return a;
            }
          }
          return a;
        });
      }



      const signature = signatureString(name, argsList);

      const blockNumber = evtBlock(evt);
      const txHash = log.transactionHash || "";

      // label
      const addrL = hexLower(log.address);
      const sym = tokenSymMap[addrL];
      let sourceLabel = source;
      if (source === "ASSET") sourceLabel = sym ? `ASSET(${sym})` : `ASSET(${shortHex(log.address)})`;
      if (source === "STABLE") sourceLabel = `STABLE(${stableSymbol})`;

      // from/to for transfer
      let transferFrom = "";
      let transferTo = "";
      if (name === "Transfer") {
        try {
          transferFrom = ethers.getAddress(parsed.args.from);
          transferTo = ethers.getAddress(parsed.args.to);
        } catch {}
      }

      let logAddress = "";
      try {
        logAddress = ethers.getAddress(log.address);
      } catch {
        logAddress = log.address;
      }

      // Base row immediately
      const baseRow = {
        key,
        source,
        sourceLabel,
        name,
        signature,
        txHash,
        logIndex: log.index ?? 0,
        blockNumber,
        timestamp: undefined,
        txFrom: "",
        txTo: "",
        transferFrom,
        transferTo,
        logAddress,
      };

      setRows((prev) => (prev.some((r) => r.key === baseRow.key) ? prev : [...prev, baseRow]));

      // Enrich async
      try {
        const [block, tx] = await Promise.all([
          provider.getBlock(blockNumber).catch(() => null),
          provider.getTransaction(txHash).catch(() => null),
        ]);
        if (block || tx) {
          setRows((prev) =>
            prev.map((r) =>
              r.key === baseRow.key
                ? {
                    ...r,
                    timestamp: block?.timestamp ? new Date(block.timestamp * 1000).toISOString() : r.timestamp,
                    txFrom: tx?.from || r.txFrom,
                    txTo: tx?.to || r.txTo,
                  }
                : r
            )
          );
        }
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
  }

  /* ───────────────────────── Live listeners ───────────────────────── */
  useEffect(() => {
    if (!provider) return;
    const offs = [];

    // MARKET events
    if (market) {
      const events = [
        "AssetListed",
        "InventoryStableDeposited",
        "InventoryStableWithdrawn",
        "InventoryAssetDeposited",
        "InventoryAssetWithdrawn",
        "InventoryAssetMinted",
        "InventoryAssetBurned",
        "BoughtFrom",
        "SoldTo",
        "FeesWithdrawn",
        "OracleDebtAccrued",
        "OracleDebtSettled",
        "OracleSurchargePerTradeSet",
        "MakerMintProposed",
        "MakerBurnProposed",
      ];
      for (const ev of events) {
        const h = (...args) => {
          const evt = args[args.length - 1];
          if (!live) return;
          pushEvt({ source: "PLATFORM", evt });
        };
        market.on(ev, h);
        offs.push(() => market.off(ev, h));
      }
    }

    // STABLE token watcher (all logs)
    if (provider && tokenAddress) {
      ensureTokenWatcher(tokenAddress, "STABLE");
    }

    // ASSET token watchers (all logs)
    for (const a of assetMetas) {
      if (a.token && a.token !== ethers.ZeroAddress) ensureTokenWatcher(a.token, "ASSET");
    }

    // REGISTRY events
    if (registry) {
      const events = ["WhitelistSet", "BlacklistSet", "KycExpirySet", "PositionWalletSet"];
      for (const ev of events) {
        const h = (...args) => {
          const evt = args[args.length - 1];
          if (!live) return;
          pushEvt({ source: "REGISTRY", evt });
        };
        registry.on(ev, h);
        offs.push(() => registry.off(ev, h));
      }
    }

    return () => {
      offs.forEach((f) => f());
      for (const off of liveWatchers.current.values()) {
        try {
          off();
        } catch {}
      }
      liveWatchers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, market, tokenAddress, assetMetas, live, registry, stableSymbol]);

  /* ───────────────────────── History loading ───────────────────────── */
  const loadHistory = useCallback(async () => {
    if (!provider) return;
    setStatus("Loading history…");
    try {
      const tip = await provider.getBlockNumber();

      // hint from deploy block, otherwise lookback
      const defaultFrom = Math.max(0, tip - Number(defaultBlockLookback || 0));
      const fromHint = Number(marketDeployBlock || 0);
      const baseFrom = Number.isFinite(fromHint) && fromHint > 0 ? fromHint : defaultFrom;

      // MARKET
      if (market) {
        const fromM = (await tryDeploymentBlock(market)) ?? baseFrom;
        const filters = [
          market.filters.AssetListed(),
          market.filters.InventoryStableDeposited(),
          market.filters.InventoryStableWithdrawn(),
          market.filters.InventoryAssetDeposited(),
          market.filters.InventoryAssetWithdrawn(),
          market.filters.InventoryAssetMinted(),
          market.filters.InventoryAssetBurned(),
          market.filters.BoughtFrom(),
          market.filters.SoldTo(),
          market.filters.FeesWithdrawn(),
          market.filters.OracleDebtAccrued(),
          market.filters.OracleDebtSettled(),
          market.filters.OracleSurchargePerTradeSet(),
          market.filters.MakerMintProposed(),
          market.filters.MakerBurnProposed(),
        ];
        for (const f of filters) {
          const logs = await queryFilterChunked(market, f, fromM, tip, 5000);
          for (const evt of logs) await pushEvt({ source: "PLATFORM", evt });
        }
      }

      // STABLE token history (all logs, includes MintProposed etc.)
      if (tokenAddress) {
        const fromT = (stable ? await tryDeploymentBlock(stable) : null) ?? baseFrom;
        const allLogs = await provider.getLogs({ address: tokenAddress, fromBlock: fromT, toBlock: tip });
        for (const log of allLogs) await pushEvt({ source: "STABLE", evt: log });
      }

      // ASSET token history (all logs for each token proxy)
      if (assetMetas.length > 0) {
        const fromA = baseFrom;
        for (const a of assetMetas) {
          if (!a.token || a.token === ethers.ZeroAddress) continue;
          const logs = await provider.getLogs({ address: a.token, fromBlock: fromA, toBlock: tip });
          for (const log of logs) await pushEvt({ source: "ASSET", evt: log });
        }
      }

      // REGISTRY history
      if (registry && registryAddress) {
        const fromR = (await tryDeploymentBlock(registry)) ?? baseFrom;
        const filters = [
          registry.filters.WhitelistSet(),
          registry.filters.BlacklistSet(),
          registry.filters.KycExpirySet(),
          registry.filters.PositionWalletSet(),
        ];
        for (const f of filters) {
          const logs = await queryFilterChunked(registry, f, fromR, tip, 5000);
          for (const evt of logs) await pushEvt({ source: "REGISTRY", evt });
        }
      }

      setStatus("✅ History loaded.");
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus(`❌ Failed to load history: ${msg}`);
      onError && onError(msg);
    }
  }, [
    provider,
    market,
    stable,
    tokenAddress,
    assetMetas,
    registry,
    registryAddress,
    marketDeployBlock,
    defaultBlockLookback,
    onError,
  ]);

  // auto-load
  useEffect(() => {
    if (!provider) return;
    known.current = new Set();
    setRows([]);
    setBalances({});
    loadHistory();
  }, [provider, marketAddress, tokenAddress, registryAddress, loadHistory]);

  /* ───────────────────────── Filters (newest first) ───────────────────────── */
  const filteredSorted = useMemo(() => {
    const base = rows.filter((r) => {
      if (srcFilter !== "ALL") {
        if (srcFilter === "PLATFORM") {
          if (r.source !== "PLATFORM") return false;
        } else if (srcFilter === "STABLE") {
          if (r.source !== "STABLE") return false;
        } else if (srcFilter === "ASSET") {
          if (r.source !== "ASSET") return false;
        } else if (srcFilter === "REGISTRY") {
          if (r.source !== "REGISTRY") return false;
        }
      }

      if (typeFilter !== "ALL" && r.name !== typeFilter) return false;

      if (!search) return true;
      const s = search.toLowerCase();
      const blob = JSON.stringify(r).toLowerCase();
      return blob.includes(s);
    });

    base.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    return base;
  }, [rows, srcFilter, typeFilter, search]);

  const allTypes = useMemo(() => {
    const set = new Set(rows.map((r) => r.name));
    return ["ALL", ...Array.from(set).sort()];
  }, [rows]);

  /* ───────────────────────── Token holders card ───────────────────────── */
  const selectedTokenInfo = useMemo(() => {
    if (!selectedTokenChoice) return null;

    if (selectedTokenChoice === "stable") {
      if (!tokenAddress) return null;
      try {
        return {
          key: "stable",
          address: ethers.getAddress(tokenAddress),
          symbol: stableSymbol,
          decimals: stableDecimals,
          label: `Stable (${stableSymbol})`,
        };
      } catch {
        return null;
      }
    }

    if (selectedTokenChoice.startsWith("asset:")) {
      const idHexLower = selectedTokenChoice.slice("asset:".length);
      const meta = assetMetas.find((a) => hexLower(a.id) === idHexLower);
      if (!meta || !meta.token || meta.token === ethers.ZeroAddress) return null;
      try {
        return {
          key: `asset:${idHexLower}`,
          address: ethers.getAddress(meta.token),
          symbol: meta.symbol || "ASSET",
          decimals: meta.decimals || 18,
          label: `Asset ${meta.symbol || shortHex(meta.id)}`,
        };
      } catch {
        return null;
      }
    }

    return null;
  }, [selectedTokenChoice, tokenAddress, stableSymbol, stableDecimals, assetMetas]);

  const holderList = useMemo(() => {
    if (!selectedTokenInfo) return [];
    const tokenKey = hexLower(selectedTokenInfo.address);
    const tokenBalances = balances[tokenKey] || {};

    const entries = Object.entries(tokenBalances)
      .filter(([_, bal]) => {
        try {
          return BigInt(bal) > 0n;
        } catch {
          return false;
        }
      })
      .map(([addrLower, bal]) => {
        const bi = BigInt(bal);
        let formatted = "";
        try {
          formatted = ethers.formatUnits(bi, selectedTokenInfo.decimals);
        } catch {
          formatted = bi.toString();
        }
        let checksum = addrLower;
        try {
          checksum = ethers.getAddress(addrLower);
        } catch {}
        return { address: checksum, balanceRaw: bi, balanceFormatted: formatted };
      });

    entries.sort((a, b) => (b.balanceRaw > a.balanceRaw ? 1 : b.balanceRaw < a.balanceRaw ? -1 : 0));
    return entries;
  }, [balances, selectedTokenInfo]);

  /* ───────────────────────── UI ───────────────────────── */
  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl md:text-2xl bg-clip-text text-transparent bg-gradient-to-r from-indigo-300 via-fuchsia-300 to-cyan-300">
          Registry • On-chain Logs
        </h2>
        <div className="text-xs text-neutral-400">{status}</div>
      </div>

      {/* Token Holders */}
      <div className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-neutral-100">Token Holders</h3>
            <p className="text-xs text-neutral-400">
              Select stable or an asset to see all wallets with balance &gt; 0 (built from Transfer events within the scanned window).
            </p>
          </div>

          <select
            className="px-3 py-2 rounded-xl bg-neutral-950/70 border border-neutral-700 text-sm"
            value={selectedTokenChoice}
            onChange={(e) => setSelectedTokenChoice(e.target.value)}
          >
            {assetMetas.map((a) => (
              <option key={hexLower(a.id)} value={`asset:${hexLower(a.id)}`}>
                Asset {a.symbol || shortHex(a.id)}
              </option>
            ))}
            {tokenAddress && <option value="stable">Stable ({stableSymbol})</option>}
          </select>
        </div>

        {!selectedTokenInfo ? (
          <div className="text-sm text-neutral-400">No token selected or token address not available.</div>
        ) : holderList.length === 0 ? (
          <div className="text-sm text-neutral-400">No holders with positive balance found for {selectedTokenInfo.symbol}.</div>
        ) : (
          <div className="rounded-lg border border-neutral-800 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 text-[12px] text-neutral-300">
              <span>
                {holderList.length} holders · Token: <span className="font-mono">{selectedTokenInfo.symbol}</span>
              </span>
              <span className="text-neutral-500 font-mono">{shortHex(selectedTokenInfo.address)}</span>
            </div>
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-[12px]">
                <thead className="bg-neutral-900/70 text-neutral-300">
                  <tr className="text-left">
                    <th className="py-2 px-3">Address</th>
                    <th className="py-2 px-3 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {holderList.map((h) => (
                    <tr key={h.address} className="border-t border-neutral-800 hover:bg-neutral-900/60">
                      <td className="py-2 px-3 font-mono text-left">{h.address}</td>
                      <td className="py-2 px-3 text-right font-mono">{h.balanceFormatted}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="grid md:grid-cols-5 gap-2">
        <select
          className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700"
          value={srcFilter}
          onChange={(e) => setSrcFilter(e.target.value)}
        >
          <option value="ALL">Source: ALL</option>
          <option value="PLATFORM">Source: PLATFORM</option>
          <option value="STABLE">Source: STABLE</option>
          <option value="ASSET">Source: ASSET</option>
          <option value="REGISTRY">Source: REGISTRY</option>
        </select>

        <select
          className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          {allTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <input
          className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700"
          placeholder="Search address / id / orderId / tx / amount…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="flex items-center gap-2 col-span-2 md:col-span-2">
          <button
            onClick={loadHistory}
            className="px-3 py-2 rounded-xl bg-neutral-900/60 border border-neutral-700 hover:border-indigo-500"
            type="button"
          >
            Reload history
          </button>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            Live
          </label>
        </div>
      </div>

      {/* Logs table */}
      <div className="rounded-xl bg-neutral-900/40 border border-neutral-700 p-0 overflow-hidden">
        <div className="p-3 border-b border-neutral-700 text-sm text-neutral-300">
          {filteredSorted.length} events (newest first)
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-neutral-300">
              <tr className="text-left">
                <th className="py-2 px-3">Block / Time</th>
                <th className="py-2 px-3">Source</th>
                <th className="py-2 px-3">Event</th>
                <th className="py-2 px-3">Sender</th>
                <th className="py-2 px-3">Tx</th>
              </tr>
            </thead>
            <tbody>
              {filteredSorted.length === 0 ? (
                <tr>
                  <td className="py-3 px-3 text-neutral-400" colSpan={5}>
                    No events.
                  </td>
                </tr>
              ) : (
                filteredSorted.map((r) => (
                  <tr key={r.key} className="border-t border-neutral-800 align-top">
                    <td className="py-2 px-3 whitespace-nowrap">
                      <div className="font-mono tabular-nums">{r.blockNumber}</div>
                      <div className="text-[11px] text-neutral-400">
                        {r.timestamp ? new Date(r.timestamp).toLocaleString() : "—"}
                      </div>
                    </td>
                    <td className="py-2 px-3">{r.sourceLabel || r.source}</td>
                    <td className="py-2 px-3">
                      <div className="font-mono break-words">{r.signature}</div>
                    </td>
                    <td className="py-2 px-3 font-mono">{r.txFrom || "—"}</td>
                    <td className="py-2 px-3 font-mono">
                      <div title={r.txHash}>{r.txHash || "—"}</div>
                      <div className="text-[11px] text-neutral-500">idx #{r.logIndex}</div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-[11px] text-neutral-500">
        Notes: balances are inferred from Transfer events within the scanned window. If you need a full holders snapshot
        from genesis, increase <span className="font-mono">defaultBlockLookback</span> or set{" "}
        <span className="font-mono">marketDeployBlock</span> to the real deployment block.
      </div>
    </section>
  );
}