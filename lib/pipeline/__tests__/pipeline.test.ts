// EcoReceipt detection pipeline — foundation test suite.
//
// All 8 tests from the build spec live here. Tests 1–6 run real assertions
// against the pure-code stages (validate, score, grade, self-consistency).
// Tests 7 and 8 are marked `it.todo` because they exercise orchestrator paths
// (cache + evidence timeouts) that depend on stages not yet implemented.
//
// Every test must complete in <50ms on a clean runner.

import { describe, expect, it, vi } from 'vitest';

import {
  runSelfConsistencyCheck,
  SELF_CONSISTENCY_REASON,
} from '../stage5b_consistency.js';
import {
  validateVerdict,
  validateTiers,
  VALIDATION_REASONS,
} from '../stage7_validate.js';
import {
  computeEcoScore,
  computeStatusBadge,
  synthesizeScores,
} from '../stage8_score.js';
import { computeConfidenceGrade } from '../stage9_grade.js';
import type {
  Footprint,
  RawEvidence,
  SpecialistOutput,
  Verdict,
} from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    claim_id: 'claim-1',
    verdict_type: 'VERIFIED',
    provision_cited: 'FTC Green Guides §260.5(a)',
    rebuttal_quote: 'Tomatoes sourced from California, per 2023 10-K, p. 42.',
    rebuttal_source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=KHC',
    rebuttal_source_tier: 1,
    reasoning: 'Primary SEC filing confirms the sourcing claim verbatim.',
    ...overrides,
  };
}

function makeFootprint(overrides: Partial<Footprint> = {}): Footprint {
  return {
    category: 'food.condiment.ketchup',
    percentile: 50,
    co2e_kg: 1.2,
    water_l: 35,
    land_m2: 0.8,
    recycled_content_pct: 50,
    water_stress_baseline: 2.5,
    regulatory_regime_score: 0.8,
    certified_input_flag: false,
    recyclability_score: 0.5,
    biodegradability_score: 0.5,
    repair_score: 0.5,
    ...overrides,
  };
}

// ─── Test 1 — Tier validator: Tier-4-only verdict gets downgraded ────────────

describe('Stage 7: validateVerdict — tier check', () => {
  it('downgrades a Tier-4 (brand-controlled) verdict to INSUFFICIENT_EVIDENCE', () => {
    // arrange: a perfectly-formed verdict whose only sin is a brand-page rebuttal.
    const verdict = makeVerdict({
      rebuttal_source_tier: 4,
      rebuttal_source_url: 'https://www.kraftheinz.com/sustainability',
    });

    // act
    const result = validateVerdict(verdict);

    // assert: honesty gate refuses Tier 4.
    expect(result.verdict_type).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.downgrade_reason).toBe(VALIDATION_REASONS.TIER);
  });

  it('also rejects Tier 5 (social/marketing)', () => {
    const verdict = makeVerdict({ rebuttal_source_tier: 5 });
    const result = validateVerdict(verdict);
    expect(result.verdict_type).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.downgrade_reason).toBe(VALIDATION_REASONS.TIER);
  });
});

// ─── Test 2 — Tier validator: empty rebuttal_source_url gets downgraded ──────

describe('Stage 7: validateVerdict — empty url check', () => {
  it('downgrades a verdict with empty rebuttal_source_url even when all other fields are valid', () => {
    // arrange: Tier-1 source, real provision cited, but URL is an empty string.
    // Schema validation in RawSpecialistOutputSchema will block this at parse
    // time (defense in depth), but the runtime validator must also defend
    // against in-code-constructed Verdicts that bypass the schema.
    const verdict = makeVerdict({
      rebuttal_source_url: '',
      rebuttal_source_tier: 1,
    });

    const result = validateVerdict(verdict);

    expect(result.verdict_type).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.downgrade_reason).toContain('empty rebuttal source url');
  });
});

// ─── Test 3 — Tier validator: empty provision_cited gets downgraded ──────────

describe('Stage 7: validateVerdict — empty provision check', () => {
  it('downgrades a verdict with empty provision_cited (cite-or-die)', () => {
    const verdict = makeVerdict({
      provision_cited: '',
    });

    const result = validateVerdict(verdict);

    expect(result.verdict_type).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.downgrade_reason).toBe(VALIDATION_REASONS.EMPTY_PROVISION);
  });
});

// ─── Test 4 — Score synthesis is deterministic ───────────────────────────────

