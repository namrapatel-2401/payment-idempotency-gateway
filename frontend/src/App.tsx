import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronRight,
  CircleDot,
  Copy,
  Database,
  Gauge,
  KeyRound,
  Layers3,
  LockKeyhole,
  Menu,
  RefreshCw,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X,
  XCircle,
} from "lucide-react";
import { createPayment, getHealth, getMetrics, getPayment } from "./api";
import type { ApiResult, MetricsSnapshot, PaymentRequest, PaymentResponse, PaymentStatus } from "./types";

type Section = "playground" | "idempotency" | "monitoring" | "observability";
type ActivityItem = { id: string; title: string; detail: string; status: "success" | "error" | "info"; at: string };

const navItems: Array<{ id: Section; label: string; note: string; icon: typeof Activity }> = [
  { id: "playground", label: "Payment Playground", note: "Create a real API request", icon: Sparkles },
  { id: "idempotency", label: "Idempotency Lab", note: "Replay and conflict testing", icon: KeyRound },
  { id: "monitoring", label: "Recovery Monitoring", note: "Inspect a payment", icon: RefreshCw },
  { id: "observability", label: "Observability", note: "Metrics and operations", icon: Activity },
];

const statusCopy: Record<PaymentStatus, { label: string; tone: string; icon: typeof Check }> = {
  pending: { label: "Pending", tone: "text-slate-300 bg-slate-400/10 border-slate-400/20", icon: CircleDot },
  processing: { label: "Processing", tone: "text-cyan bg-cyan/10 border-cyan/20", icon: RefreshCw },
  completed: { label: "Completed", tone: "text-mint bg-mint/10 border-mint/20", icon: Check },
  failed: { label: "Failed", tone: "text-rose-300 bg-rose-400/10 border-rose-400/20", icon: XCircle },
  requires_reconciliation: { label: "Needs reconciliation", tone: "text-amber bg-amber/10 border-amber/20", icon: AlertTriangle },
};

const initialForm = {
  amount: "125.00",
  currency: "USD",
  customer_email: "demo@example.com",
  description: "Reliability playground payment",
  metadata: '{"source":"playground"}',
};

