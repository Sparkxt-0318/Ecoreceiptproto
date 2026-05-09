// Runtime mirrors of the type definitions in ./types.ts.
//
// Schemas exist for two reasons:
//   1. Validate every LLM-produced object before it enters the pipeline.
//      The structural rules below are defense-in-depth against a model
//      hallucinating empty URLs, missing citations, or out-of-range tiers.
//   2. Validate persisted objects (cache reads) so a corrupt cache entry
//      can't crash a downstream stage.
//
// Source of truth for shapes is types.ts. If the two ever drift, types.ts wins
// at compile time and these schemas should be updated to match.

import { z } from 'zod';

// ─── Primitives ──────────────────────────────────────────────────────────────

const Sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'must be lowercase sha256 hex (64 chars)');

const SourceTierSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

const ClaimTypeSchema = z.enum([
  'quantitative',
  'qualitative',
  'certification',
  'disclosure',
  'comparison',
  'factual',
]);

const VerdictTypeSchema = z.enum([
  'VERIFIED',
  'FAILED',
  'CONTRADICTED_BY_PRIMARY',
  'INSUFFICIENT_EVIDENCE',
]);

const StatusBadgeSchema = z.enum([
  'VERIFIED_SUSTAINABLE',
  'MIXED_SIGNALS',
  'UNSUBSTANTIATED',
  'GREENWASHING_DETECTED',
  'NO_CLAIMS_CONVENTIONAL',
]);

const ConfidenceGradeSchema = z.enum(['A', 'B', 'C']);

const EvidenceSourceSchema = z.enum([
  'openfoodfacts',
  'sec_edgar',
  'epa_envirofacts',
  'aqueduct',
  'newsapi',
  'brand_site',
]);

const EvidenceStatusSchema = z.enum(['ok', 'timeout', 'empty', 'error']);

// ─── LLM-produced shapes (strict structural enforcement) ─────────────────────

/** Stage 1 vision call output. Confidence in [0,1]; <0.5 → caller throws. */
export const ProductCandidateSchema = z.object({
  name: z.string(),
  manufacturer_guess: z.string(),
  category_guess: z.string(),
  confidence: z.number().min(0).max(1),
});

/**
 * Stage 4 claim extraction output. One element of the array the LLM returns.
 * `id` regex catches the LLM emitting "1" or "claim_1" or "claim-foo".
 * `source_url` must be a real URL — empty strings or "n/a" fail at parse time.
 */
export const RawClaimSchema = z.object({
  id: z.string().regex(/^claim-\d+$/, 'id must be of the form "claim-N"'),
  quote: z.string().min(1),
  type_hint: ClaimTypeSchema,
  source_url: z.string().url(),
});

export const RawClaimsArraySchema = z.array(RawClaimSchema);

/**
 * Stage 5 specialist output. Discriminated on `verdict` because the two
 * legitimate output shapes are different:
 *
 *   - SourcedVerdict (VERIFIED / FAILED / CONTRADICTED_BY_PRIMARY): the
 *     specialist is taking a substantive position and MUST cite a source.
 *     Strict URL + tier required. Empty/invalid here is the schema-level
 *     half of the honesty gate (Stage 7 is the runtime half).
 *
 *   - InsufficientEvidenceVerdict: the specialist is honestly admitting it
 *     has no source. Empty `rebuttal_source_url` and null
 *     `rebuttal_source_tier` are valid in this branch — the verdict_type
 *     is already self-classified, so Stage 7's tier check is moot.
 *     Preserves the real `provision_cited` and `reasoning` instead of
 *     forcing a "output validation failed" boilerplate replacement.
 *
 * Length caps raised: rebuttal_quote 500→800, reasoning 400→600. Phase-7
 * diagnostic showed the model writes longer reasoning paragraphs in the
 * IE case (it explains what was missing) and longer quotes when source
 * passages exceed 500 chars.
 */
const _commonSpecialistFields = {
  provision_cited: z.string().min(1, 'provision_cited must not be empty'),
  reasoning: z.string().max(600),
} as const;

const SourcedVerdictSchema = z.object({
  verdict: z.enum(['VERIFIED', 'FAILED', 'CONTRADICTED_BY_PRIMARY']),
  ..._commonSpecialistFields,
  rebuttal_quote: z.string().max(800),
  rebuttal_source_url: z.string().url(),
  rebuttal_source_tier: SourceTierSchema,
});

