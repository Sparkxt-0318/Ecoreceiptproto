'use client';

import { useState } from 'react';

// Mirror of lib/pipeline/types.ts EcoReceipt shape — duplicated client-side
// so the UI doesn't pull in pipeline imports on the wire. If the receipt
// shape changes, this needs to be updated in lockstep.
type StatusBadge =
  | 'VERIFIED_SUSTAINABLE'
  | 'MIXED_SIGNALS'
  | 'UNSUBSTANTIATED'
  | 'GREENWASHING_DETECTED'
  | 'NO_CLAIMS_CONVENTIONAL';

type ConfidenceGrade = 'A' | 'B' | 'C';

type VerdictType =
  | 'VERIFIED'
  | 'FAILED'
  | 'CONTRADICTED_BY_PRIMARY'
  | 'INSUFFICIENT_EVIDENCE';

type Verdict = {
  claim_id: string;
  verdict_type: VerdictType;
  provision_cited: string;
  rebuttal_quote: string;
  rebuttal_source_url: string;
  rebuttal_source_tier: 1 | 2 | 3 | 4 | 5;
  reasoning: string;
  downgrade_reason?: string;
};

type EcoReceipt = {
  product: {
    id: string;
    name: string;
    manufacturer: string;
    category: string;
    manufacturer_domain?: string;
    esg_report_url?: string;
  };
  status_badge: StatusBadge;
  ecoscore: number;
  sub_scores: {
    claim_integrity: number | null;
    carbon_footprint: number | null;
    material_sourcing: number | null;
    end_of_life: number | null;
  };
  headline_metrics: {
    co2e_kg: number;
    water_l: number;
    land_m2: number;
    category_percentile?: number;
  };
  verdicts: Verdict[];
  evidence_merkle_root: string;
  confidence_grade: ConfidenceGrade;
  generated_at: string;
  pipeline_duration_ms: number;
  pipeline_cost_usd: number;
};

type Status = 'idle' | 'loading' | 'ok' | 'error';

type ProgressPhase =
  | 'resolve'
  | 'evidence'
  | 'extract'
  | 'audit'
  | 'footprint'
  | 'finalize';

type ProgressEvent =
  | {
      type: 'phase';
      phase: ProgressPhase;
      done: boolean;
      message: string;
      completed?: number;
      total?: number;
    }
  | { type: 'result'; receipt: EcoReceipt }
  | { type: 'error'; error: string };

type MilestoneState = 'pending' | 'active' | 'done';

type Milestone = {
  phase: ProgressPhase;
  label: string;
  state: MilestoneState;
  detail?: string;
};

const MILESTONE_LABELS: Record<ProgressPhase, string> = {
  resolve: 'Identifying product',
  evidence: 'Gathering evidence',
  extract: 'Extracting claims',
  audit: 'Auditing claims',
  footprint: 'Calculating footprint',
  finalize: 'Sealing receipt',
};

const MILESTONE_ORDER: ProgressPhase[] = [
  'resolve',
  'evidence',
  'extract',
  'audit',
  'footprint',
  'finalize',
];

function initialMilestones(): Milestone[] {
  return MILESTONE_ORDER.map((phase) => ({
    phase,
    label: MILESTONE_LABELS[phase],
    state: 'pending',
  }));
}

// ─── Badge / verdict presentation ───────────────────────────────────────────

const BADGE_PRESENTATION: Record<
  StatusBadge,
  { label: string; bg: string; fg: string; tagline: string }
