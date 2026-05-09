// EcoReceipt detection pipeline — shared type definitions.
// Every stage in /lib/pipeline/* consumes and produces these types.
// Schemas in ./schemas.ts validate any of these that originate from an LLM.

// ─── Source classification ───────────────────────────────────────────────────
// Tier 1 = primary regulatory / scientific (SEC, EPA, peer-reviewed LCA).
// Tier 2 = recognized standards bodies & certifier registries (FSC DB, USDA, B Corp).
// Tier 3 = reputable journalism / NGO reports (Reuters, WRI, NewsAPI hits).
// Tier 4 = brand-controlled (manufacturer sustainability page, ESG report).
// Tier 5 = social media, retailer marketing copy, unsourced blogs.
// Tier validator (stage 7) rejects any verdict whose rebuttal cites only Tier 4–5.
export type SourceTier = 1 | 2 | 3 | 4 | 5;

// ─── Pipeline input ──────────────────────────────────────────────────────────
export type PipelineInput =
  | { kind: 'text'; value: string }
  | { kind: 'image'; value: Buffer };

// ─── Product identity (stage 1 output) ───────────────────────────────────────
export type Product = {
  id: string;                    // sha256 of normalized name
  name: string;
  manufacturer: string;
  upc?: string;
  category: string;              // dotted: "food.condiment.ketchup"
  manufacturer_domain?: string;
  esg_report_url?: string;
  product_image_url?: string;
};

// Vision-stage shape before OFF/web enrichment.
export type ProductCandidate = {
  name: string;
  manufacturer_guess: string;
  category_guess: string;
  confidence: number;            // [0, 1]
};

// ─── Evidence (stage 3 output) ───────────────────────────────────────────────
export type EvidenceStatus = 'ok' | 'timeout' | 'empty' | 'error';

export type EvidenceSource =
  | 'openfoodfacts'
  | 'sec_edgar'
  | 'epa_envirofacts'
  | 'aqueduct'
  | 'newsapi'
  | 'brand_site';

export type EvidenceItem = {
  source: EvidenceSource;
  status: EvidenceStatus;
  url?: string;
  tier: SourceTier;
  // TODO(post-MVP): replace `unknown` with a tagged union keyed on `source: EvidenceSource`
  // so per-source response shapes are checked at the type system rather than narrowed in specialists.
  data: unknown;
  /** ISO 8601 UTC timestamp of fetch completion. */
  fetched_at: string;
  /** sha256 hex (64 chars) of the canonical raw payload at fetch time. Stable across runs for the same upstream content. */
  content_hash: string;
  /**
   * Set to 'llm_summary' when the item came from the LLM-knowledge fallback
   * path (brand site unreachable / blocked). Stage 4 may consume it as
   * extraction input; Stage 7 must reject any verdict that cites a fallback
   * URL as its rebuttal source. Absent on normal fetches.
   */
  provenance?: 'llm_summary';
};

export type RawEvidence = {
  items: EvidenceItem[];
  // True iff ≥3 sources failed → downstream forces confidence_grade='C'.
  degraded: boolean;
};

// ─── Claims (stage 4 output) ─────────────────────────────────────────────────
export type ClaimType =
  | 'quantitative'
  | 'qualitative'
  | 'certification'
  | 'disclosure'
  | 'comparison'
  | 'factual';

export type Claim = {
  id: string;                    // claim-1, claim-2, ...
  quote: string;
  type_hint: ClaimType;
  source_url: string;
  source_hash: string;           // sha256 of fetched content the claim came from
  retrieval_date: string;        // ISO
};

// ─── Verdicts (stage 5 + 7 output) ───────────────────────────────────────────
export type VerdictType =
  | 'VERIFIED'
  | 'FAILED'
  | 'CONTRADICTED_BY_PRIMARY'
  | 'INSUFFICIENT_EVIDENCE';

export type Verdict = {
  claim_id: string;
  verdict_type: VerdictType;
  provision_cited: string;       // e.g. "FTC Green Guides §260.5(a)"
  rebuttal_quote: string;        // verbatim, ≤50 words
  rebuttal_source_url: string;
  rebuttal_source_tier: SourceTier;
  reasoning: string;             // ≤60 words
  // Populated by stage 7 when it downgrades a verdict; readers display this.
  downgrade_reason?: string;
};

// Raw specialist output before tier validation. Same shape, no claim_id (orchestrator stitches it).
export type SpecialistOutput = Omit<Verdict, 'claim_id' | 'downgrade_reason'>;

