// Stage 5 (audit orchestrator) tests. Mocks specialists at the dispatch
// table boundary so we don't need a real Anthropic client.
//
// Last describe block exercises runSpecialist directly with a mocked
// Anthropic client to verify rate-limit retry semantics.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

import { runAudit } from '../stage5_audit.js';
import {
  parseJsonWithRepair,
  repairJsonString,
  runSpecialist,
  __setRetrySleep,
  __resetRetrySleep,
  type SpecialistResult,
} from '../specialists/base.js';
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

  it('caps concurrent specialist dispatches at 3 in flight', async () => {
    // Build 9 claims that all hit the qualifier specialist.
    const claims: Claim[] = Array.from({ length: 9 }, (_, i) =>
      fakeClaim({ id: `claim-${i + 1}`, type_hint: 'qualitative' }),
    );

    let inFlight = 0;
    let maxInFlight = 0;
    const qualifier = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield to the event loop so other workers actually pick up tasks
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return asResult(fakeOutput());
    });

    const result = await runAudit(claims, fakeEvidence(), {
      specialists: { qualifier },
    });

    expect(qualifier).toHaveBeenCalledTimes(9);
    expect(result.verdicts).toHaveLength(9);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it('passes a cert evidence slice with not_fetched_in_mvp pointer when manufacturer unknown', async () => {
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
        // No `product` passed in deps → cert falls back to lookup-pointer mode.
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

  it('passes a cert evidence slice with real registry records when manufacturer is in KNOWN_CERTIFICATIONS', async () => {
    const claims: Claim[] = [
      fakeClaim({
        id: 'claim-1',
        type_hint: 'certification',
        quote: 'B Corp Certified since 2012.',
      }),
    ];
    const cert = vi
      .fn()
      .mockImplementation(async (_claim: Claim, evidence: EvidenceItem[]) => {
        const registryItem = evidence.find(
          (it) =>
            typeof it.data === 'object' &&
            it.data !== null &&
            'registry_records' in (it.data as object),
        );
        expect(registryItem).toBeDefined();
        const records = (
          registryItem!.data as { registry_records: Array<{ cert_name: string; registry_url: string }> }
        ).registry_records;
        expect(records.length).toBe(3); // B Corp, Fair Trade, 1% for the Planet
        expect(records.some((r) => r.cert_name === 'B Corporation')).toBe(true);
        expect(records[0]?.registry_url).toContain('bcorporation.net');
        expect(registryItem!.tier).toBe(2);
        return asResult(fakeOutput());
      });

    await runAudit(claims, fakeEvidence(), {
      specialists: { cert },
      product: {
        id: 'p',
        name: 'Patagonia Better Sweater',
        manufacturer: 'Patagonia, Inc.',
        category: 'apparel.fleece.synthetic',
      },
    });
    expect(cert).toHaveBeenCalled();
  });

  it('passes a cert evidence slice with empty registry_records when manufacturer is verifiably absent (Kraft Heinz, no B Corp)', async () => {
    const claims: Claim[] = [
      fakeClaim({
        id: 'claim-1',
        type_hint: 'certification',
        quote: 'B Corp Certified.',
      }),
    ];
    const cert = vi
      .fn()
      .mockImplementation(async (_claim: Claim, evidence: EvidenceItem[]) => {
        const registryItem = evidence.find(
          (it) =>
            typeof it.data === 'object' &&
            it.data !== null &&
            'registry_records' in (it.data as object),
        );
        expect(registryItem).toBeDefined();
        const records = (registryItem!.data as { registry_records: unknown[] })
          .registry_records;
        expect(records).toEqual([]); // empty = "verifiably absent"
        expect(registryItem!.tier).toBe(2);
        return asResult(fakeOutput());
      });

    await runAudit(claims, fakeEvidence(), {
      specialists: { cert },
      product: {
        id: 'p',
        name: 'Heinz Tomato Ketchup',
        manufacturer: 'Kraft Heinz',
        category: 'food.condiment.ketchup',
      },
    });
    expect(cert).toHaveBeenCalled();
  });
});

// ─── Specialist retry semantics ──────────────────────────────────────────────

