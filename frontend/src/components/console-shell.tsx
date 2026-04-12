"use client";

import Link from "next/link";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useState,
} from "react";

type View = "overview" | "issuer" | "investor";

type SnapshotAllocation = {
  id: string;
  account: string;
  assetAmount: string;
  payoutAmount: string;
};

type SnapshotRecord = {
  id: number;
  label: string;
  payoutToken: string;
  snapshotTimestamp: number;
  metadataURI: string;
  root: string;
  allocations: Array<{
    account: string;
    assetAmount: string;
    payoutAmount: string;
    leaf: string;
    proof: string[];
  }>;
};

type DistributionRecord = {
  distributionId: number;
  snapshotId: number;
  root: string;
  txHash: string;
};

const deployment = {
  compliance: "0xC6234816f981C0bC8E8FB48Ba6FF9fb864212f3c",
  asset: "0x4372222b90612bCD37e09452052DE5b44DfBC10C",
  distribution: "0xE6ab32D718AFe5932c7805c231AD35A6133Aa383",
  redemption: "0x367a53A6728771E66f9e430932D7FA75B446fA0a",
  oracle: "0xD22602E3114b754a86583ce2d48Cce05d2becd78",
};

const contractLabels: Record<string, string> = {
  compliance: "Compliance Registry",
  asset: "Asset Token",
  distribution: "Distribution Module",
  redemption: "Redemption Module",
  oracle: "Oracle Router",
};

const defaultAddressA = "0x1111111111111111111111111111111111111111";
const defaultAddressB = "0x2222222222222222222222222222222222222222";

function safeStringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function shortAddress(value: string) {
  if (!value || value.length < 12) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function makeAllocation(overrides: Partial<SnapshotAllocation> = {}): SnapshotAllocation {
  return {
    id: crypto.randomUUID(),
    account: "",
    assetAmount: "",
    payoutAmount: "",
    ...overrides,
  };
}

function nowStamp() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ConsoleShell() {
  const [view, setView] = useState<View>("overview");
  const [apiBase, setApiBase] = useState("http://localhost:4010");
  const [adminKey, setAdminKey] = useState("");
  const [healthOutput, setHealthOutput] = useState("Waiting for backend...");
  const [healthLive, setHealthLive] = useState(false);
  const [activity, setActivity] = useState<Array<{ id: string; time: string; message: string }>>([]);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [distributions, setDistributions] = useState<DistributionRecord[]>([]);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [oracleOutput, setOracleOutput] = useState("No quote requested yet.");
  const [lookupOutput, setLookupOutput] = useState("No investor loaded.");
  const [claimOutput, setClaimOutput] = useState("No claim built yet.");
  const [redemptionOutput, setRedemptionOutput] = useState("No request loaded.");

  const [investorForm, setInvestorForm] = useState({
    account: defaultAddressA,
    approved: true,
    accredited: true,
    frozen: false,
    tier: 3,
    jurisdiction: 344,
    expiry: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });
  const [mintForm, setMintForm] = useState({
    to: defaultAddressA,
    amount: "100000000000000000000",
  });
  const [snapshotForm, setSnapshotForm] = useState({
    label: "April servicing window",
    payoutToken: "0x0000000000000000000000000000000000000000",
    snapshotTimestamp: Math.floor(Date.now() / 1000),
    metadataURI: "ipfs://assetflow-window-1",
    allocations: [
      makeAllocation({
        account: defaultAddressA,
        assetAmount: "60000000000000000000",
        payoutAmount: "60",
      }),
      makeAllocation({
        account: defaultAddressB,
        assetAmount: "40000000000000000000",
        payoutAmount: "40",
      }),
    ],
  });
  const [publishForm, setPublishForm] = useState({
    snapshotId: "0",
    nativeValue: "100",
  });
  const [oracleForm, setOracleForm] = useState({
    asset: deployment.asset,
    assetAmount: "1000000000000000000",
    feeBps: "50",
    haircutBps: "150",
  });
  const [lookupAccount, setLookupAccount] = useState(defaultAddressA);
  const [claimForm, setClaimForm] = useState({
    snapshotId: "0",
    account: defaultAddressA,
  });
  const [redemptionForm, setRedemptionForm] = useState({
    requestId: "0",
    reason: "manual review required",
  });

  const deferredActivity = useDeferredValue(activity);

  function pushActivity(message: string) {
    setActivity((current) => [
      { id: crypto.randomUUID(), time: nowStamp(), message },
      ...current,
    ].slice(0, 7));
  }

  function setBusy(key: string, next: boolean) {
    setPending((current) => ({ ...current, [key]: next }));
  }

  async function withAction(key: string, fn: () => Promise<unknown>) {
    setBusy(key, true);
    try {
      return await fn();
    } finally {
      setBusy(key, false);
    }
  }

  async function fetchJson(path: string, init?: RequestInit) {
    const response = await fetch(`${apiBase.replace(/\/$/, "")}${path}`, init);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new Error(payload?.error || payload?.message || `Request failed with ${response.status}`);
    }

    return payload;
  }

  function authHeaders(json = true) {
    const headers = new Headers();
    if (json) {
      headers.set("Content-Type", "application/json");
    }
    if (adminKey.trim()) {
      headers.set("x-admin-key", adminKey.trim());
    }
    return headers;
  }

  async function refreshHealth() {
    await withAction("health", async () => {
      try {
        const payload = await fetchJson("/health");
        setHealthOutput(safeStringify(payload));
        setHealthLive(Boolean(payload?.ok));
        pushActivity("Backend health and chain capability flags refreshed.");
      } catch (error) {
        setHealthLive(false);
        setHealthOutput(safeStringify({ error: error instanceof Error ? error.message : "Unknown error" }));
        pushActivity(`Health refresh failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    });
  }

  async function refreshSnapshots() {
    await withAction("snapshots", async () => {
      try {
        const payload = await fetchJson("/admin/snapshots");
        startTransition(() => {
          setSnapshots(payload.snapshots || []);
          setDistributions(payload.distributions || []);
        });
      } catch (error) {
        pushActivity(`Snapshot refresh failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    });
  }

  useEffect(() => {
    let active = true;

    async function loadInitialState() {
      setBusy("health", true);
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, "")}/health`);
        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;

        if (!response.ok) {
          throw new Error(payload?.error || payload?.message || `Request failed with ${response.status}`);
        }

        if (active) {
          setHealthOutput(safeStringify(payload));
          setHealthLive(Boolean(payload?.ok));
          pushActivity("Backend health and chain capability flags refreshed.");
        }
      } catch (error) {
        if (active) {
          setHealthLive(false);
          setHealthOutput(safeStringify({ error: error instanceof Error ? error.message : "Unknown error" }));
          pushActivity(`Health refresh failed: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
      } finally {
        if (active) {
          setBusy("health", false);
        }
      }

      setBusy("snapshots", true);
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, "")}/admin/snapshots`, {
          headers: adminKey.trim() ? { "x-admin-key": adminKey.trim() } : undefined,
        });
        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;

        if (!response.ok) {
          throw new Error(payload?.error || payload?.message || `Request failed with ${response.status}`);
        }

        if (active) {
          startTransition(() => {
            setSnapshots(payload.snapshots || []);
            setDistributions(payload.distributions || []);
          });
        }
      } catch (error) {
        if (active) {
          pushActivity(`Snapshot refresh failed: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
      } finally {
        if (active) {
          setBusy("snapshots", false);
        }
      }
    }

    void loadInitialState();

    return () => {
      active = false;
    };
  }, [apiBase, adminKey]);

  useEffect(() => {
    if (!snapshots.length) {
      return;
    }

    const latest = snapshots.at(-1);
    if (!latest) {
      return;
    }

    startTransition(() => {
      setPublishForm((current) => ({
        ...current,
        snapshotId: String(latest.id),
        nativeValue: latest.allocations
          .reduce((sum, allocation) => sum + BigInt(allocation.payoutAmount), 0n)
          .toString(),
      }));
      setClaimForm((current) => ({ ...current, snapshotId: String(latest.id) }));
    });
  }, [snapshots]);

  const publishedCount = distributions.length;
  const busy = (key: string) => Boolean(pending[key]);

  return (
    <div className="console-ambient mx-auto flex w-full max-w-[1440px] flex-1 flex-col px-4 pb-12 pt-6 sm:px-6 lg:px-8">
      {/* ── Header ── */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-[1.8rem] border border-white/10 bg-[var(--ink-dark)] px-6 py-4 text-white shadow-[0_24px_70px_rgba(16,32,28,0.28)]">
        <div className="flex items-center gap-4">
          <div className="h-11 w-11 rounded-2xl bg-[linear-gradient(135deg,#83b89c,#ca5f2f)] shadow-[inset_0_1px_0_rgba(255,255,255,0.52)]" />
          <div>
            <p className="text-[0.68rem] font-black uppercase tracking-[0.28em] text-white/52">AssetFlow Console</p>
            <p className="text-sm leading-relaxed text-white/60">Investor approval, payouts, and redemptions</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link className="secondary-cta border-white/14 bg-white/6 text-sm text-white" href="/">
            Home
          </Link>
          <button
            className="primary-cta text-sm"
            onClick={() => void refreshHealth()}
            disabled={busy("health")}
          >
            {busy("health") && <span className="spinner" />}
            {busy("health") ? "Checking..." : "Refresh"}
          </button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[310px_minmax(0,1fr)]">
        {/* ── Sidebar ── */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          {/* Connection */}
          <section className="sidebar-glow rounded-[1.6rem] border border-white/8 bg-[var(--ink-dark)] p-5 text-white shadow-[0_20px_60px_rgba(16,32,28,0.2)]">
            <div className="flex items-center gap-2.5">
              <span className="section-number text-[0.65rem]">1</span>
              <p className="text-[0.68rem] font-black uppercase tracking-[0.22em] text-white/48">Quick start</p>
            </div>
            <p className="mt-3 text-[0.82rem] leading-6 text-white/58">
              Load demo values to fill all forms with working wallet addresses and amounts.
            </p>
            <button
              className="mt-4 w-full rounded-xl bg-[linear-gradient(135deg,#83b89c,#6da888)] px-3 py-3 text-[0.82rem] font-bold text-white shadow-[0_8px_24px_rgba(131,184,156,0.2)] transition-all hover:shadow-[0_12px_32px_rgba(131,184,156,0.3)] hover:translate-y-[-1px]"
              onClick={() => {
                setInvestorForm((current) => ({
                  ...current,
                  account: defaultAddressA,
                  expiry: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
                }));
                setMintForm({ to: defaultAddressA, amount: "100000000000000000000" });
                setLookupAccount(defaultAddressA);
                setClaimForm((current) => ({ ...current, account: defaultAddressA }));
                pushActivity("Demo wallet values loaded into all forms.");
              }}
            >
              Load Demo Values
            </button>
            <details className="mt-4">
              <summary className="cursor-pointer text-[0.62rem] font-bold uppercase tracking-[0.12em] text-white/38 transition-colors hover:text-white/60">
                Connection settings
              </summary>
              <div className="mt-3 grid gap-3">
                <label className="grid gap-1.5">
                  <span className="text-[0.62rem] font-bold uppercase tracking-[0.1em] text-white/36">API endpoint</span>
                  <input
                    className="sidebar-input"
                    value={apiBase}
                    onChange={(event) => setApiBase(event.target.value)}
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-[0.62rem] font-bold uppercase tracking-[0.1em] text-white/36">Admin key (optional)</span>
                  <input
                    className="sidebar-input"
                    type="password"
                    value={adminKey}
                    onChange={(event) => setAdminKey(event.target.value)}
                    placeholder="Leave blank for demo"
                  />
                </label>
              </div>
            </details>
          </section>

          {/* Health status */}
          <section className="surface-card console-fade-in rounded-[1.6rem] p-5">
            <div className="flex items-center justify-between">
              <p className={`pill-status ${healthLive ? "live" : ""}`}>{healthLive ? "Connected" : "Waiting"}</p>
              <span className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-[var(--muted)]">Health</span>
            </div>
            <pre className="output-shell-compact mt-4">{healthOutput}</pre>
          </section>

          {/* Activity log */}
          <section className="surface-card console-fade-in rounded-[1.6rem] p-5">
            <div className="flex items-center justify-between">
              <p className="eyebrow">Activity</p>
              <span className={`inline-block h-2 w-2 rounded-full ${deferredActivity.length ? "bg-emerald-400" : "bg-black/12"}`} />
            </div>
            <div className="mt-4 grid gap-2">
              {deferredActivity.length ? (
                deferredActivity.map((item) => (
                  <div key={item.id} className="activity-item rounded-xl bg-black/4 px-3.5 py-2.5">
                    <p className="text-[0.62rem] font-bold uppercase tracking-[0.16em] text-[var(--muted)]">{item.time}</p>
                    <p className="mt-1 text-[0.8rem] leading-5">{item.message}</p>
                  </div>
                ))
              ) : (
                <div className="rounded-xl bg-black/4 px-4 py-4 text-[0.82rem] text-[var(--muted)]">
                  No activity yet.
                </div>
              )}
            </div>
          </section>
        </aside>

        {/* ── Main panel ── */}
        <div className="space-y-5">
          {/* Workspace hero */}
          <section className="surface-card-strong console-section console-fade-in rounded-[1.9rem]">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="max-w-[38rem]">
                <p className="eyebrow">Admin console</p>
                <h1 className="display-face mt-2 text-[clamp(2.2rem,4.5vw,3.2rem)] leading-[0.95]">Walk the asset through its lifecycle</h1>
                <p className="mt-3 text-[0.84rem] leading-7 text-[var(--muted)]">
                  This console connects to real smart contracts on HashKey Chain testnet.
                  Approve investors, issue tokens, publish payouts, and settle redemptions — all from here.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                <MetricCard label="Payout windows" value={String(snapshots.length)} />
                <MetricCard label="Live payouts" value={String(publishedCount)} />
                <MetricCard label="Oracle feed" value="Active" accent />
              </div>
            </div>

            <details className="mt-5">
              <summary className="cursor-pointer text-[0.72rem] font-bold uppercase tracking-[0.14em] text-[var(--muted)] transition-colors hover:text-[var(--foreground)]">
                Deployed contracts on testnet
              </summary>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {Object.entries(deployment).map(([key, value]) => (
                  <div key={key} className="contract-chip">
                    <p className="text-[0.62rem] font-black uppercase tracking-[0.16em] text-[var(--muted)]">
                      {contractLabels[key] ?? key}
                    </p>
                    <p className="mt-1.5 font-mono text-[0.8rem] leading-none">{shortAddress(value)}</p>
                  </div>
                ))}
              </div>
            </details>
          </section>

          {/* Tab bar */}
          <div className="surface-card console-fade-in flex flex-wrap gap-1.5 rounded-full p-1.5">
            {(["overview", "issuer", "investor"] as View[]).map((tab) => (
              <button
                key={tab}
                className={`tab-pill ${view === tab ? "active" : ""}`}
                onClick={() => startTransition(() => setView(tab))}
              >
                {tab === "overview" ? "1. Status" : tab === "issuer" ? "2. Setup Asset" : "3. Serve Holders"}
              </button>
            ))}
          </div>

          {view === "overview" ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <section className="surface-card console-section">
                <div className="flex items-center gap-2.5">
                  <span className="section-number alt text-[0.65rem]">A</span>
                  <p className="eyebrow">Payout windows</p>
                </div>
                <h2 className="display-face mt-3 text-[clamp(1.8rem,3.5vw,2.4rem)] leading-[0.96]">What is ready to publish</h2>
                <p className="mt-3 max-w-[34rem] text-[0.84rem] leading-7 text-[var(--muted)]">
                  Each snapshot represents one payout window. Once published, holders can generate claim packets.
                </p>
                <div className="mt-5 grid gap-2.5">
                  {snapshots.length ? (
                    snapshots.map((snapshot) => {
                      const distribution = distributions.find((item) => item.snapshotId === snapshot.id);
                      return (
                        <div key={snapshot.id} className="rounded-[1.2rem] border border-[var(--border)] bg-white/50 p-4 transition-colors hover:bg-white/65">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <p className="text-[0.62rem] font-black uppercase tracking-[0.16em] text-[var(--muted)]">
                                Snapshot #{snapshot.id}
                              </p>
                              <p className="mt-1.5 text-base font-semibold leading-tight">{snapshot.label}</p>
                            </div>
                            <div className={`rounded-full px-3 py-1.5 text-[0.68rem] font-bold uppercase tracking-[0.1em] ${
                              distribution
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-[var(--accent-soft)] text-[#a24a23]"
                            }`}>
                              {distribution ? `Dist #${distribution.distributionId}` : "Pending"}
                            </div>
                          </div>
                          <p className="mt-2.5 text-[0.78rem] leading-5 text-[var(--muted)]">
                            {snapshot.allocations.length} holder{snapshot.allocations.length !== 1 && "s"} included
                          </p>
                        </div>
                      );
                    })
                  ) : (
                    <div className="rounded-[1.2rem] border border-dashed border-[var(--border)] bg-white/30 p-6 text-center text-[0.84rem] text-[var(--muted)]">
                      No snapshots loaded yet. Create one in the Setup Asset tab.
                    </div>
                  )}
                </div>
              </section>

              <section className="surface-card console-section">
                <div className="flex items-center gap-2.5">
                  <span className="section-number alt text-[0.65rem]">B</span>
                  <p className="eyebrow">Pricing check</p>
                </div>
                <h2 className="display-face mt-3 text-[clamp(1.8rem,3.5vw,2.4rem)] leading-[0.96]">Estimate a redemption value</h2>
                <p className="mt-3 max-w-[32rem] text-[0.84rem] leading-7 text-[var(--muted)]">
                  Reference value from the configured oracle feed before settling a redemption.
                </p>
                <form
                  className="mt-5 grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void withAction("oracle", async () => {
                      try {
                        const query = new URLSearchParams({
                          asset: oracleForm.asset,
                          assetAmount: oracleForm.assetAmount,
                          feeBps: oracleForm.feeBps,
                          haircutBps: oracleForm.haircutBps,
                        });
                        const payload = await fetchJson(`/oracle/redemption-quote?${query.toString()}`);
                        setOracleOutput(safeStringify(payload));
                        pushActivity("Oracle-backed redemption quote refreshed.");
                      } catch (error) {
                        setOracleOutput(
                          safeStringify({ error: error instanceof Error ? error.message : "Unknown error" })
                        );
                        pushActivity(`Oracle quote failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                      }
                    });
                  }}
                >
                  <label className="field-shell">
                    <span>Asset address</span>
                    <input
                      className="input-shell"
                      placeholder="0x... token contract"
                      value={oracleForm.asset}
                      onChange={(event) =>
                        setOracleForm((current) => ({ ...current, asset: event.target.value }))
                      }
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="field-shell">
                      <span>Amount (wei)</span>
                      <input
                        className="input-shell"
                        placeholder="e.g. 1000000000000000000"
                        value={oracleForm.assetAmount}
                        onChange={(event) =>
                          setOracleForm((current) => ({ ...current, assetAmount: event.target.value }))
                        }
                      />
                    </label>
                    <label className="field-shell">
                      <span>Fee (basis pts)</span>
                      <input
                        className="input-shell"
                        placeholder="e.g. 50 = 0.5%"
                        value={oracleForm.feeBps}
                        onChange={(event) =>
                          setOracleForm((current) => ({ ...current, feeBps: event.target.value }))
                        }
                      />
                    </label>
                    <label className="field-shell">
                      <span>Haircut (basis pts)</span>
                      <input
                        className="input-shell"
                        placeholder="e.g. 100 = 1%"
                        value={oracleForm.haircutBps}
                        onChange={(event) =>
                          setOracleForm((current) => ({ ...current, haircutBps: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <button className="primary-cta w-fit" disabled={busy("oracle")}>
                    {busy("oracle") && <span className="spinner" />}
                    {busy("oracle") ? "Quoting..." : "Run Quote"}
                  </button>
                </form>
                <pre className="output-shell-compact mt-5">{oracleOutput}</pre>
              </section>
            </div>
          ) : null}

          {view === "issuer" ? (
            <div className="grid gap-5 xl:grid-cols-2">
              {/* Approve investor */}
              <section className="surface-card console-section">
                <div className="flex items-center gap-2.5">
                  <span className="section-number text-[0.65rem]">1</span>
                  <p className="eyebrow">Approve an investor</p>
                </div>
                <h2 className="display-face mt-3 text-[clamp(1.8rem,3.5vw,2.4rem)] leading-[0.96]">Who can hold the asset?</h2>
                <p className="mt-3 max-w-[34rem] text-[0.84rem] leading-7 text-[var(--muted)]">
                  Set whether a wallet is allowed to hold the token, what tier they belong to, and whether they are frozen.
                </p>
                <form
                  className="mt-5 grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void withAction("investor", async () => {
                      try {
                        const payload = await fetchJson("/admin/investors", {
                          method: "POST",
                          headers: authHeaders(),
                          body: JSON.stringify(investorForm),
                        });
                        pushActivity(`Investor profile saved. tx ${shortAddress(payload.txHash)}`);
                      } catch (error) {
                        pushActivity(
                          `Investor update failed: ${error instanceof Error ? error.message : "Unknown error"}`
                        );
                      }
                    });
                  }}
                >
                  <label className="field-shell">
                    <span>Investor wallet</span>
                    <input
                      className="input-shell"
                      placeholder="0x... investor address"
                      value={investorForm.account}
                      onChange={(event) =>
                        setInvestorForm((current) => ({ ...current, account: event.target.value }))
                      }
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="field-shell">
                      <span>Investor tier</span>
                      <input
                        className="input-shell"
                        type="number"
                        placeholder="1 = retail, 2 = professional"
                        value={investorForm.tier}
                        onChange={(event) =>
                          setInvestorForm((current) => ({
                            ...current,
                            tier: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                    <label className="field-shell">
                      <span>Jurisdiction code</span>
                      <input
                        className="input-shell"
                        type="number"
                        placeholder="e.g. 852 = Hong Kong"
                        value={investorForm.jurisdiction}
                        onChange={(event) =>
                          setInvestorForm((current) => ({
                            ...current,
                            jurisdiction: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                    <label className="field-shell">
                      <span>Expires (unix)</span>
                      <input
                        className="input-shell"
                        type="number"
                        placeholder="Auto-set by demo values"
                        value={investorForm.expiry}
                        onChange={(event) =>
                          setInvestorForm((current) => ({
                            ...current,
                            expiry: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Toggle
                      checked={investorForm.approved}
                      label="Approved"
                      onChange={(checked) =>
                        setInvestorForm((current) => ({ ...current, approved: checked }))
                      }
                    />
                    <Toggle
                      checked={investorForm.accredited}
                      label="Accredited"
                      onChange={(checked) =>
                        setInvestorForm((current) => ({ ...current, accredited: checked }))
                      }
                    />
                    <Toggle
                      checked={investorForm.frozen}
                      label="Frozen"
                      onChange={(checked) =>
                        setInvestorForm((current) => ({ ...current, frozen: checked }))
                      }
                    />
                  </div>
                  <button className="primary-cta w-fit" disabled={busy("investor")}>
                    {busy("investor") && <span className="spinner" />}
                    {busy("investor") ? "Saving..." : "Save Compliance Profile"}
                  </button>
                </form>
              </section>

              {/* Issue units */}
              <section className="surface-card console-section">
                <div className="flex items-center gap-2.5">
                  <span className="section-number text-[0.65rem]">2</span>
                  <p className="eyebrow">Issue asset units</p>
                </div>
                <h2 className="display-face mt-3 text-[clamp(1.8rem,3.5vw,2.4rem)] leading-[0.96]">Give an investor their tokens</h2>
                <p className="mt-3 max-w-[34rem] text-[0.84rem] leading-7 text-[var(--muted)]">
                  After approving a wallet, mint the number of asset units the holder should receive.
                </p>
                <form
                  className="mt-5 grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void withAction("mint", async () => {
                      try {
                        const payload = await fetchJson("/admin/assets/mint", {
                          method: "POST",
                          headers: authHeaders(),
                          body: JSON.stringify(mintForm),
                        });
                        pushActivity(`Asset units minted. tx ${shortAddress(payload.txHash)}`);
                      } catch (error) {
                        pushActivity(`Mint failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                      }
                    });
                  }}
                >
                  <label className="field-shell">
                    <span>Recipient wallet</span>
                    <input
                      className="input-shell"
                      placeholder="0x... approved investor"
                      value={mintForm.to}
                      onChange={(event) => setMintForm((current) => ({ ...current, to: event.target.value }))}
                    />
                  </label>
                  <label className="field-shell">
                    <span>Token amount (wei)</span>
                    <input
                      className="input-shell"
                      placeholder="e.g. 100000000000000000000 = 100 tokens"
                      value={mintForm.amount}
                      onChange={(event) =>
                        setMintForm((current) => ({ ...current, amount: event.target.value }))
                      }
                    />
                  </label>
                  <button className="primary-cta w-fit" disabled={busy("mint")}>
                    {busy("mint") && <span className="spinner" />}
                    {busy("mint") ? "Minting..." : "Mint Asset Units"}
                  </button>
                </form>
              </section>

              {/* Prepare payout window */}
              <section className="surface-card console-section xl:col-span-2">
                <div className="flex items-center gap-2.5">
                  <span className="section-number text-[0.65rem]">3</span>
                  <p className="eyebrow">Prepare a payout window</p>
                </div>
                <h2 className="display-face mt-3 text-[clamp(1.8rem,3.5vw,2.4rem)] leading-[0.96]">Set up who gets paid and how much</h2>
                <p className="mt-3 max-w-[44rem] text-[0.84rem] leading-7 text-[var(--muted)]">
                  Add each holder, the number of units they hold, and the payout they should receive in this window.
                </p>
                <form
                  className="mt-5 grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void withAction("snapshot", async () => {
                      try {
                        const payload = await fetchJson("/admin/snapshots", {
                          method: "POST",
                          headers: authHeaders(),
                          body: JSON.stringify({
                            label: snapshotForm.label,
                            payoutToken: snapshotForm.payoutToken,
                            snapshotTimestamp: snapshotForm.snapshotTimestamp,
                            metadataURI: snapshotForm.metadataURI,
                            allocations: snapshotForm.allocations.map(({ account, assetAmount, payoutAmount }) => ({
                              account,
                              assetAmount,
                              payoutAmount,
                            })),
                          }),
                        });
                        pushActivity(`Snapshot #${payload.id} created with ${payload.allocations.length} allocations.`);
                        await refreshSnapshots();
                      } catch (error) {
                        pushActivity(
                          `Snapshot creation failed: ${error instanceof Error ? error.message : "Unknown error"}`
                        );
                      }
                    });
                  }}
                >
                  <div className="grid gap-3 lg:grid-cols-3">
                    <label className="field-shell">
                      <span>Window name</span>
                      <input
                        className="input-shell"
                        placeholder="e.g. Q1 2026 Dividend"
                        value={snapshotForm.label}
                        onChange={(event) =>
                          setSnapshotForm((current) => ({ ...current, label: event.target.value }))
                        }
                      />
                    </label>
                    <label className="field-shell">
                      <span>Payout token</span>
                      <input
                        className="input-shell"
                        placeholder="0x... or native HSK"
                        value={snapshotForm.payoutToken}
                        onChange={(event) =>
                          setSnapshotForm((current) => ({ ...current, payoutToken: event.target.value }))
                        }
                      />
                    </label>
                    <label className="field-shell">
                      <span>Metadata link</span>
                      <input
                        className="input-shell"
                        placeholder="ipfs://... or https://..."
                        value={snapshotForm.metadataURI}
                        onChange={(event) =>
                          setSnapshotForm((current) => ({ ...current, metadataURI: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <label className="field-shell">
                    <span>Snapshot date (unix timestamp)</span>
                    <input
                      className="input-shell"
                      type="number"
                      placeholder="Seconds since epoch"
                      value={snapshotForm.snapshotTimestamp}
                      onChange={(event) =>
                        setSnapshotForm((current) => ({
                          ...current,
                          snapshotTimestamp: Number(event.target.value),
                        }))
                      }
                    />
                  </label>

                  <div className="flex items-center justify-between">
                    <p className="eyebrow">Allocations</p>
                    <button
                      type="button"
                      className="secondary-cta text-sm"
                      onClick={() =>
                        setSnapshotForm((current) => ({
                          ...current,
                          allocations: [...current.allocations, makeAllocation()],
                        }))
                      }
                    >
                      + Add holder
                    </button>
                  </div>

                  <div className="grid gap-2.5">
                    {snapshotForm.allocations.map((allocation) => (
                      <div key={allocation.id} className="alloc-row">
                        <label className="field-shell">
                          <span>Holder wallet</span>
                          <input
                            className="input-shell"
                            placeholder="0x..."
                            value={allocation.account}
                            onChange={(event) =>
                              setSnapshotForm((current) => ({
                                ...current,
                                allocations: current.allocations.map((item) =>
                                  item.id === allocation.id
                                    ? { ...item, account: event.target.value }
                                    : item
                                ),
                              }))
                            }
                          />
                        </label>
                        <label className="field-shell">
                          <span>Units held</span>
                          <input
                            className="input-shell"
                            placeholder="Token balance"
                            value={allocation.assetAmount}
                            onChange={(event) =>
                              setSnapshotForm((current) => ({
                                ...current,
                                allocations: current.allocations.map((item) =>
                                  item.id === allocation.id
                                    ? { ...item, assetAmount: event.target.value }
                                    : item
                                ),
                              }))
                            }
                          />
                        </label>
                        <label className="field-shell">
                          <span>Payout owed</span>
                          <input
                            className="input-shell"
                            placeholder="Amount to pay"
                            value={allocation.payoutAmount}
                            onChange={(event) =>
                              setSnapshotForm((current) => ({
                                ...current,
                                allocations: current.allocations.map((item) =>
                                  item.id === allocation.id
                                    ? { ...item, payoutAmount: event.target.value }
                                    : item
                                ),
                              }))
                            }
                          />
                        </label>
                        <button
                          type="button"
                          className="ghost-cta self-end text-sm"
                          onClick={() =>
                            setSnapshotForm((current) => ({
                              ...current,
                              allocations: current.allocations.filter((item) => item.id !== allocation.id),
                            }))
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>

                  <button className="primary-cta w-fit" disabled={busy("snapshot")}>
                    {busy("snapshot") && <span className="spinner" />}
                    {busy("snapshot") ? "Creating..." : "Create Snapshot"}
                  </button>
                </form>
              </section>

              {/* Publish */}
              <section className="surface-card console-section xl:col-span-2">
                <div className="flex items-center gap-2.5">
                  <span className="section-number text-[0.65rem]">4</span>
                  <p className="eyebrow">Fund and publish</p>
                </div>
                <h2 className="display-face mt-3 text-[clamp(1.8rem,3.5vw,2.4rem)] leading-[0.96]">Make the payout live</h2>
                <p className="mt-3 max-w-[40rem] text-[0.84rem] leading-7 text-[var(--muted)]">
                  Pick a payout window and fund it. Once published, holders can claim their share.
                </p>
                <form
                  className="mt-5 grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto]"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void withAction("publish", async () => {
                      try {
                        const payload = await fetchJson(
                          `/admin/distributions/${publishForm.snapshotId}/publish`,
                          {
                            method: "POST",
                            headers: authHeaders(),
                            body: JSON.stringify({ nativeValue: publishForm.nativeValue }),
                          }
                        );
                        pushActivity(
                          `Distribution published for snapshot #${publishForm.snapshotId}. tx ${shortAddress(payload.txHash)}`
                        );
                        await refreshSnapshots();
                      } catch (error) {
                        pushActivity(`Publish failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                      }
                    });
                  }}
                >
                  <label className="field-shell">
                    <span>Payout window #</span>
                    <input
                      className="input-shell"
                      placeholder="e.g. 1"
                      value={publishForm.snapshotId}
                      onChange={(event) =>
                        setPublishForm((current) => ({ ...current, snapshotId: event.target.value }))
                      }
                    />
                  </label>
                  <label className="field-shell">
                    <span>Funding amount (wei)</span>
                    <input
                      className="input-shell"
                      placeholder="Total payout in wei"
                      value={publishForm.nativeValue}
                      onChange={(event) =>
                        setPublishForm((current) => ({ ...current, nativeValue: event.target.value }))
                      }
                    />
                  </label>
                  <button className="primary-cta" disabled={busy("publish")}>
                    {busy("publish") && <span className="spinner" />}
                    {busy("publish") ? "Publishing..." : "Publish"}
                  </button>
                </form>
              </section>
            </div>
          ) : null}

          {view === "investor" ? (
            <div className="grid gap-5 xl:grid-cols-2">
              {/* Inspect investor */}
              <section className="surface-card console-section">
                <div className="flex items-center gap-2.5">
                  <span className="section-number alt text-[0.65rem]">A</span>
                  <p className="eyebrow">Holder service</p>
                </div>
                <h2 className="display-face mt-3 text-[clamp(1.8rem,3.5vw,2.4rem)] leading-[0.96]">Look up any investor</h2>
                <p className="mt-3 max-w-[34rem] text-[0.84rem] leading-7 text-[var(--muted)]">
                  See their compliance status, token balance, and whether they are approved or frozen.
                </p>
                <form
                  className="mt-5 grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void withAction("lookup", async () => {
                      try {
                        const [investor, assets] = await Promise.all([
                          fetchJson(`/investors/${lookupAccount}`),
                          fetchJson(`/assets/${lookupAccount}`),
                        ]);
                        setLookupOutput(safeStringify({ investor, assets }));
                        pushActivity(`Investor ${shortAddress(lookupAccount)} loaded.`);
                      } catch (error) {
                        setLookupOutput(
                          safeStringify({ error: error instanceof Error ? error.message : "Unknown error" })
                        );
                        pushActivity(
                          `Investor lookup failed: ${error instanceof Error ? error.message : "Unknown error"}`
                        );
                      }
                    });
                  }}
                >
                  <label className="field-shell">
                    <span>Investor wallet</span>
                    <input
                      className="input-shell"
                      placeholder="0x... holder address"
                      value={lookupAccount}
                      onChange={(event) => setLookupAccount(event.target.value)}
                    />
                  </label>
                  <button className="primary-cta w-fit" disabled={busy("lookup")}>
                    {busy("lookup") && <span className="spinner" />}
                    {busy("lookup") ? "Loading..." : "Look Up"}
                  </button>
                </form>
                <pre className="output-shell-compact mt-5">{lookupOutput}</pre>
              </section>

              {/* Claim */}
              <section className="surface-card console-section">
                <div className="flex items-center gap-2.5">
                  <span className="section-number alt text-[0.65rem]">B</span>
                  <p className="eyebrow">Claim support</p>
                </div>
                <h2 className="display-face mt-3 text-[clamp(1.8rem,3.5vw,2.4rem)] leading-[0.96]">Help a holder claim their payout</h2>
                <p className="mt-3 max-w-[34rem] text-[0.84rem] leading-7 text-[var(--muted)]">
                  Generate the claim data a holder needs to collect from a published payout window.
                </p>
                <form
                  className="mt-5 grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void withAction("claim", async () => {
                      try {
                        const payload = await fetchJson(
                          `/intents/distributions/${claimForm.snapshotId}/claim`,
                          {
                            method: "POST",
                            headers: authHeaders(),
                            body: JSON.stringify({ account: claimForm.account }),
                          }
                        );
                        setClaimOutput(safeStringify(payload));
                        pushActivity(`Claim intent built for distribution #${payload.distributionId}.`);
                      } catch (error) {
                        setClaimOutput(
                          safeStringify({ error: error instanceof Error ? error.message : "Unknown error" })
                        );
                        pushActivity(`Claim build failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                      }
                    });
                  }}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="field-shell">
                      <span>Payout window #</span>
                      <input
                        className="input-shell"
                        placeholder="e.g. 1"
                        value={claimForm.snapshotId}
                        onChange={(event) =>
                          setClaimForm((current) => ({ ...current, snapshotId: event.target.value }))
                        }
                      />
                    </label>
                    <label className="field-shell">
                      <span>Holder wallet</span>
                      <input
                        className="input-shell"
                        placeholder="0x... claimant"
                        value={claimForm.account}
                        onChange={(event) =>
                          setClaimForm((current) => ({ ...current, account: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <button className="primary-cta w-fit" disabled={busy("claim")}>
                    {busy("claim") && <span className="spinner" />}
                    {busy("claim") ? "Building..." : "Generate Claim"}
                  </button>
                </form>
                <pre className="output-shell-compact mt-5">{claimOutput}</pre>
              </section>

              {/* Redemption desk */}
              <section className="surface-card console-section xl:col-span-2">
                <div className="flex items-center gap-2.5">
                  <span className="section-number alt text-[0.65rem]">C</span>
                  <p className="eyebrow">Redemption desk</p>
                </div>
                <h2 className="display-face mt-3 text-[clamp(1.8rem,3.5vw,2.4rem)] leading-[0.96]">Handle exit requests</h2>
                <p className="mt-3 max-w-[44rem] text-[0.84rem] leading-7 text-[var(--muted)]">
                  When a holder wants to redeem their tokens, review the request here. You can approve, reject with a reason, or settle it.
                </p>

                {/* Inputs row */}
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <label className="field-shell">
                    <span>Redemption #</span>
                    <input
                      className="input-shell"
                      placeholder="Request ID from the queue"
                      value={redemptionForm.requestId}
                      onChange={(event) =>
                        setRedemptionForm((current) => ({ ...current, requestId: event.target.value }))
                      }
                    />
                  </label>
                  <label className="field-shell">
                    <span>Rejection reason</span>
                    <input
                      className="input-shell"
                      placeholder="Only needed if rejecting"
                      value={redemptionForm.reason}
                      onChange={(event) =>
                        setRedemptionForm((current) => ({ ...current, reason: event.target.value }))
                      }
                    />
                  </label>
                </div>

                {/* Action buttons — grouped properly */}
                <div className="mt-4 flex flex-wrap gap-2.5">
                  <button
                    className="secondary-cta text-sm"
                    disabled={busy("redemption-read")}
                    onClick={() => {
                      void withAction("redemption-read", async () => {
                        try {
                          const payload = await fetchJson(`/redemptions/${redemptionForm.requestId}`);
                          setRedemptionOutput(safeStringify(payload));
                          pushActivity(`Redemption request #${redemptionForm.requestId} loaded.`);
                        } catch (error) {
                          setRedemptionOutput(
                            safeStringify({ error: error instanceof Error ? error.message : "Unknown error" })
                          );
                          pushActivity(
                            `Redemption read failed: ${error instanceof Error ? error.message : "Unknown error"}`
                          );
                        }
                      });
                    }}
                  >
                    {busy("redemption-read") && <span className="spinner spinner-dark" />}
                    {busy("redemption-read") ? "Reading..." : "Read Request"}
                  </button>
                  <button
                    className="secondary-cta text-sm"
                    disabled={busy("redemption-approve")}
                    onClick={() => {
                      void withAction("redemption-approve", async () => {
                        try {
                          const payload = await fetchJson(
                            `/redemptions/${redemptionForm.requestId}/approve`,
                            {
                              method: "POST",
                              headers: authHeaders(),
                              body: JSON.stringify({}),
                            }
                          );
                          pushActivity(`Redemption approved. tx ${shortAddress(payload.txHash)}`);
                        } catch (error) {
                          pushActivity(
                            `Redemption approve failed: ${error instanceof Error ? error.message : "Unknown error"}`
                          );
                        }
                      });
                    }}
                  >
                    {busy("redemption-approve") && <span className="spinner spinner-dark" />}
                    {busy("redemption-approve") ? "Approving..." : "Approve"}
                  </button>
                  <button
                    className="primary-cta text-sm"
                    disabled={busy("redemption-settle")}
                    onClick={() => {
                      void withAction("redemption-settle", async () => {
                        try {
                          const payload = await fetchJson(
                            `/redemptions/${redemptionForm.requestId}/settle`,
                            {
                              method: "POST",
                              headers: authHeaders(),
                              body: JSON.stringify({}),
                            }
                          );
                          pushActivity(`Redemption settled. tx ${shortAddress(payload.txHash)}`);
                        } catch (error) {
                          pushActivity(
                            `Redemption settle failed: ${error instanceof Error ? error.message : "Unknown error"}`
                          );
                        }
                      });
                    }}
                  >
                    {busy("redemption-settle") && <span className="spinner" />}
                    {busy("redemption-settle") ? "Settling..." : "Settle"}
                  </button>

                  <div className="ml-auto">
                    <button
                      className="ghost-cta text-sm"
                      disabled={busy("redemption-reject")}
                      onClick={() => {
                        void withAction("redemption-reject", async () => {
                          try {
                            const payload = await fetchJson(
                              `/redemptions/${redemptionForm.requestId}/reject`,
                              {
                                method: "POST",
                                headers: authHeaders(),
                                body: JSON.stringify({ reason: redemptionForm.reason }),
                              }
                            );
                            pushActivity(`Redemption rejected. tx ${shortAddress(payload.txHash)}`);
                          } catch (error) {
                            pushActivity(
                              `Redemption reject failed: ${error instanceof Error ? error.message : "Unknown error"}`
                            );
                          }
                        });
                      }}
                    >
                      {busy("redemption-reject") && <span className="spinner spinner-dark" />}
                      {busy("redemption-reject") ? "Rejecting..." : "Reject"}
                    </button>
                  </div>
                </div>

                <pre className="output-shell-compact mt-5">{redemptionOutput}</pre>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-[1rem] border px-3.5 py-2.5 ${
      accent
        ? "border-emerald-200/60 bg-emerald-50/60"
        : "border-[var(--border)] bg-white/50"
    }`}>
      <p className="text-[0.6rem] font-black uppercase tracking-[0.16em] text-[var(--muted)]">{label}</p>
      <p className={`mt-1 text-base font-semibold leading-tight ${accent ? "text-emerald-800" : ""}`}>{value}</p>
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-full border border-[var(--border)] bg-white/50 px-4 py-2.5 text-[0.82rem] font-semibold text-[var(--muted)] transition-colors hover:bg-white/70">
      <input className="sr-only" checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      <span className={`toggle-track ${checked ? "active" : ""}`} />
      {label}
    </label>
  );
}
