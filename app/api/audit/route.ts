// /api/audit — POST endpoint that runs the detection pipeline.
//
// Two response modes:
//   - When the request includes `Accept: text/event-stream`, the route
//     returns an NDJSON stream of progress events terminating in either
//     a {type:"result", receipt} or {type:"error", error} chunk. Used by
//     the UI to render per-stage milestones.
//   - Otherwise, returns a single JSON receipt (or {error}). Backwards-
//     compatible with smoke tests and any programmatic caller.
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
  type ProgressEvent,
} from '@/lib/pipeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

async function parseInput(req: Request): Promise<
  | { ok: true; input: PipelineInput }
  | { ok: false; status: number; error: string }
> {
  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await req.json()) as { kind?: string; value?: string };
      if (body.kind !== 'text' || typeof body.value !== 'string' || body.value.length === 0) {
        return {
          ok: false,
          status: 400,
          error: 'expected { kind: "text", value: <non-empty string> }',
        };
      }
      return { ok: true, input: { kind: 'text', value: body.value } };
    }
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('image');
      if (!(file instanceof File)) {
        return {
          ok: false,
          status: 400,
          error: 'expected multipart form with "image" file field',
        };
      }
      const buf = Buffer.from(await file.arrayBuffer());
      return { ok: true, input: { kind: 'image', value: buf } };
    }
    return {
      ok: false,
      status: 415,
      error: `unsupported content-type: ${contentType}`,
    };
  } catch (e) {
    return {
      ok: false,
      status: 400,
      error: `failed to parse request: ${(e as Error).message}`,
    };
  }
}

export async function POST(req: Request): Promise<Response> {
  const parsed = await parseInput(req);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }
  const { input } = parsed;

  const wantsStream = (req.headers.get('accept') ?? '').includes('text/event-stream');

  if (!wantsStream) {
    // Legacy single-shot JSON path. Kept for smoke tests and anything else
    // that calls /api/audit programmatically without expecting a stream.
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

  // Streaming path: NDJSON, one event per line, terminating in result/error.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: ProgressEvent): void => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };

      try {
        const receipt = await runPipeline(input, { onProgress: write });
        write({ type: 'result', receipt });
      } catch (e) {
        if (e instanceof InsufficientProductDataError) {
          write({ type: 'error', error: e.message });
        } else {
          // eslint-disable-next-line no-console
          console.error('[/api/audit] pipeline error', e);
          write({ type: 'error', error: 'pipeline error — see server logs' });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      // Vercel/CDN buffering: NDJSON should pass through unbuffered.
      'X-Accel-Buffering': 'no',
    },
  });
}
