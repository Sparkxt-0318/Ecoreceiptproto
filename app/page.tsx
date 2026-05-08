'use client';

import { useState } from 'react';

type Status = 'idle' | 'loading' | 'ok' | 'error';

export default function Page() {
  const [text, setText] = useState('Heinz Tomato Ketchup 14oz');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  async function submitText() {
    setStatus('loading');
    setError(null);
    setResult(null);
    try {
      const r = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'text', value: text }),
      });
      const json = await r.json();
      if (!r.ok) {
        setError(json.error ?? `${r.status} ${r.statusText}`);
        setStatus('error');
        return;
      }
      setResult(json);
      setStatus('ok');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }

  async function submitImage() {
    if (!file) return;
    setStatus('loading');
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const r = await fetch('/api/audit', { method: 'POST', body: fd });
      const json = await r.json();
      if (!r.ok) {
        setError(json.error ?? `${r.status} ${r.statusText}`);
        setStatus('error');
        return;
      }
      setResult(json);
      setStatus('ok');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, margin: '0 0 16px' }}>EcoReceipt MVP</h1>
      <p style={{ color: '#555', margin: '0 0 24px' }}>
        Greenwashing detection prototype. Submit a product name or photo;
        the pipeline returns a JSON receipt.
      </p>

      <section style={{ border: '1px solid #ddd', padding: 16, marginBottom: 16, background: '#fff' }}>
        <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>By name</h2>
        <input
          style={{
            width: '100%',
            padding: 8,
            fontFamily: 'inherit',
            fontSize: 14,
            border: '1px solid #ccc',
            boxSizing: 'border-box',
            marginBottom: 8,
          }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Heinz Tomato Ketchup 14oz"
        />
        <button
          onClick={submitText}
          disabled={status === 'loading' || !text.trim()}
          style={{ padding: '8px 16px', fontFamily: 'inherit' }}
        >
          {status === 'loading' ? 'Auditing…' : 'Audit'}
        </button>
      </section>

      <section style={{ border: '1px solid #ddd', padding: 16, marginBottom: 16, background: '#fff' }}>
        <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>By photo</h2>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ marginBottom: 8 }}
        />
        <br />
        <button
          onClick={submitImage}
          disabled={status === 'loading' || !file}
          style={{ padding: '8px 16px', fontFamily: 'inherit' }}
        >
          {status === 'loading' ? 'Auditing…' : 'Audit photo'}
        </button>
      </section>

      {error && (
        <div
          style={{
            border: '1px solid #c00',
            background: '#fee',
            padding: 12,
            marginBottom: 16,
            color: '#900',
          }}
        >
          {error}
        </div>
      )}

      {result !== null && (
        <section style={{ border: '1px solid #ddd', background: '#fff' }}>
          <h2 style={{ fontSize: 16, margin: 0, padding: 12, borderBottom: '1px solid #eee' }}>
            EcoReceipt
          </h2>
          <pre
            style={{
              margin: 0,
              padding: 12,
              fontSize: 12,
              overflow: 'auto',
              maxHeight: 600,
            }}
          >
            {JSON.stringify(result, null, 2)}
          </pre>
        </section>
      )}
    </main>
  );
}
