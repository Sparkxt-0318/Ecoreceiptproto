// Stage 5 (audit orchestrator) tests. Mocks specialists at the dispatch
// table boundary so we don't need a real Anthropic client.

import { describe, expect, it, vi } from 'vitest';

import { runAudit } from '../stage5_audit.js';
import type { SpecialistResult } from '../specialists/base.js';
import type {
  Claim,
  EvidenceItem,
  RawEvidence,
  SpecialistOutput,
} from '../types.js';

function fakeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'claim-1',
    quote: 'Made with 70% recycled materials.',
    type_hint: 'quantitative',
    source_url: 'https://example.com/sustainability',
    source_hash: 'a'.repeat(64),
    retrieval_date: '2026-05-08T00:00:00.000Z',
    ...overrides,
  };
}

function fakeEvidence(): RawEvidence {
  const item = (
    source: EvidenceItem['source'],
    tier: EvidenceItem['tier'],
  ): EvidenceItem => ({
    source,
    status: 'ok',
    url: `https://example.com/${source}`,
    tier,
    data: { sample: 'evidence' },
    fetched_at: '2026-05-08T00:00:00.000Z',
    content_hash: 'a'.repeat(64),
  });
  return {
    items: [
      item('brand_site', 4),
      item('sec_edgar', 1),
      item('epa_envirofacts', 1),
      item('aqueduct', 3),
      item('newsapi', 5),
      item('openfoodfacts', 4),
    ],
    degraded: false,
  };
}

function fakeOutput(overrides: Partial<SpecialistOutput> = {}): SpecialistOutput {
  return {
    verdict_type: 'VERIFIED',
    provision_cited: 'FTC Green Guides §260.5(a)',
    rebuttal_quote: 'verbatim',
    rebuttal_source_url: 'https://example.com/sec_edgar',
    rebuttal_source_tier: 1,
    reasoning: 'evidence directly substantiates claim',
    ...overrides,
  };
}

function asResult(output: SpecialistOutput, cost = 0.001): SpecialistResult {
  return { output, cost_usd: cost, duration_ms: 100 };
}