describe('runSpecialist: 429/529 retry with exponential backoff', () => {
  // Replace the real sleep with an instant resolve so tests don't wait
  // 2/4 seconds. Real-time backoff is verified by the smoke run, not unit tests.
  beforeEach(() => __setRetrySleep(async () => undefined));
  afterEach(() => __resetRetrySleep());

  function rateLimitError(status: number): Error & { status: number } {
    const err = new Error(`${status} rate_limit_error`) as Error & { status: number };
    err.status = status;
    return err;
  }

  function clientThatThrowsThen<T>(throws: Error[], thenReturns: T): {
    client: Anthropic;
    create: ReturnType<typeof vi.fn>;
  } {
    let calls = 0;
    const create = vi.fn().mockImplementation(async () => {
      const i = calls++;
      if (i < throws.length) throw throws[i];
      return thenReturns;
    });
    return { client: { messages: { create } } as unknown as Anthropic, create };
  }

  const validRespBody = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          verdict: 'VERIFIED',
          provision_cited: 'FTC Green Guides §260.5(a)',
          rebuttal_quote: 'evidence quote',
          rebuttal_source_url: 'https://www.sec.gov/foo',
          rebuttal_source_tier: 1,
          reasoning: 'evidence directly substantiates claim',
        }),
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  };

  it('retries on two 429s then succeeds on the third attempt', async () => {
    const { client, create } = clientThatThrowsThen(
      [rateLimitError(429), rateLimitError(429)],
      validRespBody,
    );
    const claim: Claim = fakeClaim({ id: 'claim-1', type_hint: 'quantitative' });

    const result = await runSpecialist(
      { audit_type: 'quantitative', standard_name: 'FTC Green Guides §260.5' },
      claim,
      [],
      client,
    );

    expect(create).toHaveBeenCalledTimes(3);
    expect(result.output.verdict_type).toBe('VERIFIED');
    expect(result.output.provision_cited).toBe('FTC Green Guides §260.5(a)');
  });

  it('retries on 529 (overloaded) the same way as 429', async () => {
    const { client, create } = clientThatThrowsThen([rateLimitError(529)], validRespBody);
    const claim: Claim = fakeClaim({ id: 'claim-1', type_hint: 'quantitative' });

    const result = await runSpecialist(
      { audit_type: 'quantitative', standard_name: 'FTC Green Guides §260.5' },
      claim,
      [],
      client,
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.output.verdict_type).toBe('VERIFIED');
  });

  it('falls through to synthetic INSUFFICIENT after three 429s', async () => {
    const create = vi.fn().mockRejectedValue(rateLimitError(429));
    const client = { messages: { create } } as unknown as Anthropic;
    const claim: Claim = fakeClaim({ id: 'claim-1', type_hint: 'quantitative' });

    const result = await runSpecialist(
      { audit_type: 'quantitative', standard_name: 'FTC Green Guides §260.5' },
      claim,
      [],
      client,
    );

    expect(create).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(result.output.verdict_type).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.output.provision_cited).toBe('output validation failed');
  });

  it('does NOT retry on a 400 client error', async () => {
    const err = new Error('400 invalid request') as Error & { status: number };
    err.status = 400;
    const create = vi.fn().mockRejectedValue(err);
    const client = { messages: { create } } as unknown as Anthropic;
    const claim: Claim = fakeClaim({ id: 'claim-1', type_hint: 'quantitative' });

    const result = await runSpecialist(
      { audit_type: 'quantitative', standard_name: 'FTC Green Guides §260.5' },
      claim,
      [],
      client,
    );

    expect(create).toHaveBeenCalledTimes(1); // no retry
    expect(result.output.verdict_type).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('does NOT retry on a generic non-status error', async () => {
    const create = vi.fn().mockRejectedValue(new Error('network blew up'));
    const client = { messages: { create } } as unknown as Anthropic;
    const claim: Claim = fakeClaim({ id: 'claim-1', type_hint: 'quantitative' });

    const result = await runSpecialist(
      { audit_type: 'quantitative', standard_name: 'FTC Green Guides §260.5' },
      claim,
      [],
      client,
    );

    expect(create).toHaveBeenCalledTimes(1); // no retry
    expect(result.output.verdict_type).toBe('INSUFFICIENT_EVIDENCE');
  });
});

// ─── Defensive JSON repair ───────────────────────────────────────────────────

describe('parseJsonWithRepair: unescaped-quote repair', () => {
  it('parses well-formed JSON unchanged', () => {
    const ok = JSON.stringify({ verdict: 'VERIFIED', rebuttal_quote: 'fine' });
    expect(parseJsonWithRepair(ok)).toEqual({
      verdict: 'VERIFIED',
      rebuttal_quote: 'fine',
    });
  });

  it('repairs the exact Heinz claim-4 unescaped-quote pattern', () => {
    // Verbatim shape from /tmp/diagnose_heinz.log
    const raw = `\`\`\`json
{
  "verdict": "INSUFFICIENT_EVIDENCE",
  "provision_cited": "FTC Green Guides §260.4(b)",
  "rebuttal_quote": "Waste diversion from landfills" is listed as a general company commitment without specific substantiation",
  "rebuttal_source_url": "https://kraftheinz.com/__llm_fallback__",
  "rebuttal_source_tier": 4,
  "reasoning": "Evidence states a commitment but provides no quantifiable data."
}
\`\`\``;
    const parsed = parseJsonWithRepair<Record<string, unknown>>(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(parsed!.rebuttal_quote).toContain('Waste diversion from landfills');
    expect(parsed!.rebuttal_quote).toContain('general company commitment');
  });

  it('returns null when the repair regex cannot fix the input', () => {
    // Unbalanced braces — repair regex doesn't touch this.
    const broken = `{"verdict": "VERIFIED" "provision_cited": "p"}`;
    expect(parseJsonWithRepair(broken)).toBeNull();
  });

  it('repairJsonString is a no-op on already-escaped input', () => {
    const raw =
      '{"rebuttal_quote": "Waste diversion from landfills\\" is listed as a general company commitment"}';
    expect(repairJsonString(raw)).toBe(raw);
  });
});
