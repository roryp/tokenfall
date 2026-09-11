import { z } from 'zod';
import type { TokenPriceSnapshot, TokenPricing, TokenRates } from '../shared/protocol.ts';

export const PRICING_API = 'https://prices.azure.com/api/retail/prices';
export const PRICE_REFRESH_MS = 60 * 60 * 1000;
const skus: Record<keyof TokenRates, string> = {
  input: '5.6 luna ShortCo Inp Std Gl',
  cachedInput: '5.6 luna ShortCo Cd Inp Std Gl',
  cacheWrite: '5.6 luna ShortCo Cd Wr Std Gl',
  output: '5.6 luna ShortCo Opt Std Gl',
};
const meterSchema = z.object({
  skuName: z.string(), productName: z.string(), meterName: z.string(), meterId: z.string(),
  retailPrice: z.number().finite().nonnegative(), unitOfMeasure: z.string(), currencyCode: z.string(),
  effectiveStartDate: z.string(), type: z.string(), armRegionName: z.string(),
  isPrimaryMeterRegion: z.boolean(), tierMinimumUnits: z.number().optional(),
});
const pageSchema = z.object({ Items: z.array(z.unknown()), NextPageLink: z.string().nullable().optional() });

export function selectTokenPricing(items: unknown[], model: string, region: string, now = Date.now()): TokenPriceSnapshot {
  if (model !== 'gpt-5.6-luna') throw new Error('No verified price-meter mapping for this model.');
  const candidates = items.map(item => meterSchema.safeParse(item)).filter(result => result.success).map(result => result.data);
  const usdPerMillion = {} as TokenRates;
  const meters = {} as TokenPriceSnapshot['meters'];
  for (const key of Object.keys(skus) as (keyof TokenRates)[]) {
    const matches = candidates.filter(item => item.productName === 'Azure OpenAI GPT5' && item.skuName === skus[key]
      && item.armRegionName === region && item.currencyCode === 'USD' && item.type === 'Consumption'
      && item.unitOfMeasure === '1M' && item.isPrimaryMeterRegion && (item.tierMinimumUnits ?? 0) === 0
      && Date.parse(item.effectiveStartDate) <= now)
      .sort((first, second) => Date.parse(second.effectiveStartDate) - Date.parse(first.effectiveStartDate));
    const latest = matches[0];
    if (!latest) throw new Error(`The ${key} price meter is unavailable.`);
    if (matches.some(item => Date.parse(item.effectiveStartDate) === Date.parse(latest.effectiveStartDate) && item.retailPrice !== latest.retailPrice)) throw new Error(`The ${key} price meter is ambiguous.`);
    usdPerMillion[key] = latest.retailPrice;
    meters[key] = { id: latest.meterId, name: latest.meterName, effectiveFrom: latest.effectiveStartDate };
  }
  return { model, region, sku: 'GlobalStandard', currency: 'USD', usdPerMillion, meters, checkedAt: new Date(now).toISOString(), sourceUrl: PRICING_API };
}

export async function fetchTokenPricing(model: string, region: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<TokenPriceSnapshot> {
  if (model !== 'gpt-5.6-luna' || !/^[a-z0-9]+$/.test(region)) throw new Error('Unsupported model or pricing region.');
  const firstPage = new URL(PRICING_API);
  firstPage.searchParams.set('currencyCode', "'USD'");
  firstPage.searchParams.set('$filter', `armRegionName eq '${region}' and productName eq 'Azure OpenAI GPT5' and (${Object.values(skus).map(sku => `skuName eq '${sku}'`).join(' or ')})`);
  let nextPage: string | null = firstPage.toString();
  const visited = new Set<string>();
  const items: unknown[] = [];
  const signal = AbortSignal.timeout(15000);
  while (nextPage) {
    const url = new URL(nextPage);
    if (url.origin !== 'https://prices.azure.com' || url.pathname !== '/api/retail/prices' || visited.has(url.href) || visited.size >= 10) throw new Error('Invalid pricing pagination.');
    visited.add(url.href);
    const response = await fetcher(url, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Azure pricing returned HTTP ${response.status}.`);
    const page = pageSchema.parse(await response.json());
    items.push(...page.Items);
    nextPage = page.NextPageLink ?? null;
  }
  return selectTokenPricing(items, model, region, now);
}

export async function refreshTokenPricing(previous: TokenPricing, model: string, region: string, fetcher: typeof fetch = fetch): Promise<TokenPricing> {
  try { return { status: 'live', snapshot: await fetchTokenPricing(model, region, fetcher) }; }
  catch { return { status: previous.snapshot ? 'stale' : 'unavailable', snapshot: previous.snapshot }; }
}