const makeKey = () => `playground_${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;

function App() {
  const [section, setSection] = useState<Section>("playground");
  const [mobileNav, setMobileNav] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [idempotencyKey, setIdempotencyKey] = useState(makeKey);
  const [payment, setPayment] = useState<PaymentResponse | null>(null);
  const [lastResult, setLastResult] = useState<ApiResult<unknown> | null>(null);
  const [firstRequest, setFirstRequest] = useState<ApiResult<unknown> | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [health, setHealth] = useState<{ status: string; database: string; uptime: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [monitorLoading, setMonitorLoading] = useState(false);
  const [error, setError] = useState("");

  const payload = useMemo<PaymentRequest>(() => {
    let metadata: Record<string, unknown> | undefined;
    try {
      metadata = form.metadata.trim() ? JSON.parse(form.metadata) : undefined;
    } catch {
      metadata = undefined;
    }
    return {
      amount: Number(form.amount),
      currency: form.currency.toUpperCase(),
      customer_email: form.customer_email,
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }, [form]);

  const addActivity = (title: string, detail: string, status: ActivityItem["status"]) => {
    setActivity((items) => [{ id: `${Date.now()}-${Math.random()}`, title, detail, status, at: new Date().toISOString() }, ...items].slice(0, 12));
  };

  const sendPayment = async (requestPayload: PaymentRequest, key = idempotencyKey, label = "Payment request") => {
    setLoading(true);
    setError("");
    const result = await createPayment(key, requestPayload);
    setLoading(false);
    setLastResult(result);
    if (!firstRequest) setFirstRequest(result);
    if (result.ok && isPayment(result.body)) {
      setPayment(result.body);
      addActivity(label, `${result.status} · ${result.body.status}`, "success");
    } else {
      const message = getError(result.body);
      setError(message);
      addActivity(label, `${result.status} · ${message}`, "error");
    }
    return result;
  };

  const runCreate = async () => {
    if (!Number.isFinite(payload.amount) || payload.amount <= 0 || !payload.customer_email.includes("@")) {
      setError("Enter a positive amount and a valid customer email.");
      return;
    }
    if (form.metadata.trim()) {
      try {
        JSON.parse(form.metadata);
      } catch {
        setError("Metadata must be valid JSON.");
        return;
      }
    }
    await sendPayment(payload, idempotencyKey, "Create payment");
  };

  const refreshPayment = async () => {
    if (!payment?.id) return;
    setMonitorLoading(true);
    const result = await getPayment(payment.id);
    setMonitorLoading(false);
    if (result.ok && isPayment(result.body)) {
      setPayment(result.body);
      addActivity("Payment refresh", `${result.status} · ${result.body.status}`, "success");
    } else {
      addActivity("Payment refresh", `${result.status} · ${getError(result.body)}`, "error");
    }
  };

  const refreshOperations = async () => {
    setMonitorLoading(true);
    const [metricsResult, healthResult] = await Promise.all([getMetrics(), getHealth()]);
    setMonitorLoading(false);
    if (metricsResult.ok) setMetrics(metricsResult.body as MetricsSnapshot);
    if (healthResult.ok) setHealth(healthResult.body as typeof health);
    addActivity("Operations refresh", `${metricsResult.status} metrics · ${healthResult.status} health`, metricsResult.ok && healthResult.ok ? "success" : "error");
  };

  useEffect(() => {
    void refreshOperations();
  }, []);

  const navigate = (next: Section) => {
    setSection(next);
    setMobileNav(false);
  };

  return (
    <div className="min-h-screen bg-ink text-slate-100">
      <div className="grid-noise pointer-events-none fixed inset-0 opacity-60" />
      <div className="relative flex min-h-screen">
        <aside className={`${mobileNav ? "translate-x-0" : "-translate-x-full lg:translate-x-0"} fixed inset-y-0 left-0 z-30 flex w-80 flex-col border-r border-line bg-[#0c1728]/95 px-5 py-6 backdrop-blur-xl transition-transform lg:static`}>
          <div className="flex items-center justify-between px-2">
            <div className="flex items-center gap-3">
              <div className="brand-mark"><Layers3 size={19} /></div>
              <div><p className="text-sm font-semibold tracking-wide text-white">Payment Reliability</p><p className="text-xs text-slate-500">Playground</p></div>
            </div>
            <button className="icon-button lg:hidden" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18} /></button>
          </div>

          <div className="mt-10 rounded-2xl border border-cyan/15 bg-cyan/[.04] p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-cyan"><span className="pulse-dot" /> SIMULATED ENVIRONMENT</div>
            <p className="mt-3 text-sm leading-6 text-slate-400">Exercise idempotency, retries and recovery against the real Fastify API.</p>
          </div>

          <nav className="mt-8 space-y-2">
            <p className="eyebrow px-3 pb-2">Workspace</p>
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return <button key={item.id} onClick={() => navigate(item.id)} className={`nav-item ${active ? "nav-item-active" : ""}`}><Icon size={18} /><span className="min-w-0 text-left"><strong>{item.label}</strong><small>{item.note}</small></span><ChevronRight size={15} className="ml-auto opacity-50" /></button>;
            })}
          </nav>

          <div className="mt-auto rounded-2xl border border-line bg-panel/70 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300"><ShieldCheck size={15} className="text-mint" /> Reliability controls</div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-[11px] text-slate-500"><span>PostgreSQL</span><span className="text-right text-mint">connected by API</span><span>Idempotency</span><span className="text-right text-cyan">enabled</span><span>Workers</span><span className="text-right text-amber">external process</span></div>
          </div>
        </aside>

        {mobileNav && <button className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={() => setMobileNav(false)} aria-label="Close navigation overlay" />}
        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-10 flex h-20 items-center justify-between border-b border-line/80 bg-ink/75 px-5 backdrop-blur-xl lg:px-10">
            <div className="flex items-center gap-4"><button className="icon-button lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={19} /></button><div><p className="eyebrow">Developer console / simulated payments</p><h1 className="mt-1 text-xl font-semibold tracking-tight text-white">{navItems.find((item) => item.id === section)?.label}</h1></div></div>
            <div className="hidden items-center gap-3 sm:flex"><span className="status-pill border-mint/20 bg-mint/5 text-mint"><span className="pulse-dot pulse-dot-mint" /> API surface live</span><span className="font-mono text-xs text-slate-600">localhost:3000</span></div>
          </header>

          <div className="mx-auto max-w-[1450px] p-5 lg:p-10">
            {section === "playground" && <Playground form={form} setForm={setForm} idempotencyKey={idempotencyKey} setIdempotencyKey={setIdempotencyKey} payload={payload} payment={payment} lastResult={lastResult} error={error} loading={loading} onCreate={runCreate} onNew={() => { setIdempotencyKey(makeKey()); setLastResult(null); setFirstRequest(null); setError(""); }} onCopy={(value) => void navigator.clipboard?.writeText(value)} />}
            {section === "idempotency" && <IdempotencyLab form={form} payload={payload} idempotencyKey={idempotencyKey} firstRequest={firstRequest} lastResult={lastResult} loading={loading} onRetry={() => void sendPayment(payload, idempotencyKey, "Same-key retry")} onConflict={() => void sendPayment({ ...payload, amount: payload.amount + 1 }, idempotencyKey, "Conflicting payload")} onCreate={() => navigate("playground")} />}
            {section === "monitoring" && <Monitoring payment={payment} metrics={metrics} loading={monitorLoading} onRefreshPayment={() => void refreshPayment()} onRefreshMetrics={() => void refreshOperations()} />}
            {section === "observability" && <Observability metrics={metrics} health={health} activity={activity} loading={monitorLoading} onRefresh={() => void refreshOperations()} />}
          </div>
        </main>
      </div>
    </div>
  );
}