describe('Stage 5: runAudit', () => {
  it('returns empty verdicts and zero cost when claims array is empty', async () => {
    const result = await runAudit([], fakeEvidence(), { specialists: {} });
    expect(result.verdicts).toEqual([]);
    expect(result.cost_usd).toBe(0);
  });

  it('only dispatches specialists matching the claim types present', async () => {
    const claims: Claim[] = [
      fakeClaim({ id: 'claim-1', type_hint: 'quantitative' }),
      fakeClaim({ id: 'claim-2', type_hint: 'qualitative' }),
      fakeClaim({ id: 'claim-3', type_hint: 'factual' }),
    ];
    const quant = vi.fn().mockResolvedValue(asResult(fakeOutput()));
    const qualifier = vi.fn().mockResolvedValue(asResult(fakeOutput()));
    const cert = vi.fn().mockResolvedValue(asResult(fakeOutput()));
    const scope = vi.fn().mockResolvedValue(asResult(fakeOutput()));
    const compare = vi.fn().mockResolvedValue(asResult(fakeOutput()));
    const contra = vi.fn().mockResolvedValue(asResult(fakeOutput()));

    await runAudit(claims, fakeEvidence(), {
      specialists: { quant, qualifier, cert, scope, compare, contra },
    });

    expect(quant).toHaveBeenCalledTimes(1);
    expect(qualifier).toHaveBeenCalledTimes(1);
    expect(contra).toHaveBeenCalledTimes(1);
    expect(cert).not.toHaveBeenCalled();
    expect(scope).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it('keeps a CONTRADICTED_BY_PRIMARY verdict when both contra runs cite the same URL', async () => {
    const url = 'https://aqueduct.wri.org/foo';
    const claims: Claim[] = [fakeClaim({ id: 'claim-1', type_hint: 'factual' })];
    const contra = vi
      .fn()
      .mockResolvedValueOnce(
        asResult(
          fakeOutput({
            verdict_type: 'CONTRADICTED_BY_PRIMARY',
            rebuttal_source_url: url,
            rebuttal_source_tier: 1,
          }),
        ),
      )
      .mockResolvedValueOnce(
        asResult(
          fakeOutput({
            verdict_type: 'CONTRADICTED_BY_PRIMARY',
            rebuttal_source_url: url,
            rebuttal_source_tier: 1,
          }),
        ),
      );

    const result = await runAudit(claims, fakeEvidence(), {
      specialists: { contra },
    });

    expect(contra).toHaveBeenCalledTimes(2); // initial + self-consistency re-run
    expect(result.verdicts[0]?.verdict_type).toBe('CONTRADICTED_BY_PRIMARY');
    expect(result.verdicts[0]?.downgrade_reason).toBeUndefined();
  });

  it('downgrades when self-consistency re-run yields a different rebuttal_source_url', async () => {
    const claims: Claim[] = [fakeClaim({ id: 'claim-1', type_hint: 'factual' })];
    const contra = vi
      .fn()
      .mockResolvedValueOnce(
        asResult(
          fakeOutput({
            verdict_type: 'CONTRADICTED_BY_PRIMARY',
            rebuttal_source_url: 'https://aqueduct.wri.org/foo',
            rebuttal_source_tier: 1,
          }),
        ),
      )
      .mockResolvedValueOnce(
        asResult(
          fakeOutput({
            verdict_type: 'CONTRADICTED_BY_PRIMARY',
            rebuttal_source_url: 'https://aqueduct.wri.org/bar',
            rebuttal_source_tier: 1,
          }),
        ),
      );

    const result = await runAudit(claims, fakeEvidence(), {
      specialists: { contra },
    });

    expect(result.verdicts[0]?.verdict_type).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.verdicts[0]?.downgrade_reason).toContain('self-consistency');
  });

  it('produces a synthetic INSUFFICIENT_EVIDENCE verdict when a specialist throws', async () => {
    const claims: Claim[] = [fakeClaim({ id: 'claim-1', type_hint: 'quantitative' })];
    const quant = vi.fn().mockRejectedValue(new Error('network blew up'));

    const result = await runAudit(claims, fakeEvidence(), {
      specialists: { quant },
    });

    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]?.verdict_type).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.verdicts[0]?.downgrade_reason).toBe('specialist threw');
    expect(result.verdicts[0]?.reasoning).toContain('network blew up');
  });

  it('does not re-run self-consistency on non-CONTRADICTED contra verdicts', async () => {
    const claims: Claim[] = [fakeClaim({ id: 'claim-1', type_hint: 'factual' })];
    const contra = vi
      .fn()
      .mockResolvedValueOnce(asResult(fakeOutput({ verdict_type: 'VERIFIED' })));

    await runAudit(claims, fakeEvidence(), { specialists: { contra } });

    expect(contra).toHaveBeenCalledTimes(1);
  });

  it('passes a cert evidence slice that includes the certifier-lookup synthetic item', async () => {
    const claims: Claim[] = [
      fakeClaim({
        id: 'claim-1',
        type_hint: 'certification',
        quote: 'FSC certified packaging.',
      }),
    ];
    const cert = vi
      .fn()
      .mockImplementation(async (_claim: Claim, evidence: EvidenceItem[]) => {
        // Assert the synthetic lookup item is present.
        const lookupItem = evidence.find(
          (it) =>
            typeof it.data === 'object' &&
            it.data !== null &&
            'lookup_status' in (it.data as object),
        );
        expect(lookupItem).toBeDefined();
        expect((lookupItem!.data as { lookup_status: string }).lookup_status).toBe(
          'not_fetched_in_mvp',
        );
        return asResult(fakeOutput());
      });

    await runAudit(claims, fakeEvidence(), { specialists: { cert } });
    expect(cert).toHaveBeenCalled();
  });
});
