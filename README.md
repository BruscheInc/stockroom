# Brusche Stockroom

A phone-friendly warehouse app that sits on top of **Shopify** (quantity) and **ShipStation** (bin location) and adds what neither keeps on its own: **bin-location history** and a **barcode/QR scanner**.

## What it does
- **Scan anything** — product UPC/EAN, your SKUs, app-generated bin QR labels, or order/packing barcodes. Camera scanning on phones/tablets **and** a keyboard-wedge box for USB/Bluetooth scanner guns.
- **Item view** — live on-hand **quantity per store** (all 3 brands, pulled from Shopify), current bin, and full location history.
- **Read/write bin location** — set or move an item's bin. The app's Postgres DB is the master, and every change is **pushed to ShipStation's native `warehouseLocation`** so pick lists stay accurate.
- **Bin view** — scan or open a bin to see everything assigned to it; print a **QR bin label** (encodes `BIN-<code>`).
- **History** — every move is logged (from → to, who, when, optional qty-seen and note).

## Architecture
```
 Phone / scanner gun  ──►  Stockroom (Node/Express PWA)  ──►  Postgres  (bins, item_location, location_history = master + history)
                                     │
                                     ├──►  Shopify (×3 stores)  read quantity by SKU / UPC
                                     └──►  ShipStation V1       read/write product warehouseLocation
```
- **Quantity is read-only** from Shopify (never changed by this app).
- **Bin location is read/write**: DB is the source of truth; ShipStation is kept in sync on every save.
- SKU is the join key across Shopify, ShipStation, and the local DB.

## Environment variables
| Var | Purpose |
|---|---|
| `ACCESS_KEY` | shared access key for the app (staff open `/?key=…`) |
| `DATABASE_URL` | Postgres (Railway plugin — reference `${{Postgres.DATABASE_URL}}`) |
| `SHOPIFY_STORES` | JSON `[{"brand","domain","id","secret"}, …]` — reuse the other services' value |
| `SHOPIFY_API_VERSION` | e.g. `2025-07` |
| `SHIPSTATION_API_KEY` / `SHIPSTATION_API_SECRET` | ShipStation V1 credentials (reuse Emily's) |
| `PORT` | provided by Railway |

## Deploy (Railway)
1. Create a GitHub repo `BruscheInc/stockroom` and upload `server.js`, `package.json`, `README.md`, and the `public/` folder (same paths).
2. Add a **Postgres** database to the project.
3. Create the service from the repo; set the env vars above (reference the others so no secrets are copied).
4. Generate a public domain. Open `https://<domain>/?key=<ACCESS_KEY>` on a phone and Add to Home Screen.

The database schema is created automatically on first boot (idempotent `CREATE TABLE IF NOT EXISTS`).

## API (all require `?key=`)
- `GET /api/resolve?code=` — classify a scanned code → item or bin
- `GET /api/item/:sku` · `GET /api/bin/:code` · `GET /api/history/:sku`
- `POST /api/move` `{sku,toBin,user,note,qtySeen}` — set/move bin (DB + history + ShipStation push)
- `GET /api/bins` · `POST /api/bins` `{code,label}` · `GET /api/search?q=`

## Notes & future
- v1 tracks **one primary bin per SKU** (matches ShipStation's single `warehouseLocation`). Multi-bin/split stock can be added later.
- Quantity adjustments (cycle counts written back to Shopify) are intentionally out of scope for v1 — read-only by design.