function Playground({ form, setForm, idempotencyKey, setIdempotencyKey, payload, payment, lastResult, error, loading, onCreate, onNew, onCopy }: { form: typeof initialForm; setForm: React.Dispatch<React.SetStateAction<typeof initialForm>>; idempotencyKey: string; setIdempotencyKey: (value: string) => void; payload: PaymentRequest; payment: PaymentResponse | null; lastResult: ApiResult<unknown> | null; error: string; loading: boolean; onCreate: () => void; onNew: () => void; onCopy: (value: string) => void }) {
  return <>
    <SectionIntro eyebrow="Request workshop" title="Create a payment, then stress the guarantee." copy="Every action below talks to the existing payment API. The playground makes the idempotency key visible so you can follow it through retries and conflicts." action={<button className="secondary-button" onClick={onNew}><Sparkles size={15} /> New scenario</button>} />
    <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(370px,.9fr)]">
      <div className="panel p-6 lg:p-8">
        <div className="flex items-center justify-between"><div><p className="eyebrow">01 / payment intent</p><h2 className="mt-2 text-lg font-semibold text-white">Request parameters</h2></div><span className="step-number">01</span></div>
        <div className="mt-7 grid gap-5 sm:grid-cols-2">
          <Field label="Amount" hint="positive decimal"><div className="input-with-prefix"><span>$</span><input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} inputMode="decimal" /></div></Field>
          <Field label="Currency" hint="3-letter code"><input className="input" value={form.currency} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></Field>
          <Field label="Customer email" hint="required" wide><input className="input" value={form.customer_email} onChange={(e) => setForm({ ...form, customer_email: e.target.value })} /></Field>
          <Field label="Description" hint="optional · max 500 chars" wide><input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Metadata" hint="JSON object" wide><textarea className="input min-h-24 resize-y font-mono text-xs" value={form.metadata} onChange={(e) => setForm({ ...form, metadata: e.target.value })} /></Field>
        </div>
        <div className="mt-7 border-t border-line pt-6"><div className="flex items-center justify-between"><label className="field-label"><KeyRound size={14} className="text-cyan" /> Idempotency-Key <span className="field-hint">required</span></label><button className="text-button" onClick={() => setIdempotencyKey(makeKey())}>Regenerate</button></div><div className="mt-2 flex gap-2"><input className="input font-mono text-sm" value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} /><button className="icon-button" onClick={() => onCopy(idempotencyKey)} aria-label="Copy idempotency key"><Copy size={16} /></button></div></div>
        <button className="primary-button mt-8 w-full" onClick={onCreate} disabled={loading}><Send size={17} />{loading ? "Sending to gateway…" : "Create payment"}<ArrowRight size={16} className="ml-auto" /></button>
        <p className="mt-3 text-center text-xs text-slate-600">No card details are collected. This is a simulated payment environment.</p>
      </div>
      <div className="space-y-6"><ResponsePanel result={lastResult} error={error} payload={payload} keyValue={idempotencyKey} /><PaymentCard payment={payment} /></div>
    </div>
  </>;
}