describe('Stage 8: synthesizeScores — determinism', () => {
  it('produces deeply-equal output across 10 runs with the same input', () => {
    // arrange: one VERIFIED, one FAILED, one INSUFFICIENT_EVIDENCE.
    const verdicts: Verdict[] = [
      makeVerdict({ claim_id: 'claim-1', verdict_type: 'VERIFIED' }),
      makeVerdict({ claim_id: 'claim-2', verdict_type: 'FAILED' }),
      makeVerdict({
        claim_id: 'claim-3',
        verdict_type: 'INSUFFICIENT_EVIDENCE',
      }),
    ];
    const footprint = makeFootprint();

    // act: 10 invocations.
    const runs = Array.from({ length: 10 }, () =>
      synthesizeScores(verdicts, footprint),
    );

    // assert: every run equals the first.
    for (const r of runs) {
      expect(r).toEqual(runs[0]);
    }
  });
});

// ─── Test 5 — No-claims path: footprint mode produces null claim_integrity ───

describe('Stage 8: synthesizeScores + computeEcoScore — no-claims path', () => {
  it('returns null claim_integrity and rescales ecoscore from 75 to 100', () => {
    // arrange: empty verdicts, footprint that drives the other 3 sub-scores
    // to exactly 25 each.
    const footprint = makeFootprint({
      percentile: 0, // → carbon_footprint = 25
      recycled_content_pct: 100, // 6 pts
      water_stress_baseline: 0, // 6 pts
      regulatory_regime_score: 1, // 6 pts
      certified_input_flag: true, // 7 pts → material_sourcing = 25
      recyclability_score: 1, // 9 pts
      biodegradability_score: 1, // 8 pts
      repair_score: 1, // 8 pts → end_of_life = 25
    });

    const sub = synthesizeScores([], footprint);
    const ecoscore = computeEcoScore(sub);

    expect(sub.claim_integrity).toBeNull();
    expect(sub.carbon_footprint).not.toBeNull();
    expect(sub.carbon_footprint).toBe(25);
    expect(sub.material_sourcing).toBe(25);
    expect(sub.end_of_life).toBe(25);
    // 25+25+25 = 75, scaled by 100/75 → 100
    expect(ecoscore).toBe(100);
  });

  it('rescales 12/12/12 to 48 (the worked example from the spec)', () => {
    // arrange: pick footprint inputs that produce ~12 in each sub-score.
    // carbon: percentile 52 → 25 * 0.48 = 12
    // material: 12 / 25 of cap. 12 = 6*0 (recycled 0%) + 6*1 (water_stress 0) + 6*1 (reg 1) + 0 (cert false) → 12
    // end of life: 9*0 + 8*1 + 8*0.5 = 12
    const footprint = makeFootprint({
      percentile: 52,
      recycled_content_pct: 0,
      water_stress_baseline: 0,
      regulatory_regime_score: 1,
      certified_input_flag: false,
      recyclability_score: 0,
      biodegradability_score: 1,
      repair_score: 0.5,
    });

    const sub = synthesizeScores([], footprint);
    const ecoscore = computeEcoScore(sub);

    expect(sub.claim_integrity).toBeNull();
    expect(sub.carbon_footprint).toBe(12);
    expect(sub.material_sourcing).toBe(12);
    expect(sub.end_of_life).toBe(12);
    // 36 / 75 * 100 = 48
    expect(ecoscore).toBe(48);
  });

  it('produces NO_CLAIMS_CONVENTIONAL badge when there are no claims', () => {
    const footprint = makeFootprint();
    const sub = synthesizeScores([], footprint);
    const ecoscore = computeEcoScore(sub);
    const badge = computeStatusBadge([], sub, ecoscore);
    expect(badge).toBe('NO_CLAIMS_CONVENTIONAL');
  });
});

// ─── Test 6 — Self-consistency catches false positives ───────────────────────