> = {
  VERIFIED_SUSTAINABLE: {
    label: 'Verified Sustainable',
    bg: '#d1fae5',
    fg: '#065f46',
    tagline: 'Environmental claims on this product are backed by primary sources.',
  },
  MIXED_SIGNALS: {
    label: 'Mixed Signals',
    bg: '#fef3c7',
    fg: '#92400e',
    tagline: 'Some claims hold up, others don’t. Read the verdicts below.',
  },
  UNSUBSTANTIATED: {
    label: 'Unsubstantiated',
    bg: '#fed7aa',
    fg: '#9a3412',
    tagline: 'This product makes claims we couldn’t verify against primary sources.',
  },
  GREENWASHING_DETECTED: {
    label: 'Greenwashing Detected',
    bg: '#fee2e2',
    fg: '#991b1b',
    tagline: 'At least one claim was contradicted by a primary regulatory or scientific source.',
  },
  NO_CLAIMS_CONVENTIONAL: {
    label: 'No Claims Found',
    bg: '#e2e8f0',
    fg: '#334155',
    tagline:
      'This product doesn’t advertise environmental claims, so there’s nothing for us to verify. We still scored its baseline footprint.',
  },
};

const VERDICT_PRESENTATION: Record<
  VerdictType,
  { label: string; bg: string; fg: string }
> = {
  VERIFIED: { label: 'Verified', bg: '#d1fae5', fg: '#065f46' },
  FAILED: { label: 'Failed', bg: '#fee2e2', fg: '#991b1b' },
  CONTRADICTED_BY_PRIMARY: {
    label: 'Contradicted',
    bg: '#fee2e2',
    fg: '#991b1b',
  },
  INSUFFICIENT_EVIDENCE: {
    label: 'Insufficient Evidence',
    bg: '#e2e8f0',
    fg: '#334155',
  },
};

const GRADE_EXPLANATIONS: Record<ConfidenceGrade, string> = {
  A: 'High confidence — all primary evidence sources were reachable and the claim coverage is comprehensive.',
  B: 'Moderate confidence — most evidence sources were reachable; some gaps remain.',
  C: 'Low confidence — significant evidence gaps. Treat the headline finding as preliminary.',
};

const SUB_SCORE_LABELS: Record<keyof EcoReceipt['sub_scores'], string> = {
  claim_integrity: 'Claim integrity',
  carbon_footprint: 'Carbon footprint',
  material_sourcing: 'Material sourcing',
  end_of_life: 'End of life',
};

// ─── Style primitives ───────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  padding: 16,
  background: '#fff',
};