function IdempotencyLab({ form, payload, idempotencyKey, firstRequest, lastResult, loading, onRetry, onConflict, onCreate }: { form: typeof initialForm; payload: PaymentRequest; idempotencyKey: string; firstRequest: ApiResult<unknown> | null; lastResult: ApiResult<unknown> | null; loading: boolean; onRetry: () => void; onConflict: () => void; onCreate: () => void }) {
  const hasScenario = Boolean(firstRequest);
  return <>
    <SectionIntro eyebrow="Controlled experiment" title="Make idempotency visible." copy="Run the same request twice, then deliberately change the payload while keeping the key. The response codes and bodies show how the gateway protects the payment boundary." action={!hasScenario ? <button className="secondary-button" onClick={onCreate}><Send size={15} /> Create a scenario</button> : <span className="status-pill border-cyan/20 bg-cyan/5 text-cyan"><LockKeyhole size={13} /> Key locked to scenario</span>} />
    <div className="mt-8 grid gap-6 xl:grid-cols-[.85fr_1.15fr]">
      <div className="panel p-6 lg:p-8"><p className="eyebrow">Experiment controls</p><h2 className="mt-2 text-lg font-semibold text-white">Reuse the same key</h2><div className="mt-6 rounded-xl border border-line bg-ink/70 p-4"><p className="text-xs text-slate-500">Active idempotency key</p><p className="mt-2 break-all font-mono text-sm text-cyan">{idempotencyKey}</p></div><div className="mt-5 rounded-xl border border-line bg-ink/40 p-4"><p className="text-xs text-slate-500">Original payload</p><pre className="mt-3 overflow-auto text-xs leading-6 text-slate-300">{JSON.stringify(payload, null, 2)}</pre></div><button className="primary-button mt-6 w-full" disabled={!hasScenario || loading} onClick={onRetry}><RefreshCw size={16} /> Retry same payload <span className="ml-auto rounded-md bg-white/10 px-2 py-1 font-mono text-[10px]">expect replay</span></button><button className="danger-button mt-3 w-full" disabled={!hasScenario || loading} onClick={onConflict}><AlertTriangle size={16} /> Change payload, keep key <span className="ml-auto rounded-md bg-white/10 px-2 py-1 font-mono text-[10px]">expect 409</span></button><p className="mt-5 text-xs leading-5 text-slate-600">The conflict action changes only the amount sent by this demo. It never changes the stored payment.</p></div>
      <div className="space-y-6"><ComparisonCard first={firstRequest} second={lastResult} /><div className="panel p-6"><div className="flex items-center gap-3"><div className="icon-tile"><TerminalSquare size={17} /></div><div><p className="eyebrow">What to look for</p><h3 className="font-semibold text-white">The key is the boundary</h3></div></div><div className="mt-6 grid gap-3 sm:grid-cols-3"><LabSignal title="Same key" value="Replay-safe" tone="cyan" /><LabSignal title="Changed body" value="409 conflict" tone="amber" /><LabSignal title="Provider call" value="Deduplicated" tone="mint" /></div></div></div>
    </div>
  </>;
}

function Monitoring({ payment, metrics, loading, onRefreshPayment, onRefreshMetrics }: { payment: PaymentResponse | null; metrics: MetricsSnapshot | null; loading: boolean; onRefreshPayment: () => void; onRefreshMetrics: () => void }) {
  return <><SectionIntro eyebrow="Operational state" title="Follow recovery without guessing." copy="Refresh the payment through the real GET endpoint and inspect the gateway's process-local recovery metrics. Worker database state is intentionally not invented here." action={<button className="secondary-button" onClick={onRefreshMetrics} disabled={loading}><RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Refresh telemetry</button>} /><div className="mt-8 grid gap-6 xl:grid-cols-[1.1fr_.9fr]"><div className="panel p-6 lg:p-8"><div className="flex items-center justify-between"><div><p className="eyebrow">Payment resource</p><h2 className="mt-2 text-lg font-semibold text-white">{payment ? payment.id : "No payment selected"}</h2></div>{payment && <StatusBadge status={payment.status} />}</div>{payment ? <><div className="mt-8 grid gap-4 sm:grid-cols-3"><Stat label="Amount" value={`${payment.currency} ${payment.amount.toFixed(2)}`} /><Stat label="Provider ID" value={payment.provider_id || "Not assigned"} mono /><Stat label="Observed by" value={payment.provider_status || "Awaiting provider result"} /></div><div className="mt-8 rounded-xl border border-line bg-ink/50 p-5"><div className="flex items-center justify-between"><p className="text-sm font-medium text-white">Payment lifecycle</p><button className="text-button" onClick={onRefreshPayment} disabled={loading}><RefreshCw size={13} /> Refresh payment</button></div><Lifecycle status={payment.status} /><div className="mt-5 grid gap-3 text-xs text-slate-500 sm:grid-cols-2"><span>Created <strong className="ml-2 text-slate-300">{formatDate(payment.created_at)}</strong></span><span>Updated <strong className="ml-2 text-slate-300">{formatDate(payment.updated_at)}</strong></span></div></div></> : <EmptyState icon={Database} title="Create a payment first" copy="The monitoring view uses the payment ID returned by the actual POST /payments response." />}</div><MetricsSummary metrics={metrics} /></div></>;
}