describe('Stage 5b: runSelfConsistencyCheck', () => {
  it('downgrades a CONTRADICTED_BY_PRIMARY verdict when re-run yields a different rebuttal_source_url', async () => {
    // arrange: original verdict cites aqueduct.../foo. Mock specialist returns aqueduct.../bar on re-run.
    const original: Verdict = makeVerdict({
      verdict_type: 'CONTRADICTED_BY_PRIMARY',
      rebuttal_source_tier: 1,
      rebuttal_source_url: 'https://aqueduct.wri.org/foo',
    });

    const specialist = vi.fn<() => Promise<SpecialistOutput>>().mockResolvedValueOnce({
      verdict_type: 'CONTRADICTED_BY_PRIMARY',
      provision_cited: 'WRI Aqueduct primary lookup',
      rebuttal_quote: 'baseline water stress = 4.2 (extremely high) at facility',
      rebuttal_source_url: 'https://aqueduct.wri.org/bar', // ← different
      rebuttal_source_tier: 1,
      reasoning: 'second run picked a different facility',
    });

    // act
    const result = await runSelfConsistencyCheck(original, specialist);

    // assert
    expect(result.verdict_type).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.downgrade_reason).toContain('self-consistency');
    expect(result.downgrade_reason).toBe(SELF_CONSISTENCY_REASON);
    expect(specialist).toHaveBeenCalledTimes(1);
  });

  it('keeps the verdict when both runs agree on rebuttal_source_url', async () => {
    const url = 'https://aqueduct.wri.org/foo';
    const original: Verdict = makeVerdict({
      verdict_type: 'CONTRADICTED_BY_PRIMARY',
      rebuttal_source_tier: 1,
      rebuttal_source_url: url,
    });

    const specialist = vi.fn<() => Promise<SpecialistOutput>>().mockResolvedValueOnce({
      verdict_type: 'CONTRADICTED_BY_PRIMARY',
      provision_cited: 'WRI Aqueduct primary lookup',
      rebuttal_quote: 'baseline water stress = 4.2 at facility',
      rebuttal_source_url: url,
      rebuttal_source_tier: 1,
      reasoning: 'consistent across runs',
    });

    const result = await runSelfConsistencyCheck(original, specialist);

    expect(result.verdict_type).toBe('CONTRADICTED_BY_PRIMARY');
    expect(result.downgrade_reason).toBeUndefined();
  });

  it('passes non-CONTRADICTED verdicts through without invoking the specialist', async () => {
    const verdict = makeVerdict({ verdict_type: 'VERIFIED' });
    const specialist = vi.fn<() => Promise<SpecialistOutput>>();
    const result = await runSelfConsistencyCheck(verdict, specialist);
    expect(result).toBe(verdict);
    expect(specialist).not.toHaveBeenCalled();
  });
});

// ─── Test 7 — Cache hit returns instantly with zero LLM calls ────────────────

describe('Stage 2 + Stage 10: cache round-trip', () => {
  it.todo(
    'returns cached EcoReceipt within 100ms with zero LLM calls on the second invocation within the same ISO week',
  );
  // Implementation note (when stage 2/10 land):
  //   1. mock the Anthropic client at the orchestrator boundary
  //   2. await runPipeline(input) once — assert mock.callCount === N (e.g. 8)
  //   3. const t0 = performance.now(); await runPipeline(input);
  //   4. assert mock.callCount === N (unchanged) and performance.now() - t0 < 100
  //   5. assert deepEqual on both returned receipts
  //   Use vi.useFakeTimers() to pin the ISO week.
});

// ─── Test 8 — Timeout doesn't crash pipeline ─────────────────────────────────

describe('Stage 3: evidence gather timeout handling', () => {
  // The honesty-gate side of this — that batch validation flags missing
  // streams as confidence_grade='C' — IS testable today against stage 9.
  it('forces confidence_grade C when 2+ evidence streams are timeout', () => {
    // arrange: 6 evidence items, 4 ok, 2 timeout. No verdicts (footprint mode).
    const evidence: RawEvidence = {
      items: [
        ...Array.from({ length: 4 }).map(
          (_, i): RawEvidence['items'][number] => ({
            source: 'openfoodfacts',
            status: 'ok',
            url: `https://example.com/${i}`,
            tier: 2,
            data: {},
            fetched_at: '2026-05-08T00:00:00.000Z',
            content_hash: 'a'.repeat(64),
          }),
        ),
        {
          source: 'newsapi',
          status: 'timeout',
          tier: 3,
          data: null,
          fetched_at: '2026-05-08T00:00:00.000Z',
          content_hash: 'a'.repeat(64),
        },
        {
          source: 'aqueduct',
          status: 'timeout',
          tier: 1,
          data: null,
          fetched_at: '2026-05-08T00:00:00.000Z',
          content_hash: 'a'.repeat(64),
        },
      ],
      degraded: false,
    };

    const grade = computeConfidenceGrade([], evidence);
    expect(grade).toBe('C');
  });

  it.todo(
    'Stage 3 returns within 5s wall-clock when 2 fetchers hang; pipeline completes with confidence_grade=C',
  );
  // Implementation note (when stage 3 lands):
  //   1. vi.useFakeTimers()
  //   2. mock 4 fetchers to resolve immediately, 2 to return a never-resolving promise
  //   3. const p = gatherEvidence(product); vi.advanceTimersByTime(4001);
  //   4. const evidence = await p; assert items.length === 6, 4 ok + 2 timeout
  //   5. assert wall clock <5s (fake-timer-aware measurement)
});

// ─── Bonus: validateTiers batch ──────────────────────────────────────────────

describe('Stage 7: validateTiers — batch behavior', () => {
  it('preserves valid verdicts and downgrades only the offending ones', () => {
    const valid = makeVerdict({ claim_id: 'claim-1' });
    const tier4 = makeVerdict({ claim_id: 'claim-2', rebuttal_source_tier: 4 });
    const result = validateTiers([valid, tier4]);
    expect(result[0]?.verdict_type).toBe('VERIFIED');
    expect(result[1]?.verdict_type).toBe('INSUFFICIENT_EVIDENCE');
  });
});