// ─── Footprint (stage 6 output, also consumed by stage 8) ────────────────────
export type Footprint = {
  category: string;
  // P10 best, P90 worst — used by carbon sub-score linear map.
  percentile: number;            // [0, 100]
  co2e_kg: number;
  water_l: number;
  land_m2: number;
  // Material/sourcing inputs. `null` ≠ 0 — it means "unknown / unmeasurable for this product".
  // Stage 8 must distinguish "missing input" from "zero" when computing material_sourcing.
  recycled_content_pct: number | null;     // [0, 100] when present
  water_stress_baseline: number | null;    // raw 0–5 Aqueduct baseline water stress score
  regulatory_regime_score: number | null;  // [0, 1]
  certified_input_flag: boolean | null;
  // End-of-life inputs. Same null semantics.
  recyclability_score: number | null;      // [0, 1]
  biodegradability_score: number | null;   // [0, 1]
  repair_score: number | null;             // [0, 1]
};

// ─── Scores (stage 8 output) ─────────────────────────────────────────────────
// `null` for any sub-score means "could not be computed due to insufficient input data."
// claim_integrity is null in the no-claims footprint-only path.
// The other three become null when their underlying Footprint inputs are all null.
// EcoScore computation in stage 8 sums non-null sub-scores and rescales to a 0–100 range.
export type SubScores = {
  claim_integrity: number | null;   // 0–25
  carbon_footprint: number | null;  // 0–25
  material_sourcing: number | null; // 0–25
  end_of_life: number | null;       // 0–25
};

export type StatusBadge =
  | 'VERIFIED_SUSTAINABLE'
  | 'MIXED_SIGNALS'
  | 'UNSUBSTANTIATED'
  | 'GREENWASHING_DETECTED'
  | 'NO_CLAIMS_CONVENTIONAL';

export type ConfidenceGrade = 'A' | 'B' | 'C';

// ─── Final receipt ───────────────────────────────────────────────────────────
export type EcoReceipt = {
  product: Product;
  status_badge: StatusBadge;
  ecoscore: number;              // 0–100
  sub_scores: SubScores;
  headline_metrics: {
    co2e_kg: number;
    water_l: number;
    land_m2: number;
    category_percentile?: number;
  };
  verdicts: Verdict[];           // empty in footprint-only mode
  evidence_merkle_root: string;
  confidence_grade: ConfidenceGrade;
  generated_at: string;
  pipeline_duration_ms: number;
  pipeline_cost_usd: number;
};

// ─── Pipeline telemetry ──────────────────────────────────────────────────────
// Each stage pushes one of these; orchestrator sums cost + duration into the
// receipt and logs the trace. Tests assert per-stage budget caps.
export type StageName =
  | 'resolve'
  | 'cache_check'
  | 'evidence'
  | 'extract'
  | 'audit'
  | 'self_consistency'
  | 'footprint'
  | 'validate'
  | 'score'
  | 'grade'
  | 'cache_write';

export type StageTrace = {
  stage: StageName;
  duration_ms: number;
  cost_usd: number;
  ok: boolean;
  note?: string;
};

// ─── Errors ──────────────────────────────────────────────────────────────────
// Thrown only by stage 1 when product can't be resolved with confidence ≥0.5.
// Every other failure mode produces an INSUFFICIENT_EVIDENCE verdict, never a throw.
export class InsufficientProductDataError extends Error {
  constructor(message = 'Could not resolve product with sufficient confidence') {
    super(message);
    this.name = 'InsufficientProductDataError';
  }
}

// ─── Streaming progress events ───────────────────────────────────────────────
// Emitted by runPipeline via the optional onProgress callback. Delivered to
// the UI as NDJSON when the route handler is in streaming mode. The shapes
// are intentionally narrow: the UI maps `phase` to a fixed milestone list
// and uses the `done` boolean to flip checkmarks.
//
// 'audit' phase additionally carries `completed`/`total` so the UI can show
// per-claim progress while the longest stage runs.
export type ProgressPhase =
  | 'resolve'
  | 'evidence'
  | 'extract'
  | 'audit'
  | 'footprint'
  | 'finalize';

export type ProgressEvent =
  | {
      type: 'phase';
      phase: ProgressPhase;
      done: boolean;
      message: string;
      /** Present on audit-phase events to drive the n/total counter. */
      completed?: number;
      total?: number;
    }
  | { type: 'result'; receipt: EcoReceipt }
  | { type: 'error'; error: string };