function Observability({ metrics, health, activity, loading, onRefresh }: { metrics: MetricsSnapshot | null; health: { status: string; database: string; uptime: number } | null; activity: ActivityItem[]; loading: boolean; onRefresh: () => void }) {
  const counters = Object.entries(metrics?.counters || {});
  const gauges = Object.entries(metrics?.gauges || {});
  return <><SectionIntro eyebrow="Runtime signals" title="A compact operational readout." copy="These values come from the existing gateway /metrics and /health endpoints. Metrics are process-local; PostgreSQL remains the durable source of recovery truth." action={<button className="secondary-button" onClick={onRefresh} disabled={loading}><RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Refresh</button>} /><div className="mt-8 grid gap-6 xl:grid-cols-[1.1fr_.9fr]"><div className="space-y-6"><div className="grid gap-4 sm:grid-cols-2"><RuntimeCard icon={Server} label="Gateway health" value={health?.status || "Unknown"} detail={health ? `${health.database} · ${Math.round(health.uptime)}s uptime` : "Fetch /health to inspect"} tone={health?.status === "healthy" ? "mint" : "amber"} /><RuntimeCard icon={Gauge} label="Metric samples" value={String(counters.length + gauges.length)} detail={metrics ? `Generated ${formatDate(metrics.generated_at)}` : "Fetch /metrics to inspect"} tone="cyan" /></div><div className="panel p-6"><div className="flex items-center gap-3"><div className="icon-tile"><Activity size={17} /></div><div><p className="eyebrow">Gateway metrics</p><h2 className="mt-1 text-lg font-semibold text-white">Counters and gauges</h2></div></div>{metrics ? <div className="mt-6 space-y-3">{[...counters, ...gauges].map(([key, value]) => <div className="metric-row" key={key}><span className="font-mono text-xs text-slate-400">{key}</span><strong className="font-mono text-sm text-white">{value}</strong></div>)}</div> : <EmptyState icon={Gauge} title="No metrics loaded" copy="Refresh telemetry to read the backend's real process-local metrics." />}</div></div><div className="panel p-6"><p className="eyebrow">Local activity</p><h2 className="mt-1 text-lg font-semibold text-white">Request timeline</h2><p className="mt-2 text-xs leading-5 text-slate-500">The backend does not expose payment event history, so this panel records actions taken in this browser session.</p><div className="mt-6">{activity.length ? activity.map((item) => <ActivityRow key={item.id} item={item} />) : <EmptyState icon={Activity} title="No activity yet" copy="Create a payment or refresh telemetry to begin." />}</div></div></div></>;
}

