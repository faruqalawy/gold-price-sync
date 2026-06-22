import process from 'node:process';

const SHOPIFY_STORE = mustEnv('SHOPIFY_STORE');
const SHOPIFY_ADMIN_TOKEN = mustEnv('SHOPIFY_ADMIN_TOKEN');
const METALS_API_KEY = mustEnv('METALS_API_KEY');

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';
const METALS_BASE_URL = process.env.METALS_BASE_URL || 'https://api.metals.dev/v1';

const METAOBJECT_TYPE_CURRENT = 'gold_price_current';
const METAOBJECT_HANDLE_CURRENT = 'current';

const METAOBJECT_TYPE_DATASET = 'gold_price_dataset';
const METAOBJECT_HANDLE_DATASET = 'dataset';

const OUNCE_TO_GRAM = 31.1034768;

// Tune these later if the client wants a different spread model.
const BUY_SPREAD_BPS = Number(process.env.BUY_SPREAD_BPS || 75);   // 0.75%
const SELL_SPREAD_BPS = Number(process.env.SELL_SPREAD_BPS || 125); // 1.25%
const MAX_HISTORY_DAYS = Number(process.env.MAX_HISTORY_DAYS || 365);

const forceBootstrap = process.argv.includes('--bootstrap');

main().catch((error) => {
  console.error('[gold-price-sync] fatal error');
  console.error(error);
  process.exit(1);
});

async function main() {
  if (forceBootstrap) {
    await bootstrapAllHistory();
    const latest = await fetchLatestSpot();
    await upsertCurrent(latest);
    await appendTodayToDataset(await loadDatasetHistory(), latest);
    return;
  }

  const existingHistory = await loadDatasetHistory();
  const latest = await fetchLatestSpot();

  await upsertCurrent(latest);

  if (!existingHistory) {
    await bootstrapAllHistory();
    await appendTodayToDataset(await loadDatasetHistory(), latest);
    return;
  }

  await appendTodayToDataset(existingHistory, latest);
}

async function fetchLatestSpot() {
  // Spot endpoint returns spot price, bid, ask, low, high, change, and change_percent.
  const latest = await metalsJson(`/metal/spot?metal=gold&currency=IDR`);

  const rate = latest?.rate;
  if (!rate || typeof rate.price !== 'number') {
    throw new Error(`Unexpected Metals.Dev spot response: ${safeStringify(latest)}`);
  }

  return latest;
}

async function upsertCurrent(latest) {
  const rate = latest?.rate;
  const spotIdrPerOz = rate.price;
  const bidIdrPerOz = typeof rate.bid === 'number' ? rate.bid : spotIdrPerOz * (1 - BUY_SPREAD_BPS / 10000);
  const askIdrPerOz = typeof rate.ask === 'number' ? rate.ask : spotIdrPerOz * (1 + SELL_SPREAD_BPS / 10000);

  const buyIdrPerGram = toRupiah(bidIdrPerOz / OUNCE_TO_GRAM);
  const sellIdrPerGram = toRupiah(askIdrPerOz / OUNCE_TO_GRAM);

  await upsertMetaobject({
    type: METAOBJECT_TYPE_CURRENT,
    handle: METAOBJECT_HANDLE_CURRENT,
    fields: [
      { key: 'updated_at', value: new Date(latest.timestamp || new Date().toISOString()).toISOString() },
      { key: 'buy_price_idr', value: String(buyIdrPerGram) },
      { key: 'sell_price_idr', value: String(sellIdrPerGram) },
      { key: 'source', value: 'metals.dev spot' },
    ],
  });

  console.log('[gold-price-sync] updated current snapshot', {
    updated_at: latest.timestamp || new Date().toISOString(),
    buy_price_idr: buyIdrPerGram,
    sell_price_idr: sellIdrPerGram,
  });
}

async function loadDatasetHistory() {
  const query = /* GraphQL */ `
    query DatasetHistory($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) {
        id
        handle
        history: field(key: "history_json") {
          value
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, {
    handle: {
      type: METAOBJECT_TYPE_DATASET,
      handle: METAOBJECT_HANDLE_DATASET,
    },
  });

  const value = data?.metaobjectByHandle?.history?.value;
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Could not parse existing history_json: ${error.message}`);
  }
}

async function appendTodayToDataset(existing, latest) {
  const rate = latest?.rate;
  if (!rate || typeof rate.price !== 'number') {
    throw new Error(`Unexpected Metals.Dev spot response: ${safeStringify(latest)}`);
  }

  const today = toDateKey(latest.timestamp || new Date().toISOString());

  const spotIdrPerOz = rate.price;
  const bidIdrPerOz = typeof rate.bid === 'number' ? rate.bid : spotIdrPerOz * (1 - BUY_SPREAD_BPS / 10000);
  const askIdrPerOz = typeof rate.ask === 'number' ? rate.ask : spotIdrPerOz * (1 + SELL_SPREAD_BPS / 10000);

  const point = {
    date: today,
    spot: toRupiah(spotIdrPerOz / OUNCE_TO_GRAM),
    buy: toRupiah(bidIdrPerOz / OUNCE_TO_GRAM),
    sell: toRupiah(askIdrPerOz / OUNCE_TO_GRAM),
  };

  const history = normalizeHistory(existing);
  const points = upsertPoint(history.points, point);

  const dataset = {
    version: 1,
    updated_at: new Date(latest.timestamp || new Date().toISOString()).toISOString(),
    currency: 'IDR',
    unit: 'gram',
    points: trimToMaxDays(points, MAX_HISTORY_DAYS),
  };

  await upsertMetaobject({
    type: METAOBJECT_TYPE_DATASET,
    handle: METAOBJECT_HANDLE_DATASET,
    fields: [
      { key: 'updated_at', value: dataset.updated_at },
      { key: 'history_json', value: JSON.stringify(dataset) },
    ],
  });

  console.log('[gold-price-sync] appended dataset point', point);
}

