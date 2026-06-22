# Gold Price Sync

Daily Shopify metaobject sync for gold price data.

## What this repo does

- Fetches the current gold spot price from Metals.Dev.
- Writes the current snapshot into the `gold_price_current` metaobject.
- Bootstraps and maintains a one-year history dataset in `gold_price_dataset`.
- Runs automatically from GitHub Actions once per day.

## Required secrets

Set these in GitHub Repository → Settings → Secrets and variables → Actions:

- `SHOPIFY_STORE` — e.g. `your-store.myshopify.com`
- `SHOPIFY_ADMIN_TOKEN`
- `SHOPIFY_API_VERSION` — e.g. `2026-04`
- `METALS_API_KEY`
- `METALS_BASE_URL` — optional, default `https://api.metals.dev/v1`
- `BUY_SPREAD_BPS` — optional, default `75`
- `SELL_SPREAD_BPS` — optional, default `125`
- `MAX_HISTORY_DAYS` — optional, default `365`

## Local run

```bash
node sync.js
```

## Bootstrap run

Use this once to fill the dataset history:

```bash
node sync.js --bootstrap
```

## Notes

- The history is stored as a single JSON field in the `gold_price_dataset` metaobject.
- The sync script keeps the dataset idempotent by replacing today's point if it already exists.
