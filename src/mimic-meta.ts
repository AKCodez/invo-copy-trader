// mimicMeta for POST /dex/position/create — links our copy to the trader's trade.
//
// Field names and sources match the Invo web app (PerpsMimicMetaRecordDto, built
// from the copied trader's investment, i.e. the feed post's `update`):
//   portfolioId                  ← update.portfolio.id
//   creatorInvoUserId            ← update.owner.id
//   initialSourcePaperUpdateId   ← update.id
//   sourcePaperTradeBaseId       ← update.baseId
//   sourcePaperTradeBaseShortId  ← update.baseShortId  (the trader's baseShortId)

export interface MimicMeta {
  portfolioId: string;
  creatorInvoUserId: string;
  initialSourcePaperUpdateId: string;
  sourcePaperTradeBaseId: string;
  sourcePaperTradeBaseShortId: string;
}

export const MIMIC_META_FIELDS: (keyof MimicMeta)[] = [
  'portfolioId',
  'creatorInvoUserId',
  'initialSourcePaperUpdateId',
  'sourcePaperTradeBaseId',
  'sourcePaperTradeBaseShortId',
];

/** Build mimicMeta from a feed post's `update` (the trader's trade). Missing fields stay undefined. */
export function mimicMetaFromUpdate(update: any): Partial<MimicMeta> {
  return {
    portfolioId: update?.portfolio?.id,
    creatorInvoUserId: update?.owner?.id,
    initialSourcePaperUpdateId: update?.id,
    sourcePaperTradeBaseId: update?.baseId,
    sourcePaperTradeBaseShortId: update?.baseShortId,
  };
}

/** Fields that are missing or blank. */
export function missingMimicMetaFields(meta: Partial<Record<keyof MimicMeta, unknown>>): (keyof MimicMeta)[] {
  return MIMIC_META_FIELDS.filter(k => typeof meta[k] !== 'string' || !(meta[k] as string).trim());
}

/**
 * Validate mimicMeta passed to trade.ts. Throws unless every field is a
 * non-empty string — a copy must be linked to the trader's real trade.
 */
export function parseMimicMeta(raw: unknown): MimicMeta {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('mimicMeta must be a JSON object (pass the signal\'s mimicMeta)');
  }
  const obj = raw as Record<string, unknown>;
  // Old monitor output used these keys; Invo ignores them
  if (('baseId' in obj || 'baseShortId' in obj) && !('sourcePaperTradeBaseShortId' in obj)) {
    throw new Error('mimicMeta uses the old {baseId, baseShortId} keys — re-run monitor.ts and pass the new signal\'s mimicMeta');
  }
  const missing = missingMimicMetaFields(obj);
  if (missing.length) {
    throw new Error(`mimicMeta is missing ${missing.join(', ')}`);
  }
  const out = {} as MimicMeta;
  for (const k of MIMIC_META_FIELDS) out[k] = (obj[k] as string).trim();
  return out;
}

export const MANUAL_TRADE_ARG = 'manual';

/**
 * trade.ts's mimicMeta argument: the signal's mimicMeta as JSON, or `manual` for a
 * deliberate trade that copies nobody (returns null — no mimicMeta is sent, as the
 * Invo app does for its own trades). Throws when absent: never make up IDs.
 */
export function parseMimicMetaArg(arg: string | undefined): MimicMeta | null {
  if (arg === MANUAL_TRADE_ARG) return null;
  if (!arg?.trim()) {
    throw new Error(`mimicMeta is required: pass the signal's mimicMeta JSON, or '${MANUAL_TRADE_ARG}' for a trade that copies nobody`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(arg);
  } catch {
    throw new Error('mimicMeta is not valid JSON');
  }
  return parseMimicMeta(raw);
}
