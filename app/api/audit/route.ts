// /api/audit — POST endpoint that runs the detection pipeline.
//
// Accepts either:
//   - JSON body { kind: 'text', value: string }
//   - multipart/form-data with an 'image' field
//
// Returns the EcoReceipt JSON on success. 400 + {error} on
// InsufficientProductDataError (we couldn't ID the product). 500 + generic
// error on anything else; full error logged server-side.

import { NextResponse } from 'next/server';

import {
  InsufficientProductDataError,
  runPipeline,
  type PipelineInput,
} from '@/lib/pipeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  // Runtime env diagnostic — temporary; remove once root cause is confirmed.
  // eslint-disable-next-line no-console
  console.log('[/api/audit] runtime env check', {
    has_anthropic_key: !!process.env.ANTHROPIC_API_KEY,
    key_prefix: process.env.ANTHROPIC_API_KEY?.slice(0, 14) ?? '<undefined>',
    vercel_env: process.env.VERCEL_ENV,
    vercel_region: process.env.VERCEL_REGION,
    node_env: process.env.NODE_ENV,
    has_aws_key: !!process.env.AWS_ACCESS_KEY_ID,
  });

  let input: PipelineInput;

  const contentType = req.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('application/json')) {
      const body = (await req.json()) as { kind?: string; value?: string };
      if (body.kind !== 'text' || typeof body.value !== 'string' || body.value.length === 0) {
        return NextResponse.json(
          { error: 'expected { kind: "text", value: <non-empty string> }' },
          { status: 400 },
        );
      }
      input = { kind: 'text', value: body.value };
    } else if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('image');
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: 'expected multipart form with "image" file field' },
          { status: 400 },
        );
      }
      const buf = Buffer.from(await file.arrayBuffer());
      input = { kind: 'image', value: buf };
    } else {
      return NextResponse.json(
        { error: `unsupported content-type: ${contentType}` },
        { status: 415 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: `failed to parse request: ${(e as Error).message}` },
      { status: 400 },
    );
  }

  try {
    const receipt = await runPipeline(input);
    return NextResponse.json(receipt);
  } catch (e) {
    if (e instanceof InsufficientProductDataError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    // eslint-disable-next-line no-console
    console.error('[/api/audit] pipeline error', e);
    return NextResponse.json(
      { error: 'pipeline error — see server logs' },
      { status: 500 },
    );
  }
}