function SectionIntro({ eyebrow, title, copy, action }: { eyebrow: string; title: string; copy: string; action?: React.ReactNode }) { return <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end"><div className="max-w-2xl"><p className="eyebrow">{eyebrow}</p><h2 className="mt-3 text-3xl font-semibold tracking-tight text-white lg:text-4xl">{title}</h2><p className="mt-4 text-sm leading-7 text-slate-400">{copy}</p></div>{action && <div className="shrink-0">{action}</div>}</div>; }
function Field({ label, hint, wide, children }: { label: string; hint: string; wide?: boolean; children: React.ReactNode }) { return <label className={`${wide ? "sm:col-span-2" : ""} block`}><span className="field-label">{label}<span className="field-hint">{hint}</span></span><span className="mt-2 block">{children}</span></label>; }
function ResponsePanel({ result, error, payload, keyValue }: { result: ApiResult<unknown> | null; error: string; payload: PaymentRequest; keyValue: string }) { return <div className="panel overflow-hidden"><div className="flex items-center justify-between border-b border-line px-6 py-5"><div><p className="eyebrow">02 / gateway response</p><h2 className="mt-1 font-semibold text-white">Request inspector</h2></div>{result && <span className={`status-pill ${result.ok ? "border-mint/20 bg-mint/5 text-mint" : "border-rose-400/20 bg-rose-400/5 text-rose-300"}`}>{result.status} {result.ok ? "OK" : "ERROR"}</span>}</div><div className="p-6">{result ? <><div className="grid gap-3 text-xs text-slate-500 sm:grid-cols-2"><span>Request ID <strong className="ml-2 font-mono text-slate-300">{result.requestId.slice(0, 26)}…</strong></span><span>Recorded <strong className="ml-2 text-slate-300">{formatDate(result.at)}</strong></span></div><pre className="code-window mt-5">{JSON.stringify(result.body, null, 2)}</pre></> : <EmptyState icon={TerminalSquare} title="Waiting for a response" copy="The API response body and status code will appear here." />}</div>{error && <div className="mx-6 mb-6 rounded-xl border border-rose-400/20 bg-rose-400/5 p-4 text-sm text-rose-200">{error}</div>}<div className="border-t border-line bg-ink/30 px-6 py-4 text-xs text-slate-600">POST /payments · Idempotency-Key <span className="font-mono text-slate-500">{keyValue.slice(0, 20)}…</span> · payload {JSON.stringify(payload).length} bytes</div></div>; }
function PaymentCard({ payment }: { payment: PaymentResponse | null }) { return <div className="panel p-6">{payment ? <><div className="flex items-start justify-between"><div><p className="eyebrow">Persisted resource</p><h2 className="mt-2 break-all font-mono text-sm text-white">{payment.id}</h2></div><StatusBadge status={payment.status} /></div><div className="mt-7 grid grid-cols-2 gap-4"><Stat label="Amount" value={`${payment.currency} ${payment.amount.toFixed(2)}`} /><Stat label="Provider" value={payment.provider_id || "Pending"} mono /><Stat label="Provider status" value={payment.provider_status || "—"} /><Stat label="Source" value="GET /payments/:id" /></div></> : <EmptyState icon={Database} title="Payment resource" copy="Once created, the returned payment will be summarized here with its provider state." />}</div>; }
function ComparisonCard({ first, second }: { first: ApiResult<unknown> | null; second: ApiResult<unknown> | null }) { return <div className="panel overflow-hidden"><div className="border-b border-line px-6 py-5"><p className="eyebrow">Response comparison</p><h2 className="mt-1 font-semibold text-white">Before and after</h2></div><div className="grid md:grid-cols-2"><CompareColumn title="First request" result={first} /><CompareColumn title="Latest request" result={second} border /></div>{first && second && <div className="border-t border-line bg-cyan/[.03] px-6 py-4 text-xs text-slate-400"><span className="font-semibold text-cyan">Observed:</span> {first.status === second.status ? "same status code returned" : `status changed from ${first.status} to ${second.status}`} while the same idempotency key was reused.</div>}</div>; }
function CompareColumn({ title, result, border }: { title: string; result: ApiResult<unknown> | null; border?: boolean }) { return <div className={`${border ? "border-t border-line md:border-l md:border-t-0" : ""} p-6`}><div className="flex items-center justify-between"><p className="text-xs font-medium text-slate-400">{title}</p>{result && <span className="font-mono text-xs text-slate-500">{result.status}</span>}</div><pre className="code-window mt-4 max-h-80">{result ? JSON.stringify(result.body, null, 2) : "No request yet"}</pre></div>; }
function MetricsSummary({ metrics }: { metrics: MetricsSnapshot | null }) { const values = Object.entries(metrics?.counters || {}).filter(([key]) => key.includes("recovery") || key.includes("http")); return <div className="panel p-6"><div className="flex items-center gap-3"><div className="icon-tile"><Gauge size={17} /></div><div><p className="eyebrow">Live telemetry</p><h2 className="mt-1 text-lg font-semibold text-white">Recovery signals</h2></div></div><div className="mt-6 space-y-3">{values.length ? values.slice(0, 8).map(([key, value]) => <div className="metric-row" key={key}><span className="truncate font-mono text-[11px] text-slate-500">{key}</span><strong className="font-mono text-sm text-white">{value}</strong></div>) : <p className="text-sm leading-6 text-slate-500">No recovery counters have been emitted in the gateway process yet. Workers expose their own process-local metrics.</p>}</div></div>; }
function RuntimeCard({ icon: Icon, label, value, detail, tone }: { icon: typeof Server; label: string; value: string; detail: string; tone: "mint" | "cyan" | "amber" }) { return <div className="panel p-5"><div className="flex items-center gap-3"><div className={`icon-tile icon-tile-${tone}`}><Icon size={17} /></div><div><p className="eyebrow">{label}</p><p className={`mt-1 text-xl font-semibold ${tone === "mint" ? "text-mint" : tone === "amber" ? "text-amber" : "text-cyan"}`}>{value}</p></div></div><p className="mt-4 text-xs text-slate-500">{detail}</p></div>; }
function LabSignal({ title, value, tone }: { title: string; value: string; tone: "cyan" | "amber" | "mint" }) { return <div className="rounded-xl border border-line bg-ink/50 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-600">{title}</p><p className={`mt-2 text-sm font-semibold ${tone === "cyan" ? "text-cyan" : tone === "amber" ? "text-amber" : "text-mint"}`}>{value}</p></div>; }
function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) { return <div><p className="text-[10px] uppercase tracking-wider text-slate-600">{label}</p><p className={`mt-2 truncate text-sm text-slate-200 ${mono ? "font-mono text-xs" : "font-medium"}`}>{value}</p></div>; }
function StatusBadge({ status }: { status: PaymentStatus }) { const item = statusCopy[status]; const Icon = item.icon; return <span className={`status-pill border ${item.tone}`}><Icon size={13} className={status === "processing" ? "animate-spin" : ""} />{item.label}</span>; }
function Lifecycle({ status }: { status: PaymentStatus }) { const steps: PaymentStatus[] = ["pending", "processing", "completed"]; const activeIndex = status === "failed" || status === "requires_reconciliation" ? 1 : Math.max(0, steps.indexOf(status)); return <div className="mt-6 flex items-center">{steps.map((step, index) => <div className="flex min-w-0 flex-1 items-center" key={step}><div className={`h-2.5 w-2.5 shrink-0 rounded-full ${index <= activeIndex ? "bg-cyan shadow-[0_0_12px_rgba(87,217,255,.7)]" : "bg-slate-700"}`} /><span className={`ml-2 truncate text-xs ${index <= activeIndex ? "text-slate-200" : "text-slate-600"}`}>{statusCopy[step].label}</span>{index < steps.length - 1 && <div className={`mx-3 h-px min-w-4 flex-1 ${index < activeIndex ? "bg-cyan/60" : "bg-line"}`} />}</div>)}{status === "failed" && <span className="ml-3 text-xs text-rose-300">failed</span>}{status === "requires_reconciliation" && <span className="ml-3 text-xs text-amber">reconcile</span>}</div>; }
function ActivityRow({ item }: { item: ActivityItem }) { return <div className="activity-row"><span className={`activity-dot activity-dot-${item.status}`} /><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3"><p className="truncate text-sm text-slate-300">{item.title}</p><time className="shrink-0 text-[10px] text-slate-600">{formatDate(item.at)}</time></div><p className="mt-1 truncate font-mono text-[11px] text-slate-600">{item.detail}</p></div></div>; }
function EmptyState({ icon: Icon, title, copy }: { icon: typeof Database; title: string; copy: string }) { return <div className="flex min-h-36 flex-col items-center justify-center text-center"><Icon size={24} className="text-slate-700" /><p className="mt-3 text-sm font-medium text-slate-400">{title}</p><p className="mt-1 max-w-xs text-xs leading-5 text-slate-600">{copy}</p></div>; }
function getError(body: unknown) { if (body && typeof body === "object" && "error" in body) return String((body as { error: unknown }).error); return "The gateway returned an unexpected response."; }
function isPayment(body: unknown): body is PaymentResponse { return Boolean(body && typeof body === "object" && "id" in body && "status" in body && "amount" in body); }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }

export default App;
