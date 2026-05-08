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
  data: unknown;                 // shape varies by source; specialists pick what they need
  fetched_at: string;            // ISO
  content_hash: string;          // sha256 of fetched body, "" on non-ok
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
  // Material/sourcing inputs (0..1 unless noted).
  recycled_content_pct?: number; // [0, 100]
  water_stress_aqueduct?: number;// raw 0–5 baseline water stress score
  regulatory_regime_score?: number; // [0, 1]
  certified_input_flag?: boolean;
  // End-of-life inputs.
  recyclability?: number;        // [0, 1]
  biodegradability?: number;     // [0, 1]
  repair_score?: number;         // [0, 1]
};

// ─── Scores (stage 8 output) ─────────────────────────────────────────────────
export type SubScores = {
  claim_integrity: number | null;   // null when no claims existed → ecoscore rescales
  carbon_footprint: number;         // 0–25
  material_sourcing: number;        // 0–25
  end_of_life: number;              // 0–25
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
