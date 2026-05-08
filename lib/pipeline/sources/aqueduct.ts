// WRI Aqueduct baseline water stress. Tier 3 (peer-reviewed scientific data).
//
// MVP: code-only lookup against the hardcoded region table in
// data/aqueduct_lookup.ts. Uses the first geocoded EPA facility's coords if
// available; otherwise returns 'empty' (we have no signal). Honest behavior —
// we are NOT making up a water stress score.

import { lookupWaterStress } from '../data/aqueduct_lookup.js';
import { sha256Hex } from './_base.js';
import { buildItem } from './_base.js';
import type { EpaFacility } from './epa_envirofacts.js';
import type { EvidenceItem } from '../types.js';

export function fetchAqueduct(epaItem: EvidenceItem | null): EvidenceItem {
  if (!epaItem || epaItem.status !== 'ok') {
    return buildItem({ source: 'aqueduct', status: 'empty', data: null });
  }
  const facilities = (epaItem.data as { facilities?: EpaFacility[] })?.facilities ?? [];
  const first = facilities.find((f) => f.lat !== null && f.lng !== null);
  if (!first || first.lat === null || first.lng === null) {
    return buildItem({ source: 'aqueduct', status: 'empty', data: null });
  }
  const result = lookupWaterStress(first.lat, first.lng);
  if (!result) {
    return buildItem({
      source: 'aqueduct',
      status: 'empty',
      data: { reason: 'no region within 500km of facility' },
    });
  }
  return buildItem({
    source: 'aqueduct',
    status: 'ok',
    url: 'local://aqueduct-mvp-lookup',
    data: {
      facility_name: first.name,
      lat: first.lat,
      lng: first.lng,
      ...result,
      score: result.score, // explicit so stage 6 can read it
    },
    content_hash: sha256Hex(`${first.name}|${result.matched_region}|${result.score}`),
  });
}