const sectionHeading: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  margin: '0 0 12px',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatCategory(c: string): string {
  return c.split('.').map((s) => s.replace(/_/g, ' ')).join(' › ');
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function Page() {
  const [text, setText] = useState('Heinz Tomato Ketchup 14oz');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EcoReceipt | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [milestones, setMilestones] = useState<Milestone[]>(initialMilestones());

  function applyEvent(ev: ProgressEvent): void {
    if (ev.type === 'phase') {
      setMilestones((prev) => {
        const idx = prev.findIndex((m) => m.phase === ev.phase);
        if (idx === -1) return prev;
        const copy = prev.slice();
        const detail =
          ev.completed !== undefined && ev.total !== undefined
            ? `${ev.completed} / ${ev.total} — ${ev.message}`
            : ev.message;
        copy[idx] = {
          ...copy[idx]!,
          state: ev.done ? 'done' : 'active',
          detail,
        };
        // Mark any earlier still-pending milestones as done — the server is
        // free to skip emitting "done" events when stages complete fast.
        for (let i = 0; i < idx; i++) {
          if (copy[i]!.state !== 'done') copy[i] = { ...copy[i]!, state: 'done' };
        }
        return copy;
      });
    } else if (ev.type === 'result') {
      setMilestones((prev) =>
        prev.map((m) => ({ ...m, state: 'done' as MilestoneState })),
      );
      setResult(ev.receipt);
      setStatus('ok');
    } else if (ev.type === 'error') {
      setError(ev.error);
      setStatus('error');
    }
  }

  async function submit(body: BodyInit, headers: Record<string, string> = {}): Promise<void> {
    setStatus('loading');
    setError(null);
    setResult(null);
    setMilestones(initialMilestones());
    try {
      const r = await fetch('/api/audit', {
        method: 'POST',
        body,
        headers: { ...headers, Accept: 'text/event-stream' },
      });

      // Non-OK responses still come back as plain JSON (the server falls
      // through to the legacy path on parse-input failure). Try JSON first.
      const ct = r.headers.get('content-type') ?? '';
      if (!r.ok && !ct.includes('ndjson') && !ct.includes('event-stream')) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `${r.status} ${r.statusText}`);
        setStatus('error');
        return;
      }

      // Streaming path: read NDJSON line by line.
      const reader = r.body?.getReader();
      if (!reader) {
        setError('Streaming not supported by this browser/runtime.');
        setStatus('error');
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line) as ProgressEvent;
            applyEvent(ev);
          } catch {
            // Skip malformed lines; the next chunk may complete them.
          }
        }
      }
      if (buffer.trim()) {
        try {
          applyEvent(JSON.parse(buffer) as ProgressEvent);
        } catch {
          // tolerate trailing partial
        }
      }
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }

  function submitText(): void {
    void submit(JSON.stringify({ kind: 'text', value: text }), {
      'Content-Type': 'application/json',
    });
  }

  function submitImage(): void {
    if (!file) return;
    const fd = new FormData();
    fd.append('image', file);
    void submit(fd);
  }

  return (
    <main
      style={{
        maxWidth: 920,
        margin: '0 auto',
        padding: '24px 20px 60px',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: '#0f172a',
      }}
    >
      <style>{`@keyframes eco-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, margin: '0 0 4px', fontWeight: 700 }}>
          EcoReceipt
        </h1>
        <p style={{ color: '#64748b', margin: 0, fontSize: 14 }}>
          Independent audit of environmental claims on consumer products.
        </p>
      </header>

      <section style={{ ...cardStyle, marginBottom: 16 }}>
        <h2 style={sectionHeading}>Submit a product</h2>
        <input
          style={{
            width: '100%',
            padding: '10px 12px',
            fontFamily: 'inherit',
            fontSize: 15,
            border: '1px solid #cbd5e1',
            borderRadius: 6,
            boxSizing: 'border-box',
            marginBottom: 10,
          }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Heinz Tomato Ketchup 14oz"
        />
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={submitText}
            disabled={status === 'loading' || !text.trim()}
            style={{
              padding: '10px 20px',
              fontFamily: 'inherit',
              fontSize: 14,
              fontWeight: 500,
              background: status === 'loading' ? '#94a3b8' : '#0f172a',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: status === 'loading' ? 'wait' : 'pointer',
            }}
          >
            {status === 'loading' ? 'Auditing…' : 'Audit by name'}
          </button>
          <span style={{ color: '#94a3b8', fontSize: 13 }}>or</span>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ fontSize: 13 }}
          />
          <button
            onClick={submitImage}
            disabled={status === 'loading' || !file}
            style={{
              padding: '10px 20px',
              fontFamily: 'inherit',
              fontSize: 14,
              fontWeight: 500,
              background: !file || status === 'loading' ? '#94a3b8' : '#0f172a',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: !file || status === 'loading' ? 'not-allowed' : 'pointer',
            }}
          >
            Audit photo
          </button>
        </div>
        {status === 'loading' && (
          <p style={{ color: '#64748b', fontSize: 13, margin: '12px 0 0' }}>
            Running the audit pipeline. Usually 10–60 seconds depending on how much
            evidence is reachable.
          </p>
        )}
      </section>

      {(status === 'loading' || status === 'ok' || status === 'error') && (
        <Milestones milestones={milestones} status={status} />
      )}

      {error && (
        <div
          style={{
            border: '1px solid #fca5a5',
            background: '#fef2f2',
            padding: 14,
            marginBottom: 16,
            color: '#991b1b',
            borderRadius: 6,
            fontSize: 14,
          }}
        >
          <strong>Error:</strong> {error}
        </div>
      )}

      {result && <Receipt receipt={result} showRaw={showRaw} setShowRaw={setShowRaw} />}
    </main>
  );
}

// ─── Receipt presentation ───────────────────────────────────────────────────

function Receipt({
  receipt,
  showRaw,
  setShowRaw,
}: {
  receipt: EcoReceipt;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
}): React.ReactElement {
  const badge = BADGE_PRESENTATION[receipt.status_badge];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Product header */}
      <div style={cardStyle}>
        <h2 style={{ fontSize: 22, margin: '0 0 4px', fontWeight: 600 }}>
          {receipt.product.name}
        </h2>
        <p style={{ margin: '0 0 2px', color: '#475569', fontSize: 14 }}>
          by <strong>{receipt.product.manufacturer}</strong>
        </p>
        <p style={{ margin: 0, color: '#94a3b8', fontSize: 12 }}>
          Category: {formatCategory(receipt.product.category)}
        </p>
      </div>

      {/* Verdict card — the headline */}
      <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
        <div
          style={{
            background: badge.bg,
            color: badge.fg,
            padding: '20px 20px 16px',
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              opacity: 0.7,
              marginBottom: 4,
            }}
          >
            Verdict
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, marginBottom: 8 }}>
            {badge.label}
          </div>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{badge.tagline}</p>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr',
            borderTop: '1px solid #e2e8f0',
          }}
        >
          {/* EcoScore bar */}
          <div style={{ padding: 16, borderRight: '1px solid #e2e8f0' }}>
            <div style={{ ...sectionHeading, margin: '0 0 8px' }}>EcoScore</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 32, fontWeight: 700 }}>
                {receipt.ecoscore}
              </span>
              <span style={{ color: '#94a3b8', fontSize: 14 }}>/ 100</span>
            </div>
            <div
              style={{
                height: 8,
                background: '#e2e8f0',
                borderRadius: 4,
                marginTop: 10,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${receipt.ecoscore}%`,
                  background: scoreColor(receipt.ecoscore),
                  transition: 'width 0.3s',
                }}
              />
            </div>
            <p style={{ margin: '8px 0 0', color: '#64748b', fontSize: 12 }}>
              Composite of carbon footprint, material sourcing, end-of-life, and claim integrity.
            </p>
          </div>
          {/* Confidence grade */}
          <div style={{ padding: 16 }}>
            <div style={{ ...sectionHeading, margin: '0 0 8px' }}>Confidence</div>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 44,
                height: 44,
                borderRadius: 22,
                background: gradeColor(receipt.confidence_grade),
                color: '#fff',
                fontWeight: 700,
                fontSize: 22,
              }}
            >
              {receipt.confidence_grade}
            </div>
            <p style={{ margin: '10px 0 0', color: '#64748b', fontSize: 12, lineHeight: 1.5 }}>
              {GRADE_EXPLANATIONS[receipt.confidence_grade]}
            </p>
          </div>
        </div>
      </div>

      {/* Headline metrics */}
      <div style={cardStyle}>
        <h3 style={sectionHeading}>Per-unit footprint</h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 16,
          }}
        >
          <Metric
            label="CO₂ emissions"
            value={`${receipt.headline_metrics.co2e_kg} kg`}
            note={
              receipt.headline_metrics.category_percentile != null
                ? `~${receipt.headline_metrics.category_percentile}th percentile in category`
                : undefined
            }
          />
          <Metric
            label="Water use"
            value={`${receipt.headline_metrics.water_l.toLocaleString()} L`}
          />
          <Metric
            label="Land use"
            value={`${receipt.headline_metrics.land_m2} m²`}
          />
        </div>
      </div>

      {/* Sub-scores */}
      <div style={cardStyle}>
        <h3 style={sectionHeading}>Sub-scores (each 0–25)</h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 12,
          }}
        >
          {(Object.keys(receipt.sub_scores) as Array<keyof EcoReceipt['sub_scores']>).map(
            (k) => (
              <SubScore key={k} label={SUB_SCORE_LABELS[k]} value={receipt.sub_scores[k]} />
            ),
          )}
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 12, color: '#94a3b8' }}>
          Dashes mean we couldn’t measure that dimension for this product. The EcoScore is
          rescaled across whichever sub-scores have data.
        </p>
      </div>

      {/* Verdicts (per-claim) */}
      <div style={cardStyle}>
        <h3 style={sectionHeading}>Claim verdicts</h3>
        {receipt.verdicts.length === 0 ? (
          <p style={{ margin: 0, color: '#64748b', fontSize: 14, lineHeight: 1.6 }}>
            We didn’t find any explicit environmental claims on this product’s
            marketing materials, so there’s nothing to verify. The footprint above is
            based on category baselines from peer-reviewed life-cycle data.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {receipt.verdicts.map((v) => (
              <VerdictRow key={v.claim_id} verdict={v} />
            ))}
          </div>
        )}
      </div>

      {/* Methodology + meta */}
      <div style={{ ...cardStyle, background: '#f8fafc' }}>
        <h3 style={sectionHeading}>How to read this receipt</h3>
        <ul
          style={{
            margin: 0,
            paddingLeft: 20,
            color: '#475569',
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          <li>
            We extract environmental claims from the manufacturer’s sustainability page
            and audit each one against six specialist checks.
          </li>
          <li>
            Verdicts may only cite Tier 1–3 sources (regulatory bodies, standards
            registries, peer-reviewed science). Anything Tier 4–5 (brand-controlled,
            social media) is automatically discounted.
          </li>
          <li>
            <strong>Insufficient Evidence</strong> means we couldn’t reach a primary
            source to confirm or deny the claim. It is not the same as &ldquo;false.&rdquo;
          </li>
          <li>
            Footprint metrics use category baselines from peer-reviewed life-cycle data
            (Our World in Data, Quantis, ICCT).
          </li>
        </ul>
        <div
          style={{
            marginTop: 14,
            paddingTop: 14,
            borderTop: '1px solid #e2e8f0',
            display: 'flex',
            justifyContent: 'space-between',
            color: '#94a3b8',
            fontSize: 12,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <span>Generated {new Date(receipt.generated_at).toLocaleString()}</span>
          <span>
            {formatDuration(receipt.pipeline_duration_ms)} · {formatCost(receipt.pipeline_cost_usd)}
          </span>
        </div>
      </div>

      {/* Raw JSON (collapsed) */}
      <div style={cardStyle}>
        <button
          onClick={() => setShowRaw(!showRaw)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            color: '#0f172a',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {showRaw ? '▾ Hide raw receipt JSON' : '▸ Show raw receipt JSON'}
        </button>
        {showRaw && (
          <pre
            style={{
              margin: '12px 0 0',
              padding: 12,
              fontSize: 11,
              overflow: 'auto',
              maxHeight: 400,
              background: '#0f172a',
              color: '#e2e8f0',
              borderRadius: 6,
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            }}
          >
            {JSON.stringify(receipt, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}): React.ReactElement {
  return (
    <div>
      <div style={{ ...sectionHeading, margin: '0 0 4px' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
      {note && <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

function SubScore({
  label,
  value,
}: {
  label: string;
  value: number | null;
}): React.ReactElement {
  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 6,
        padding: '10px 12px',
        background: '#fff',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: '#64748b',
          fontWeight: 500,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>
        {value === null ? <span style={{ color: '#cbd5e1' }}>—</span> : value}
      </div>
    </div>
  );
}

function VerdictRow({ verdict }: { verdict: Verdict }): React.ReactElement {
  const v = VERDICT_PRESENTATION[verdict.verdict_type];
  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 6,
        padding: 12,
        background: '#fff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span
          style={{
            background: v.bg,
            color: v.fg,
            padding: '2px 10px',
            borderRadius: 12,
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}
        >
          {v.label}
        </span>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{verdict.claim_id}</span>
      </div>
      <p style={{ margin: '0 0 8px', fontSize: 14, lineHeight: 1.5 }}>
        <strong>Standard checked:</strong> {verdict.provision_cited}
      </p>
      {verdict.reasoning && (
        <p style={{ margin: '0 0 8px', fontSize: 13, color: '#475569', lineHeight: 1.5 }}>
          {verdict.reasoning}
        </p>
      )}
      {verdict.rebuttal_quote && (
        <blockquote
          style={{
            margin: '8px 0',
            padding: '6px 10px',
            borderLeft: '3px solid #cbd5e1',
            color: '#334155',
            fontSize: 13,
            fontStyle: 'italic',
          }}
        >
          “{verdict.rebuttal_quote}”
        </blockquote>
      )}
      {verdict.rebuttal_source_url && (
        <p style={{ margin: '6px 0 0', fontSize: 12 }}>
          <a
            href={verdict.rebuttal_source_url}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: '#2563eb' }}
          >
            Source (tier {verdict.rebuttal_source_tier}) ↗
          </a>
        </p>
      )}
      {verdict.downgrade_reason && (
        <p style={{ margin: '6px 0 0', fontSize: 11, color: '#94a3b8' }}>
          Downgrade reason: {verdict.downgrade_reason}
        </p>
      )}
    </div>
  );
}

function scoreColor(s: number): string {
  if (s >= 75) return '#10b981';
  if (s >= 50) return '#f59e0b';
  return '#ef4444';
}

function gradeColor(g: ConfidenceGrade): string {
  if (g === 'A') return '#10b981';
  if (g === 'B') return '#f59e0b';
  return '#94a3b8';
}

// ─── Milestones (live progress) ─────────────────────────────────────────────

function Milestones({
  milestones,
  status,
}: {
  milestones: Milestone[];
  status: Status;
}): React.ReactElement {
  return (
    <section
      style={{
        ...cardStyle,
        marginBottom: 16,
        background: status === 'ok' ? '#f8fafc' : '#fff',
        opacity: status === 'ok' ? 0.85 : 1,
      }}
    >
      <h2 style={sectionHeading}>
        {status === 'loading' ? 'Audit in progress' : status === 'ok' ? 'Audit complete' : 'Audit'}
      </h2>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {milestones.map((m, i) => (
          <MilestoneRow key={m.phase} milestone={m} isLast={i === milestones.length - 1} />
        ))}
      </ul>
    </section>
  );
}

function MilestoneRow({
  milestone,
  isLast,
}: {
  milestone: Milestone;
  isLast: boolean;
}): React.ReactElement {
  const m = milestone;
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '8px 0',
        borderBottom: isLast ? 'none' : '1px solid #f1f5f9',
      }}
    >
      <MilestoneIcon state={m.state} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: m.state === 'active' ? 600 : 500,
            color:
              m.state === 'pending'
                ? '#94a3b8'
                : m.state === 'active'
                  ? '#0f172a'
                  : '#334155',
          }}
        >
          {m.label}
        </div>
        {m.detail && (
          <div
            style={{
              fontSize: 12,
              color: '#64748b',
              marginTop: 2,
              wordBreak: 'break-word',
            }}
          >
            {m.detail}
          </div>
        )}
      </div>
    </li>
  );
}

function MilestoneIcon({ state }: { state: MilestoneState }): React.ReactElement {
  if (state === 'done') {
    return (
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          borderRadius: 11,
          background: '#10b981',
          color: '#fff',
          fontSize: 14,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        ✓
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: 22,
          height: 22,
          flexShrink: 0,
          borderRadius: 11,
          border: '3px solid #cbd5e1',
          borderTopColor: '#0f172a',
          animation: 'eco-spin 0.8s linear infinite',
          boxSizing: 'border-box',
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 22,
        height: 22,
        flexShrink: 0,
        borderRadius: 11,
        border: '2px solid #e2e8f0',
        boxSizing: 'border-box',
      }}
    />
  );
}
