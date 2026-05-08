// EPA Envirofacts FRS lookup. Tier 1 (federal regulatory disclosures).
// Returns up to 5 facilities matching parent_company_name.

import type { Product } from '../types.js';
import {
  buildItem,
  fetchWithTimeout,
  isAbortError,
  sha256Hex,
  type Fetcher,
} from './_base.js';

export type EpaFacility = {
  name: string;
  lat: number | null;
  lng: number | null;
};

export async function fetchEpaEnvirofacts(
  product: Product,
  fetcher: Fetcher = fetch,
) {
  const name = encodeURIComponent(product.manufacturer);
  const url = `https://data.epa.gov/efservice/FRS_FACILITY_SITE/PARENT_COMPANY_NAME/CONTAINING/${name}/JSON/rows/0:5`;
  try {
    const r = await fetchWithTimeout(url, { timeoutMs: 4000 }, fetcher);
    if (!r.ok) {
      return buildItem({ source: 'epa_envirofacts', status: 'error', url, data: null });
    }
    const text = await r.text();
    let arr: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) arr = parsed as Array<Record<string, unknown>>;
    } catch {
      // EPA sometimes returns HTML on errors
    }
    if (arr.length === 0) {
      return buildItem({
        source: 'epa_envirofacts',
        status: 'empty',
        url,
        data: null,
        content_hash: sha256Hex(text),
      });
    }
    const facilities: EpaFacility[] = arr.map((row) => {
      const latRaw = row.LATITUDE83 ?? row.latitude83;
      const lngRaw = row.LONGITUDE83 ?? row.longitude83;
      const lat = typeof latRaw === 'number' ? latRaw : Number(latRaw);
      const lng = typeof lngRaw === 'number' ? lngRaw : Number(lngRaw);
      return {
        name: String(row.PRIMARY_NAME ?? row.primary_name ?? 'unknown'),
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
      };
    });
    return buildItem({
      source: 'epa_envirofacts',
      status: 'ok',
      url,
      data: { facilities },
      content_hash: sha256Hex(text),
    });
  } catch (e) {
    return buildItem({
      source: 'epa_envirofacts',
      status: isAbortError(e) ? 'timeout' : 'error',
      url,
      data: null,
    });
  }
}