async function bootstrapAllHistory() {
  const end = new Date();
  // Use yesterday as bootstrap end to avoid duplicating the fresh snapshot in the same run.
  end.setUTCDate(end.getUTCDate() - 1);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (MAX_HISTORY_DAYS - 1));

  const rawPoints = await fetchBootstrapPoints(start, end);

  const dataset = {
    version: 1,
    updated_at: new Date().toISOString(),
    currency: 'IDR',
    unit: 'gram',
    points: trimToMaxDays(rawPoints, MAX_HISTORY_DAYS),
  };

  await upsertMetaobject({
    type: METAOBJECT_TYPE_DATASET,
    handle: METAOBJECT_HANDLE_DATASET,
    fields: [
      { key: 'updated_at', value: dataset.updated_at },
      { key: 'history_json', value: JSON.stringify(dataset) },
    ],
  });

  console.log('[gold-price-sync] bootstrapped dataset', {
    points: dataset.points.length,
    start: dataset.points[0]?.date,
    end: dataset.points[dataset.points.length - 1]?.date,
  });
}

async function fetchBootstrapPoints(startDate, endDate) {
  const points = [];
  let cursor = new Date(startDate);

  while (cursor <= endDate) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 29);

    if (chunkEnd > endDate) {
      chunkEnd.setTime(endDate.getTime());
    }

    const ts = await metalsJson(
      `/timeseries?start_date=${toDateKey(chunkStart)}&end_date=${toDateKey(chunkEnd)}`
    );

    const rates = ts?.rates || {};
    for (const [date, snapshot] of Object.entries(rates)) {
      const goldUsdPerOz = snapshot?.metals?.gold;
      const usdToIdr = snapshot?.currencies?.IDR;

      if (typeof goldUsdPerOz !== 'number' || typeof usdToIdr !== 'number') continue;

      const spotIdrPerOz = goldUsdPerOz * usdToIdr;
      const spotIdrPerGram = spotIdrPerOz / OUNCE_TO_GRAM;
      const buyIdrPerGram = spotIdrPerGram * (1 - BUY_SPREAD_BPS / 10000);
      const sellIdrPerGram = spotIdrPerGram * (1 + SELL_SPREAD_BPS / 10000);

      points.push({
        date,
        spot: toRupiah(spotIdrPerGram),
        buy: toRupiah(buyIdrPerGram),
        sell: toRupiah(sellIdrPerGram),
      });
    }

    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dedupeAndSort(points);
}

function normalizeHistory(existing) {
  if (!existing || typeof existing !== 'object') {
    return { version: 1, updated_at: null, currency: 'IDR', unit: 'gram', points: [] };
  }

  const points = Array.isArray(existing.points) ? existing.points : [];
  return {
    version: Number(existing.version || 1),
    updated_at: existing.updated_at || null,
    currency: existing.currency || 'IDR',
    unit: existing.unit || 'gram',
    points: dedupeAndSort(points.map(normalizePoint).filter(Boolean)),
  };
}

function normalizePoint(point) {
  if (!point || typeof point !== 'object') return null;

  const date = typeof point.date === 'string' ? point.date : null;
  if (!date) return null;

  return {
    date,
    spot: toRupiah(Number(point.spot || point.spot_price_idr || 0)),
    buy: toRupiah(Number(point.buy || point.buy_price_idr || 0)),
    sell: toRupiah(Number(point.sell || point.sell_price_idr || 0)),
  };
}

function upsertPoint(points, point) {
  const normalized = normalizePoint(point);
  if (!normalized) return points;

  const next = points.filter((item) => item.date !== normalized.date);
  next.push(normalized);
  return dedupeAndSort(next);
}

function dedupeAndSort(points) {
  const map = new Map();
  for (const point of points) {
    if (point?.date) map.set(point.date, point);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function trimToMaxDays(points, maxDays) {
  if (!Array.isArray(points)) return [];
  if (points.length <= maxDays) return points;
  return points.slice(points.length - maxDays);
}

function toDateKey(dateLike) {
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${dateLike}`);
  }
  return d.toISOString().slice(0, 10);
}

function toRupiah(value) {
  return Math.round(Number(value));
}

async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();
  if (!response.ok || json.errors) {
    throw new Error(`Shopify GraphQL error: ${safeStringify(json.errors || json)}`);
  }

  return json.data;
}

async function upsertMetaobject({ type, handle, fields }) {
  const mutation = /* GraphQL */ `
    mutation UpsertMetaobject($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject {
          id
          handle
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const data = await shopifyGraphQL(mutation, {
    handle: {
      type,
      handle,
    },
    metaobject: {
      fields,
    },
  });

  const result = data?.metaobjectUpsert;
  if (!result) {
    throw new Error(`Unexpected metaobjectUpsert response: ${safeStringify(data)}`);
  }

  if (result.userErrors?.length) {
    throw new Error(`metaobjectUpsert userErrors: ${safeStringify(result.userErrors)}`);
  }

  return result.metaobject;
}

async function metalsJson(path) {
  const url = new URL(`${METALS_BASE_URL}${path}`);
  url.searchParams.set('api_key', METALS_API_KEY);

  const response = await fetch(url);
  const json = await response.json();

  if (!response.ok) {
    throw new Error(`Metals.Dev HTTP ${response.status}: ${safeStringify(json)}`);
  }

  if (json.status && json.status !== 'success') {
    throw new Error(`Metals.Dev error: ${safeStringify(json)}`);
  }

  return json;
}

function mustEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