const InsufficientEvidenceVerdictSchema = z.object({
  verdict: z.literal('INSUFFICIENT_EVIDENCE'),
  ..._commonSpecialistFields,
  rebuttal_quote: z.string().max(800).default(''),
  // Permissive: an empty string OR a valid URL. Specialists honestly
  // self-reporting IE need not have a source to cite.
  rebuttal_source_url: z
    .union([z.string().url(), z.literal('')])
    .default(''),
  // Permissive: 0 (model emits this when "no tier"), 1-5, or null. Output
  // mapping in base.ts normalizes 0 and null → 5 so downstream code sees
  // a SourceTier. The IE branch of the tier validator already short-
  // circuits, so the normalized value never affects the receipt's
  // honesty-gate behavior.
  rebuttal_source_tier: z
    .union([z.literal(0), SourceTierSchema, z.null()])
    .default(null),
});

export const RawSpecialistOutputSchema = z.discriminatedUnion('verdict', [
  SourcedVerdictSchema,
  InsufficientEvidenceVerdictSchema,
]);

// ─── Internal pipeline shapes ────────────────────────────────────────────────

export const ProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  manufacturer: z.string().min(1),
  upc: z.string().optional(),
  category: z.string().min(1),
  manufacturer_domain: z.string().optional(),
  esg_report_url: z.string().url().optional(),
  product_image_url: z.string().url().optional(),
});

export const ClaimSchema = z.object({
  id: z.string().regex(/^claim-\d+$/),
  quote: z.string().min(1),
  type_hint: ClaimTypeSchema,
  source_url: z.string().url(),
  source_hash: Sha256HexSchema,
  retrieval_date: z.string().datetime(),
});

export const VerdictSchema = z.object({
  claim_id: z.string().min(1),
  verdict_type: VerdictTypeSchema,
  provision_cited: z.string(),
  rebuttal_quote: z.string(),
  rebuttal_source_url: z.string(),
  rebuttal_source_tier: SourceTierSchema,
  reasoning: z.string(),
  downgrade_reason: z.string().optional(),
});

export const EvidenceItemSchema = z.object({
  source: EvidenceSourceSchema,
  status: EvidenceStatusSchema,
  url: z.string().optional(),
  tier: SourceTierSchema,
  data: z.unknown(),
  fetched_at: z.string().datetime(),
  content_hash: Sha256HexSchema,
  provenance: z.literal('llm_summary').optional(),
});

export const RawEvidenceSchema = z.object({
  items: z.array(EvidenceItemSchema),
  degraded: z.boolean(),
});

export const FootprintSchema = z.object({
  category: z.string().min(1),
  percentile: z.number().min(0).max(100),
  co2e_kg: z.number(),
  water_l: z.number(),
  land_m2: z.number(),
  recycled_content_pct: z.number().min(0).max(100).nullable(),
  water_stress_baseline: z.number().min(0).max(5).nullable(),
  regulatory_regime_score: z.number().min(0).max(1).nullable(),
  certified_input_flag: z.boolean().nullable(),
  recyclability_score: z.number().min(0).max(1).nullable(),
  biodegradability_score: z.number().min(0).max(1).nullable(),
  repair_score: z.number().min(0).max(1).nullable(),
});

export const SubScoresSchema = z.object({
  claim_integrity: z.number().min(0).max(25).nullable(),
  carbon_footprint: z.number().min(0).max(25).nullable(),
  material_sourcing: z.number().min(0).max(25).nullable(),
  end_of_life: z.number().min(0).max(25).nullable(),
});

export const EcoReceiptSchema = z.object({
  product: ProductSchema,
  status_badge: StatusBadgeSchema,
  ecoscore: z.number().min(0).max(100),
  sub_scores: SubScoresSchema,
  headline_metrics: z.object({
    co2e_kg: z.number(),
    water_l: z.number(),
    land_m2: z.number(),
    category_percentile: z.number().min(0).max(100).optional(),
  }),
  verdicts: z.array(VerdictSchema),
  evidence_merkle_root: z.string(),
  confidence_grade: ConfidenceGradeSchema,
  generated_at: z.string().datetime(),
  pipeline_duration_ms: z.number().nonnegative(),
  pipeline_cost_usd: z.number().nonnegative(),
});

// ─── Inferred type aliases ───────────────────────────────────────────────────
// types.ts remains the source of truth; these are convenience exports for code
// that wants to talk in zod-inferred shapes (e.g. parsed LLM responses).

export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;
export type RawClaim = z.infer<typeof RawClaimSchema>;
export type RawSpecialistOutput = z.infer<typeof RawSpecialistOutputSchema>;
