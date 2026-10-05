/**
 * Brusche Stockroom — bin-location & stock manager over Shopify + ShipStation.
 *
 * WHAT IT DOES
 *  - Quantity (READ): live on-hand per store from Shopify (3 stores; SKU is the join key).
 *  - Bin location (READ/WRITE): the app's Postgres DB is the master; every change is ALSO
 *    pushed to ShipStation's native product "warehouseLocation" so pick lists stay accurate.
 *  - Bin-location history: every move is logged in Postgres (from → to, who, when, note).
 *  - Scanning: the front-end reads product UPC/EAN, SKUs, app-generated bin QR labels, and
 *    order/packing barcodes; this server resolves any scanned code to an item or a bin.
 *
 * ENV
 *   ACCESS_KEY                      shared access key for the app (like Aria)
 *   DATABASE_URL                    Postgres (Railway plugin)
 *   SHOPIFY_STORES (JSON)           [{"brand","domain","id","secret"}, ...]  (reused from the other services)
 *   SHOPIFY_API_VERSION             e.g. 2025-07
 *   SHIPSTATION_API_KEY / _SECRET   ShipStation V1 credentials (reused from Emily)
 *   PORT
 */
const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const ACCESS_KEY = process.env.ACCESS_KEY || process.env.STOCKROOM_KEY || "";
const SHOP_VER = process.env.SHOPIFY_API_VERSION || "2025-07";

// Named users: each person's login key IS their username, so every change is attributed to them.
// STOCKROOM_USERS = comma-separated. Each entry is "Name" (key == name) or "Name:secretkey" (named but secret).
function loadUsers() {
  const out = [];
  const raw = process.env.STOCKROOM_USERS || process.env.USERS || "";
  for (const e of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, key] = e.split(":").map((x) => (x || "").trim());
    if (name) out.push({ name, key: key || name });
  }
  return out;
}
const USERS = loadUsers();
// Resolve a login key to a username (case-insensitive). Falls back to the legacy ACCESS_KEY as "admin".
function userFromKey(key) {
  const k = String(key || "").trim();
  if (!k) return null;
  const u = USERS.find((u) => u.key.toLowerCase() === k.toLowerCase());
  if (u) return u.name;
  if (ACCESS_KEY && k === ACCESS_KEY) return "admin";
  return null;
}

/* ------------------------------------------------ Postgres ------------------------------------------------ */
// Railway's INTERNAL url (postgres.railway.internal) must connect WITHOUT ssl; the public proxy needs it.
const DB_URL = process.env.DATABASE_URL || "";
const DB_SSL = (/sslmode=require/i.test(DB_URL) || /proxy\.rlwy\.net|rlwy\.net|amazonaws/i.test(DB_URL)) && !/\.railway\.internal/i.test(DB_URL);
const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_SSL ? { rejectUnauthorized: false } : false,
});
async function db(q, params) { const c = await pool.connect(); try { return await c.query(q, params); } finally { c.release(); } }
async function migrate() {
  await db(`CREATE TABLE IF NOT EXISTS bins (
    code TEXT PRIMARY KEY,
    label TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`CREATE TABLE IF NOT EXISTS item_location (
    sku TEXT PRIMARY KEY,
    bin TEXT,
    title TEXT,
    barcode TEXT,
    updated_at TIMESTAMPTZ DEFAULT now(),
    updated_by TEXT
  )`);
  await db(`CREATE TABLE IF NOT EXISTS location_history (
    id BIGSERIAL PRIMARY KEY,
    sku TEXT NOT NULL,
    from_bin TEXT,
    to_bin TEXT,
    qty_seen INTEGER,
    user_name TEXT,
    source TEXT,
    note TEXT,
    ts TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`CREATE INDEX IF NOT EXISTS idx_hist_sku ON location_history(sku, ts DESC)`);
  await db(`CREATE INDEX IF NOT EXISTS idx_loc_bin ON item_location(bin)`);
  // Stock Verification — a Shopify on-hand snapshot per SKU/brand, the latest physical count per SKU, and an audit log.
  await db(`CREATE TABLE IF NOT EXISTS stock_items (
    sku TEXT NOT NULL,
    brand TEXT NOT NULL,
    title TEXT,
    variant TEXT,
    on_hand INTEGER,
    status TEXT,
    inv_item_id TEXT,
    synced_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (sku, brand)
  )`);
  await db(`CREATE INDEX IF NOT EXISTS idx_stock_onhand ON stock_items(on_hand)`);
  await db(`CREATE TABLE IF NOT EXISTS stock_verifications (
    sku TEXT PRIMARY KEY,
    counted_qty INTEGER,
    system_qty INTEGER,
    matched BOOLEAN,
    corrected BOOLEAN,
    verified_by TEXT,
    verified_at TIMESTAMPTZ DEFAULT now(),
    note TEXT
  )`);
  await db(`ALTER TABLE stock_verifications ADD COLUMN IF NOT EXISTS corrected BOOLEAN`);
  await db(`CREATE INDEX IF NOT EXISTS idx_verif_at ON stock_verifications(verified_at)`);
  await db(`CREATE TABLE IF NOT EXISTS stock_verification_log (
    id BIGSERIAL PRIMARY KEY,
    sku TEXT NOT NULL,
    counted_qty INTEGER,
    system_qty INTEGER,
    corrected BOOLEAN DEFAULT false,
    correction_note TEXT,
    user_name TEXT,
    note TEXT,
    ts TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`CREATE INDEX IF NOT EXISTS idx_verlog_sku ON stock_verification_log(sku, ts DESC)`);
  // Strays: wrong-picks / found items / sellable returns put back into bins. Logged for the audit trail;
  // for low-stock items (< 3 on hand) a physical recount is required and that recount corrects Shopify.
  await db(`CREATE TABLE IF NOT EXISTS stock_strays (
    id BIGSERIAL PRIMARY KEY,
    sku TEXT NOT NULL,
    title TEXT,
    qty INTEGER,
    bin TEXT,
    system_qty INTEGER,
    verified BOOLEAN DEFAULT false,
    counted_qty INTEGER,
    user_name TEXT,
    ts TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`CREATE INDEX IF NOT EXISTS idx_strays_ts ON stock_strays(ts DESC)`);
  await db(`CREATE TABLE IF NOT EXISTS oos_cases (
    id BIGSERIAL PRIMARY KEY,
    order_number TEXT NOT NULL,
    sku TEXT NOT NULL,
    item_name TEXT,
    qty INTEGER,
    unit_price NUMERIC,
    item_value NUMERIC,
    credit_value NUMERIC,
    brand TEXT,
    customer_name TEXT,
    customer_email TEXT,
    email_subject TEXT,
    email_text TEXT,
    status TEXT DEFAULT 'pending_approval',
    resolution TEXT,
    ticket_id TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`ALTER TABLE oos_cases ADD COLUMN IF NOT EXISTS ticket_id TEXT`);
  await db(`ALTER TABLE oos_cases ADD COLUMN IF NOT EXISTS items JSONB`);            // every out-of-stock line on the order
  await db(`ALTER TABLE oos_cases ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ`);
  await db(`ALTER TABLE oos_cases ADD COLUMN IF NOT EXISTS followup_sent_at TIMESTAMPTZ`);
  // Overstock: which sealed carton a SKU's backstock is in. Loaded from the factory packing-list
  // workbook (the "BIN" sheet: Title / Option1 Value / Variant SKU / BIN#). One row per SKU.
  await db(`CREATE TABLE IF NOT EXISTS overstock_cartons (
    id BIGSERIAL PRIMARY KEY,
    batch TEXT NOT NULL,
    box TEXT NOT NULL,
    item_code TEXT NOT NULL,
    style TEXT,
    color TEXT,
    qty INTEGER,
    source_file TEXT,
    uploaded_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`CREATE INDEX IF NOT EXISTS idx_cartons_box ON overstock_cartons(box)`);
  await db(`CREATE INDEX IF NOT EXISTS idx_cartons_code ON overstock_cartons(batch, item_code)`);
  await db(`CREATE TABLE IF NOT EXISTS overstock_skus (
    sku TEXT PRIMARY KEY,
    batch TEXT,
    item_code TEXT,
    title TEXT,
    variant TEXT,
    shelf_bin TEXT,
    source_file TEXT,
    uploaded_by TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`CREATE INDEX IF NOT EXISTS idx_osku_code ON overstock_skus(batch, item_code)`);
  await db(`CREATE TABLE IF NOT EXISTS overstock_manual (
    sku TEXT PRIMARY KEY,
    box TEXT NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`DROP TABLE IF EXISTS overstock_bins`);
  await db(`CREATE TABLE IF NOT EXISTS overstock_log (
    id BIGSERIAL PRIMARY KEY,
    sku TEXT,
    from_box TEXT,
    to_box TEXT,
    scope TEXT,
    user_name TEXT,
    ts TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`CREATE INDEX IF NOT EXISTS idx_overstocklog_sku ON overstock_log(sku, ts DESC)`);
}

/* --------------------------------------- Shopify (multi-store) --------------------------------------- */
function loadStores() {
  const out = [];
  if (process.env.SHOPIFY_STORES) {
    try {
      for (const s of JSON.parse(process.env.SHOPIFY_STORES))
        if (s.domain && s.id && s.secret) out.push({ brand: s.brand || s.domain, domain: s.domain, id: s.id, secret: s.secret, tok: { token: null, exp: 0 } });
    } catch (e) { console.error("SHOPIFY_STORES parse error:", e.message); }
  }
  return out;
}
const STORES = loadStores();
async function storeToken(st) {
  if (st.tok.token && Date.now() < st.tok.exp) return st.tok.token;
  const r = await fetch(`https://${st.domain}/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: st.id, client_secret: st.secret, grant_type: "client_credentials" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`${st.brand} token: ${JSON.stringify(j).slice(0, 150)}`);
  st.tok = { token: j.access_token, exp: Date.now() + ((j.expires_in ? j.expires_in - 300 : 3600) * 1000) };
  return st.tok.token;
}
async function storeGraphQL(st, query, variables) {
  const token = await storeToken(st);
  const res = await fetch(`https://${st.domain}/admin/api/${SHOP_VER}/graphql.json`, {
    method: "POST", headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(`${st.brand}: ${JSON.stringify(j.errors).slice(0, 200)}`);
  return j.data;
}
const VARIANT_QUERY = `query($q:String!){ productVariants(first:5, query:$q){ edges{ node{
  sku barcode displayName inventoryQuantity price
  image{ url } product{ title featuredImage{ url } status }
  inventoryItem{ id }
}}}}`;
// Look a SKU or barcode up across all stores. Returns per-store matches (a SKU may live in one or several brands).
async function shopifyFind({ sku, barcode }) {
  const q = sku ? `sku:${JSON.stringify(sku)}` : `barcode:${JSON.stringify(barcode)}`;
  const results = [];
  await Promise.all(STORES.map(async (st) => {
    try {
      const d = await storeGraphQL(st, VARIANT_QUERY, { q });
      for (const e of (d.productVariants?.edges || [])) {
        const n = e.node;
        // exact match guard (Shopify query is prefix-ish for some fields)
        if (sku && String(n.sku || "").toLowerCase() !== String(sku).toLowerCase()) continue;
        if (barcode && String(n.barcode || "") !== String(barcode)) continue;
        results.push({
          brand: st.brand, domain: st.domain,
          sku: n.sku, barcode: n.barcode, title: n.product?.title || n.displayName,
          variant: n.displayName, qty: n.inventoryQuantity, price: n.price,
          status: n.product?.status,
          image: n.image?.url || n.product?.featuredImage?.url || null,
        });
      }
    } catch (e) { results.push({ brand: st.brand, error: e.message }); }
  }));
  return results;
}

// Free-text NAME search across all stores — "milk chocolate" returns every product whose title matches,
// expanded to its variants (each with SKU + qty). Bins are merged in by the caller.
const PRODUCT_SEARCH_QUERY = `query($q:String!){ products(first:25, query:$q){ edges{ node{
  title status featuredImage{ url }
  variants(first:100){ edges{ node{ sku barcode displayName inventoryQuantity } } }
}}}}`;
async function shopifySearchByName(term) {
  const rows = [];
  await Promise.all(STORES.map(async (st) => {
    try {
      const d = await storeGraphQL(st, PRODUCT_SEARCH_QUERY, { q: term });
      for (const pe of (d.products?.edges || [])) {
        const p = pe.node;
        for (const ve of (p.variants?.edges || [])) {
          const v = ve.node;
          rows.push({ brand: st.brand, sku: v.sku, barcode: v.barcode, title: p.title, variant: v.displayName, qty: v.inventoryQuantity, status: p.status, image: p.featuredImage?.url || null });
        }
      }
    } catch (e) { /* skip a store that errors, keep the rest */ }
  }));
  return rows;
}

/* --------------------------------------- Stock Verification (Shopify inventory) --------------------------------------- */
// The primary fulfillment location per store (cached) — needed to set on-hand quantities.
async function storeLocationId(st) {
  if (st._locId !== undefined) return st._locId;
  try {
    const d = await storeGraphQL(st, `{locations(first:10){edges{node{id name isActive fulfillsOnlineOrders}}}}`, {});
    const locs = (d.locations?.edges || []).map((e) => e.node);
    const pick = locs.find((l) => l.isActive && l.fulfillsOnlineOrders) || locs.find((l) => l.isActive) || locs[0];
    st._locId = pick ? pick.id : null;
  } catch (e) { st._locId = null; }
  return st._locId;
}
// Snapshot every variant's ON HAND into stock_items (paged, all stores). Heavy — runs in the background.
// NOTE: variant.inventoryQuantity is "available" (on hand − committed − reserved). Jose needs ON HAND,
// so we read the on_hand quantity from each inventory level and sum across locations.
const INV_SYNC_QUERY = `query($cursor:String){ productVariants(first:100, after:$cursor){ pageInfo{hasNextPage endCursor} edges{ node{ sku displayName inventoryItem{ id inventoryLevels(first:10){ edges{ node{ quantities(names:["on_hand"]){ name quantity } } } } } product{title status} } } } }`;
function onHandOf(node) {
  const lv = node?.inventoryItem?.inventoryLevels?.edges || [];
  let sum = 0, seen = false;
  for (const e of lv) { const q = (e.node.quantities || []).find((x) => x.name === "on_hand"); if (q && q.quantity != null) { sum += Number(q.quantity) || 0; seen = true; } }
  return seen ? sum : null;
}
let invSync = { running: false, synced: 0, at: null, error: null };
async function syncShopifyInventory() {
  if (invSync.running) return { running: true, synced: invSync.synced };
  invSync = { running: true, synced: 0, at: new Date().toISOString(), error: null };
  let total = 0; const errors = [];
  // Sync each store independently — one store missing a scope must NOT block the others.
  for (const st of STORES) {
    try {
      let cursor = null, has = true, guard = 0;
      while (has && guard++ < 500) {
        const d = await storeGraphQL(st, INV_SYNC_QUERY, { cursor });
        const conn = d.productVariants || {};
        for (const e of (conn.edges || [])) {
          const n = e.node; if (!n.sku) continue;
          await db(
            `INSERT INTO stock_items (sku,brand,title,variant,on_hand,status,inv_item_id,synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,now())
             ON CONFLICT (sku,brand) DO UPDATE SET title=EXCLUDED.title, variant=EXCLUDED.variant, on_hand=EXCLUDED.on_hand, status=EXCLUDED.status, inv_item_id=EXCLUDED.inv_item_id, synced_at=now()`,
            [n.sku, st.brand, n.product?.title || n.displayName, n.displayName, onHandOf(n), n.product?.status || null, n.inventoryItem?.id || null]
          );
          total++;
        }
        has = conn.pageInfo?.hasNextPage; cursor = conn.pageInfo?.endCursor;
        invSync.synced = total;
        if (has) await new Promise((r) => setTimeout(r, 300)); // stay under Shopify's cost limit
      }
    } catch (e) { errors.push(`${st.brand}: ${e.message.slice(0, 140)}`); console.error(`📊 inventory sync ${st.brand} failed:`, e.message); }
  }
  invSync = { running: false, synced: total, at: new Date().toISOString(), error: errors.length ? errors.join(" | ") : null };
  return { ok: true, synced: total, errors };
}
// Read the location that stocks an item AND its current on-hand there (uses read_inventory — no separate
// locations-scope needed). The current on-hand is needed as `changeFromQuantity` on the set call.
async function itemLevel(st, invItemId) {
  try {
    const d = await storeGraphQL(st, `query($id:ID!){inventoryItem(id:$id){inventoryLevels(first:5){edges{node{location{id} quantities(names:["on_hand"]){name quantity}}}}}}`, { id: invItemId });
    const edges = d.inventoryItem?.inventoryLevels?.edges || [];
    if (edges.length && edges[0].node?.location?.id) { const n = edges[0].node; const q = (n.quantities || []).find((x) => x.name === "on_hand"); return { locId: n.location.id, onHand: q ? Number(q.quantity) : 0 }; }
  } catch (e) { /* fall through to the store default */ }
  return { locId: await storeLocationId(st), onHand: 0 };
}
// Set Shopify on-hand to a counted quantity for a SKU, across every store that carries it.
async function shopifySetOnHand(sku, qty) {
  const rows = (await db(`SELECT brand, inv_item_id, on_hand FROM stock_items WHERE sku=$1`, [sku])).rows;
  const out = [];
  for (const r of rows) {
    const st = STORES.find((s) => s.brand === r.brand);
    if (!st || !r.inv_item_id) { out.push({ brand: r.brand, ok: false, error: "no Shopify inventory item on file" }); continue; }
    try {
      const lvl = await itemLevel(st, r.inv_item_id);
      if (!lvl.locId) { out.push({ brand: r.brand, ok: false, error: "no fulfillment location" }); continue; }
      const idem = require("crypto").randomUUID();
      const d = await storeGraphQL(st,
        `mutation($input:InventorySetOnHandQuantitiesInput!){ inventorySetOnHandQuantities(input:$input) @idempotent(key:"${idem}"){ userErrors{field message} } }`,
        { input: { reason: "correction", referenceDocumentUri: "logistics://stockroom/verification", setQuantities: [{ inventoryItemId: r.inv_item_id, locationId: lvl.locId, quantity: Number(qty), changeFromQuantity: lvl.onHand }] } });
      const ue = d.inventorySetOnHandQuantities?.userErrors || [];
      if (ue.length) { out.push({ brand: r.brand, ok: false, error: ue.map((x) => x.message).join("; ") }); }
      else { out.push({ brand: r.brand, ok: true, from: lvl.onHand, to: Number(qty) }); await db(`UPDATE stock_items SET on_hand=$1, synced_at=now() WHERE sku=$2 AND brand=$3`, [Number(qty), sku, r.brand]); }
    } catch (e) { out.push({ brand: r.brand, ok: false, error: e.message }); }
  }
  return out;
}

/* --------------------------------------- ShipStation (V1) --------------------------------------- */
const SS_KEY = process.env.SHIPSTATION_API_KEY || "";
const SS_SECRET = process.env.SHIPSTATION_API_SECRET || "";
function ssConfigured() { return !!(SS_KEY && SS_SECRET); }
async function ssReq(method, pathname, body) {
  const auth = "Basic " + Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString("base64");
  const r = await fetch(`https://ssapi.shipstation.com${pathname}`, {
    method, headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { raw: txt }; }
  if (!r.ok) throw new Error(`ShipStation ${r.status}: ${(j && (j.Message || j.message)) || txt.slice(0, 160)}`);
  return j;
}
async function ssFindProductBySku(sku) {
  if (!ssConfigured()) return null;
  const j = await ssReq("GET", `/products?sku=${encodeURIComponent(sku)}&pageSize=50`);
  const list = (j && j.products) || [];
  return list.find((p) => String(p.sku || "").toLowerCase() === String(sku).toLowerCase()) || list[0] || null;
}
// ShipStation update is a FULL-OBJECT replace — read the product, set warehouseLocation, PUT it back.
async function ssSetWarehouseLocation(sku, location) {
  const p = await ssFindProductBySku(sku);
  if (!p || !p.productId) throw new Error(`no ShipStation product for SKU ${sku}`);
  const full = await ssReq("GET", `/products/${p.productId}`);
  full.warehouseLocation = location || "";
  await ssReq("PUT", `/products/${p.productId}`, full);
  return { productId: p.productId, warehouseLocation: location || "" };
}

/* --------------------------------------- Data operations --------------------------------------- */
async function getItemLocation(sku) {
  const r = await db(`SELECT sku,bin,title,barcode,updated_at,updated_by FROM item_location WHERE sku=$1`, [sku]);
  return r.rows[0] || null;
}
async function getHistory(sku, limit = 25) {
  const r = await db(`SELECT id,from_bin,to_bin,qty_seen,user_name,source,note,ts FROM location_history WHERE sku=$1 ORDER BY ts DESC LIMIT $2`, [sku, limit]);
  return r.rows;
}
// Set/add/remove an item's bin. Pass ONE of: toBin (replace whole location), addBin (add a token),
// removeBin (drop a token). Locations can be compound, e.g. "1008-L, G-5".
async function moveItem({ sku, toBin, addBin, removeBin, user, note, qtySeen, source }) {
  if (!sku) throw new Error("sku required");
  const cur = await getItemLocation(sku);
  const fromBin = cur ? cur.bin : null;
  // Compute the new location string based on the operation.
  let finalBin;
  const toks = binTokens(fromBin);
  if (addBin) {
    if (!toks.some((t) => t.toLowerCase() === String(addBin).toLowerCase())) toks.push(String(addBin).trim());
    if (toks.length > 3) { const e = new Error("Max 3 bins per SKU — remove one before adding another."); e.code = "MAX_BINS"; throw e; }
    finalBin = toks.join(", ");
  } else if (removeBin) {
    finalBin = toks.filter((t) => t.toLowerCase() !== String(removeBin).toLowerCase()).join(", ");
  } else {
    finalBin = (toBin || "").trim();
  }
  finalBin = finalBin || null;
  // enrich title/barcode from Shopify (best-effort) so the DB row is self-describing
  let title = cur?.title || null, barcode = cur?.barcode || null;
  try { const f = (await shopifyFind({ sku }))[0]; if (f && !f.error) { title = f.title || title; barcode = f.barcode || barcode; } } catch {}
  await db(
    `INSERT INTO item_location (sku,bin,title,barcode,updated_at,updated_by) VALUES ($1,$2,$3,$4,now(),$5)
     ON CONFLICT (sku) DO UPDATE SET bin=$2, title=COALESCE($3,item_location.title), barcode=COALESCE($4,item_location.barcode), updated_at=now(), updated_by=$5`,
    [sku, finalBin, title, barcode, user || null]
  );
  await db(
    `INSERT INTO location_history (sku,from_bin,to_bin,qty_seen,user_name,source,note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sku, fromBin, finalBin, qtySeen ?? null, user || null, source || "scan", note || null]
  );
  if (finalBin) await registerBinTokens(finalBin);
  // Push to ShipStation (best-effort — never block the local move on it).
  let shipstation = { pushed: false };
  if (ssConfigured()) {
    try { const r = await ssSetWarehouseLocation(sku, finalBin || ""); shipstation = { pushed: true, ...r }; }
    catch (e) { shipstation = { pushed: false, error: e.message }; }
  }
  return { sku, from_bin: fromBin, to_bin: finalBin, shipstation };
}
// A warehouse location can hold several comma-separated tokens ("1008-L, G-5"). Split into tokens.
function binTokens(loc) { return String(loc || "").split(",").map((s) => s.trim()).filter(Boolean); }
async function registerBinTokens(loc) {
  for (const tok of binTokens(loc)) { try { await db(`INSERT INTO bins (code,label) VALUES ($1,$1) ON CONFLICT (code) DO NOTHING`, [tok]); } catch {} }
}
// Items in a bin = any item whose location contains that bin as one of its comma-separated tokens.
async function binItems(code) {
  const r = await db(
    `SELECT sku,bin,title,barcode,updated_at,updated_by FROM item_location
     WHERE lower($1) = ANY(SELECT trim(lower(x)) FROM unnest(string_to_array(bin, ',')) x) ORDER BY sku`,
    [code]
  );
  return r.rows;
}
// Read-through: if we don't have a bin for a SKU yet, pull it live from ShipStation and cache it.
async function readThroughBin(sku, title) {
  if (!ssConfigured()) return null;
  try {
    const p = await ssFindProductBySku(sku);
    const loc = p && String(p.warehouseLocation || "").trim();
    if (loc) {
      await db(
        `INSERT INTO item_location (sku,bin,title,updated_at,updated_by) VALUES ($1,$2,$3,now(),'shipstation-read')
         ON CONFLICT (sku) DO UPDATE SET bin=$2, title=COALESCE(item_location.title,$3), updated_at=now(), updated_by='shipstation-read'`,
        [sku, loc, title || null]
      );
      await registerBinTokens(loc);
      return loc;
    }
  } catch {}
  return null;
}
// Bulk import every product's warehouseLocation from ShipStation into the app DB.
async function syncFromShipStation() {
  if (!ssConfigured()) return { error: "ShipStation not configured" };
  let page = 1, pages = 1, scanned = 0, imported = 0, updated = 0, withLoc = 0;
  do {
    const j = await ssReq("GET", `/products?page=${page}&pageSize=500`);
    pages = j.pages || 1;
    for (const p of (j.products || [])) {
      scanned++;
      const sku = p.sku; if (!sku) continue;
      const loc = String(p.warehouseLocation || "").trim();
      if (!loc) continue;
      withLoc++;
      const cur = await getItemLocation(sku);
      if (cur && String(cur.bin || "") === loc) continue; // unchanged — idempotent re-sync
      await db(
        `INSERT INTO item_location (sku,bin,title,updated_at,updated_by) VALUES ($1,$2,$3,now(),'shipstation-import')
         ON CONFLICT (sku) DO UPDATE SET bin=$2, title=COALESCE(item_location.title,$3), updated_at=now(), updated_by='shipstation-import'`,
        [sku, loc, p.name || null]
      );
      await registerBinTokens(loc);
      await db(`INSERT INTO location_history (sku,from_bin,to_bin,user_name,source) VALUES ($1,$2,$3,'import','import')`, [sku, cur ? cur.bin : null, loc]);
      if (cur) updated++; else imported++;
    }
    page++;
    if (page <= pages) await new Promise((r) => setTimeout(r, 250)); // stay under ShipStation's 40 req/min
  } while (page <= pages);
  return { ok: true, scanned, with_location: withLoc, imported, updated };
}

/* --------------------------------------- Orders → digital pick list --------------------------------------- */
// ShipStation is the source of truth for what's on a packing slip. Look an order up by its order number
// (that's what the packing-slip barcode encodes, e.g. "LBO8958").
async function ssGetOrderByNumber(rawCode) {
  if (!ssConfigured()) return null;
  const code = String(rawCode || "").trim().replace(/^#/, "");
  // 1) by order number (what "LBO8958" packing-slip barcodes encode)
  let list = [];
  try { const j = await ssReq("GET", `/orders?orderNumber=${encodeURIComponent(code)}&pageSize=50`); list = (j && j.orders) || []; } catch {}
  const exact = list.filter((o) => String(o.orderNumber || "").toLowerCase() === code.toLowerCase());
  // Prefer an exact match; if several, the most recent (highest orderId) wins.
  const pick = (exact.length ? exact : list).sort((a, b) => (b.orderId || 0) - (a.orderId || 0))[0] || null;
  if (pick) return pick;
  // 2) fall back to the raw ShipStation order id (some slips encode that instead)
  if (/^\d{3,}$/.test(code)) {
    try { const o = await ssReq("GET", `/orders/${encodeURIComponent(code)}`); if (o && o.orderId) return o; } catch {}
  }
  return null;
}
function brandFromOrderNo(no) {
  const p = ((String(no).match(/^#?([A-Za-z]+)/) || [])[1] || "").toUpperCase();
  return p === "LBO" ? "Larkspur Baby Outlet" : p === "LB" ? "Larkspur Baby" : p === "BB" ? "Bumbunny Baby" : null;
}
// Build the digital packing list: each line item joined to its current bin (DB → order's own
// warehouseLocation → ShipStation read-through) and live on-hand from Shopify, sorted for picking.
async function buildPickList(rawCode) {
  const code = String(rawCode || "").trim().replace(/^#/, "");
  if (!code) return { found: false, code: rawCode };
  let order = null;
  try { order = await ssGetOrderByNumber(code); } catch (e) { return { found: false, code, error: e.message }; }
  if (!order) return { found: false, code };
  // Combine duplicate SKUs; drop lines without a SKU (insurance/package-protection etc.).
  const bySku = {};
  for (const it of (order.items || [])) {
    if (!it || !it.sku || Number(it.quantity) === 0) continue;
    const k = it.sku;
    if (!bySku[k]) bySku[k] = { sku: it.sku, name: it.name || "", qty: 0, unit_price: Number(it.unitPrice) || 0, ss_loc: String(it.warehouseLocation || "").trim() || null, image: it.imageUrl || null };
    bySku[k].qty += Number(it.quantity) || 0;
    if (!bySku[k].ss_loc && it.warehouseLocation) bySku[k].ss_loc = String(it.warehouseLocation).trim();
  }
  const skus = Object.keys(bySku);
  const binBySku = {};
  if (skus.length) { const b = await db(`SELECT sku,bin FROM item_location WHERE sku = ANY($1)`, [skus]); for (const r of b.rows) binBySku[r.sku] = r.bin; }
  const items = await Promise.all(skus.map(async (sku) => {
    const base = bySku[sku];
    let bin = binBySku[sku] || base.ss_loc || null;
    if (!bin) { try { bin = await readThroughBin(sku, base.name); } catch {} }
    let on_hand = null, title = base.name, image = base.image, status = null;
    try {
      const f = (await shopifyFind({ sku })).filter((m) => !m.error);
      if (f.length) { on_hand = f.reduce((s, m) => s + (Number(m.qty) || 0), 0); title = f[0].title || title; image = f.find((m) => m.image)?.image || image; status = f[0].status || null; }
    } catch {}
    return { sku, name: title, qty: base.qty, unit_price: base.unit_price, bin, on_hand, image, status };
  }));
  // Sort by bin (natural), items without a bin go last so the picker walks a route.
  items.sort((a, b) => {
    const ka = a.bin ? String(a.bin).toLowerCase() : null, kb = b.bin ? String(b.bin).toLowerCase() : null;
    if (ka === null && kb === null) return (a.name || "").localeCompare(b.name || "");
    if (ka === null) return 1; if (kb === null) return -1;
    return ka.localeCompare(kb, undefined, { numeric: true, sensitivity: "base" });
  });
  return {
    found: true, order_number: order.orderNumber, order_status: order.orderStatus,
    brand: brandFromOrderNo(order.orderNumber), ship_to: (order.shipTo && order.shipTo.name) || null,
    customer_email: order.customerEmail || null,
    order_date: order.orderDate || null, item_count: items.length,
    total_qty: items.reduce((s, i) => s + (i.qty || 0), 0), items,
  };
}

/* --------------------------------------- Out-of-stock → customer email --------------------------------------- */
const money = (n) => "$" + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
function firstName(name) { const t = String(name || "").trim().split(/\s+/)[0]; return t && /^[A-Za-z]/.test(t) ? t : "there"; }
// Build the full 3-option out-of-stock email (equal-value replacement / store credit +15% / refund).
// The copy nudges toward replacement & credit since a refund is the least ideal outcome for us.
// One email can cover every out-of-stock line on the order — nobody wants three emails about one package.
function generateOosEmail({ brand, orderNumber, customerName, items }) {
  const lines = (items || []).map((it) => ({ name: it.itemName || it.name, qty: Number(it.qty) || 1, value: Math.round((Number(it.unitPrice != null ? it.unitPrice : it.unit_price) || 0) * (Number(it.qty) || 1) * 100) / 100 }));
  const value = Math.round(lines.reduce((a, l) => a + l.value, 0) * 100) / 100;
  const credit = Math.round(value * 1.15 * 100) / 100;
  const fn = firstName(customerName);
  const b = brand || "our team";
  const many = lines.length > 1;
  const subject = `A quick update on your ${b} order #${orderNumber}`;
  const text = [
    `Hi ${fn},`, ``,
    many ? `Thank you so much for your order! I'm reaching out because ${lines.length} items are unexpectedly out of stock and won't be able to ship:`
         : `Thank you so much for your order! I'm reaching out because one item is unexpectedly out of stock and won't be able to ship:`, ``,
    ...lines.map((l) => `   • ${l.name}  (Qty ${l.qty}) — ${money(l.value)}`), ``,
    `I'm so sorry for the inconvenience — I'd love to make this right. You've got a few options, so just reply and let me know which you'd prefer:`, ``,
    `1) Equal-value replacement — pick any in-stock item(s) up to ${money(value)} and we'll send ${many ? "them" : "it"} in place of ${many ? "these" : "this one"}, at no extra charge.`, ``,
    `2) Store credit + 15% extra — we'll add ${money(credit)} in store credit to your account. That's the full ${money(value)} value plus a 15% bonus for the trouble. It never expires and works on any future order.`, ``,
    `3) A refund of ${money(value)} back to your original payment.`, ``,
    `Most customers go with option 1 or 2 — you still get something you'll love, and the credit gives you a little extra to play with. Whichever you pick, just reply to this email and I'll take care of it right away.`, ``,
    `Thanks so much for your patience, and for shopping with ${b}!`, ``,
    `Warmly,`, `The ${b} Team`,
  ].join("\n");
  return { subject, text, item_value: value, credit_value: credit, lines };
}
// Find one or more items on an order and assemble everything the OOS draft needs.
async function oosContext(orderCode, skus) {
  const pl = await buildPickList(orderCode);
  if (!pl.found) return { found: false, code: orderCode };
  const want = (Array.isArray(skus) ? skus : String(skus || "").split(",")).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const items = (pl.items || []).filter((i) => want.includes(String(i.sku).toLowerCase()));
  if (!items.length) return { found: false, code: orderCode, no_item: true };
  const draft = generateOosEmail({ brand: pl.brand, orderNumber: pl.order_number, customerName: pl.ship_to, items: items.map((i) => ({ itemName: i.name, qty: i.qty, unitPrice: i.unit_price })) });
  return {
    found: true, order_number: pl.order_number, brand: pl.brand, customer_name: pl.ship_to, customer_email: pl.customer_email,
    item: { sku: items[0].sku, name: items[0].name, qty: items[0].qty, unit_price: items[0].unit_price, bin: items[0].bin, on_hand: items[0].on_hand },
    items: items.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, unit_price: i.unit_price, bin: i.bin, on_hand: i.on_hand })),
    all_items: (pl.items || []).map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, unit_price: i.unit_price, on_hand: i.on_hand })),
    ...draft,
  };
}

/* --------------------------------------- Slack (notify Jose) --------------------------------------- */
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const OOS_CHANNEL = process.env.OOS_CHANNEL || process.env.CS_CHANNEL || "";
function slackPost(text) {
  if (!SLACK_TOKEN || !OOS_CHANNEL) return Promise.resolve({ ok: false, skipped: true });
  return fetch("https://slack.com/api/chat.postMessage", {
    method: "POST", headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: OOS_CHANNEL, text }),
  }).then((r) => r.json()).catch(() => ({ ok: false }));
}

// Resolve a scanned code → an item or a bin.
async function resolveCode(raw) {
  const code = String(raw || "").trim();
  if (!code) return { type: "empty" };
  // 1) explicit bin QR (app-generated labels use the BIN- prefix), or a known bin code.
  const binGuess = code.replace(/^BIN[-:]/i, "");
  const knownBin = await db(`SELECT code,label FROM bins WHERE lower(code)=lower($1)`, [binGuess]);
  if (/^BIN[-:]/i.test(code) || knownBin.rows[0]) {
    const bin = knownBin.rows[0]?.code || binGuess;
    return { type: "bin", bin, label: knownBin.rows[0]?.label || null, items: await binItems(bin) };
  }
  // 2) item — try SKU first, then barcode (UPC/EAN). Also strip common order-barcode prefixes.
  let matches = await shopifyFind({ sku: code });
  matches = matches.filter((m) => !m.error);
  let matchedBy = "sku";
  if (!matches.length) { const bc = await shopifyFind({ barcode: code }); matches = bc.filter((m) => !m.error); matchedBy = "barcode"; }
  if (matches.length) {
    const sku = matches[0].sku;
    const loc = await getItemLocation(sku);
    let currentBin = loc?.bin || null;
    if (!currentBin) currentBin = await readThroughBin(sku, matches[0].title); // pull from ShipStation if not cached yet
    return {
      type: "item", matched_by: matchedBy, sku, title: matches[0].title, barcode: matches[0].barcode,
      image: matches.find((m) => m.image)?.image || null,
      stores: matches.map((m) => ({ brand: m.brand, qty: m.qty, status: m.status, variant: m.variant, price: m.price })),
      total_qty: matches.reduce((s, m) => s + (Number(m.qty) || 0), 0),
      current_bin: currentBin, location_updated_at: loc?.updated_at || null, location_updated_by: loc?.updated_by || null,
      overstock: await overstockFor(sku),
      history: await getHistory(sku, 15),
    };
  }
  // 3) maybe an order / packing-slip barcode. Two shapes: an order number (letters + digits,
  //    e.g. LBO8958) or a raw numeric ShipStation order id (6-11 digits — narrower than a 12-13
  //    digit UPC so we don't mistake a product barcode for an order). This runs only AFTER the
  //    SKU/UPC/bin lookups above have all missed, so real items are never treated as orders.
  const oc = code.replace(/^#/, "");
  if (ssConfigured() && (/^[A-Za-z]{1,5}\d{3,9}$/.test(oc) || /^\d{6,11}$/.test(oc))) {
    try { const pl = await buildPickList(oc); if (pl.found) return { type: "order", ...pl }; } catch {}
  }
  // 4) unknown — let the user assign it as a new SKU if they want.
  return { type: "unknown", code };
}

/* --------------------------------------- HTTP --------------------------------------- */
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.raw({ type: ["application/octet-stream", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv"], limit: "20mb" }));
function keyFrom(req) { return req.query.key || req.get("x-stockroom-key") || (req.body && req.body.key) || ""; }
const authed = (req) => userFromKey(keyFrom(req)) !== null;
const actorOf = (req) => userFromKey(keyFrom(req)) || "unknown";
function guard(req, res) { if (!authed(req)) { res.status(401).json({ error: "unauthorized" }); return false; } return true; }

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, p) => { if (p.endsWith(".webmanifest")) res.set("Content-Type", "application/manifest+json"); if (p.endsWith("sw.js")) res.set("Cache-Control", "no-cache"); },
}));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/role", (req, res) => res.json({ ok: authed(req), user: userFromKey(keyFrom(req)) }));

// Resolve any scanned/typed code.
app.get("/api/resolve", async (req, res) => {
  if (!guard(req, res)) return;
  try { res.json(await resolveCode(req.query.code)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Digital pick list for an order (scan the packing-slip barcode or type the order #).
app.get("/api/order", async (req, res) => {
  if (!guard(req, res)) return;
  try { res.json(await buildPickList(req.query.code)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
/* --------------------------------------- Overstock cartons ---------------------------------------
 * Source: the factory packing-list workbook.
 *   "…PL" sheet  → one row per line-item, with BOX NO. filled in only on a carton's FIRST row
 *                  (every following row without a box number belongs to that same carton), and an
 *                  ITEM CODE that identifies a style + colour (e.g. LB81CN26X193 = Women's PJ in
 *                  Seasonal Classics). Its size columns are NOT reliable — the factory fills the
 *                  leftmost free column rather than the labelled one (a One Size blanket lands in
 *                  both "18-24m" and "90*60"), so carton data is tracked at style+colour level.
 *   "BIN" sheet  → the SKU dictionary: Title / Option1 Value / Variant SKU / BIN#. BIN# is the
 *                  warehouse SHELF bin, which the app already tracks, so it is stored for
 *                  reference only and never overwrites item_location.
 * A SKU's item code is the packing-list code that all of that product's SKUs start with. */
function parseOverstockWorkbook(buf, filename) {
  const XLSX = require("xlsx");
  const wb = XLSX.read(buf, { type: "buffer" });
  const binName = wb.SheetNames.find((n) => /^bin$/i.test(n)) || wb.SheetNames.find((n) => /bin/i.test(n));
  const plName = wb.SheetNames.find((n) => n !== binName && /pl|pack/i.test(n)) || wb.SheetNames.find((n) => n !== binName);
  if (!binName) throw new Error(`no "BIN" sheet in this workbook (found: ${wb.SheetNames.join(", ")})`);
  if (!plName) throw new Error(`no packing-list sheet in this workbook (found: ${wb.SheetNames.join(", ")})`);

  // ---- BIN sheet → SKUs
  const binRows = XLSX.utils.sheet_to_json(wb.Sheets[binName], { defval: "" });
  if (!binRows.length) throw new Error(`sheet "${binName}" is empty`);
  const bh = Object.keys(binRows[0]);
  const bfind = (re) => bh.find((h) => re.test(String(h).trim()));
  const hSku = bfind(/variant\s*sku|^sku$/i) || bfind(/sku/i);
  const hShelf = bfind(/^bin\s*#?$/i) || bfind(/bin/i);
  const hTitle = bfind(/^title$/i) || bfind(/title|product/i);
  const hOpt = bfind(/option1|variant|size/i);
  if (!hSku || !hTitle) throw new Error(`sheet "${binName}" needs a Title column and a Variant SKU column (saw: ${bh.join(", ")})`);
  const skus = [], seen = new Set();
  for (const r of binRows) {
    const sku = String(r[hSku] == null ? "" : r[hSku]).trim();
    const title = String(r[hTitle] == null ? "" : r[hTitle]).trim();
    if (!sku || seen.has(sku.toLowerCase())) continue;
    seen.add(sku.toLowerCase());
    skus.push({
      sku, title,
      variant: hOpt ? String(r[hOpt] == null ? "" : r[hOpt]).trim() : null,
      shelf_bin: hShelf ? String(r[hShelf] == null ? "" : r[hShelf]).trim() : null,
    });
  }
  if (!skus.length) throw new Error(`no SKUs found in sheet "${binName}"`);

  // ---- packing list → cartons. Two header rows, so read as a grid and locate the columns.
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[plName], { header: 1, defval: "" });
  const norm = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  let hdr = -1, cCode = -1, cBox = -1, cStyle = -1, cColor = -1, cUnits = -1;
  for (let i = 0; i < Math.min(grid.length, 12); i++) {
    const row = grid[i].map(norm);
    const code = row.findIndex((v) => /item\s*code/i.test(v));
    const box = row.findIndex((v) => /box\s*no/i.test(v));
    if (code >= 0 && box >= 0) {
      hdr = i; cCode = code; cBox = box;
      cStyle = row.findIndex((v) => /style\s*name/i.test(v));
      cColor = row.findIndex((v) => /^color|colour/i.test(v));
      cUnits = row.findIndex((v) => /units/i.test(v));
      break;
    }
  }
  if (hdr < 0) throw new Error(`sheet "${plName}" has no "ITEM CODE" + "BOX NO." header row`);
  // Quantity columns: everything between the item code and the units/box column that holds numbers.
  const qFrom = cCode + 1;
  const qTo = (cUnits > cCode ? cUnits : cBox) - 1;
  const cartons = [];
  let box = null;
  for (let i = hdr + 1; i < grid.length; i++) {
    const row = grid[i];
    const bv = norm(row[cBox]);
    if (bv) box = bv;                                     // a new carton starts; blanks continue the last one
    const code = norm(row[cCode]);
    if (!code || box == null) continue;
    let qty = 0;
    for (let c = qFrom; c <= qTo; c++) { const n = Number(row[c]); if (Number.isFinite(n) && n > 0) qty += n; }
    if (!qty) continue;
    cartons.push({
      box, item_code: code, qty,
      style: cStyle >= 0 ? norm(row[cStyle]).split("\n")[0] : null,
      color: cColor >= 0 ? norm(row[cColor]).split("\n")[0] : null,
    });
  }
  if (!cartons.length) throw new Error(`no carton rows found in sheet "${plName}"`);

  // ---- join: each product's SKUs share one packing-list item code (their common prefix).
  const codes = [...new Set(cartons.map((c) => c.item_code))];
  const byTitle = new Map();
  for (const s of skus) { if (!byTitle.has(s.title)) byTitle.set(s.title, []); byTitle.get(s.title).push(s); }
  const commonPrefix = (list) => {
    let a = list[0];
    for (const b of list) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; a = a.slice(0, i); }
    return a;
  };
  let matched = 0;
  const unmatched = [];
  for (const [title, group] of byTitle) {
    const pre = commonPrefix(group.map((g) => g.sku));
    let code = codes.includes(pre) ? pre : null;
    if (!code) {                                          // single-SKU products: longest code that prefixes them all
      const cands = codes.filter((c) => group.every((g) => g.sku.startsWith(c)));
      code = cands.sort((a, b) => b.length - a.length)[0] || null;
    }
    for (const g of group) g.item_code = code;
    if (code) matched += group.length; else unmatched.push(title);
  }
  const batch = (String(filename || "").match(/[A-Za-z]{2}\d{2,}/) || [])[0] ||
                (codes[0] && (codes[0].match(/^[A-Za-z]{2}\d{2,}/) || [])[0]) || "batch";
  return { batch, sheet_bin: binName, sheet_pl: plName, skus, cartons, matched, unmatched, boxes: [...new Set(cartons.map((c) => c.box))].length };
}

// Upload a packing-list workbook. Body is the raw file; ?name= carries the filename.
// Re-uploading the same batch replaces it, so a corrected sheet is just another upload.
app.post("/api/overstock/import", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const buf = req.body;
    if (!buf || !buf.length || !Buffer.isBuffer(buf)) return res.status(400).json({ error: "no file received" });
    const filename = String(req.query.name || "upload.xlsx");
    const p = parseOverstockWorkbook(buf, filename);
    const by = actorOf(req);
    await db(`DELETE FROM overstock_cartons WHERE batch=$1`, [p.batch]);
    await db(`DELETE FROM overstock_skus WHERE batch=$1`, [p.batch]);
    for (const c of p.cartons) {
      await db(`INSERT INTO overstock_cartons (batch,box,item_code,style,color,qty,source_file,uploaded_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [p.batch, c.box, c.item_code, c.style, c.color, c.qty, filename, by]);
    }
    for (const s of p.skus) {
      await db(`INSERT INTO overstock_skus (sku,batch,item_code,title,variant,shelf_bin,source_file,uploaded_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                ON CONFLICT (sku) DO UPDATE SET batch=EXCLUDED.batch, item_code=EXCLUDED.item_code, title=EXCLUDED.title,
                  variant=EXCLUDED.variant, shelf_bin=EXCLUDED.shelf_bin, source_file=EXCLUDED.source_file,
                  uploaded_by=EXCLUDED.uploaded_by, updated_at=now()`,
        [s.sku, p.batch, s.item_code || null, s.title, s.variant, s.shelf_bin, filename, by]);
    }
    res.json({
      ok: true, batch: p.batch, file: filename, sheets: { bin: p.sheet_bin, packing_list: p.sheet_pl },
      skus: p.skus.length, matched: p.matched, unmatched: p.unmatched, cartons: p.cartons.length,
      boxes: p.boxes, units: p.cartons.reduce((n, c) => n + c.qty, 0),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Remove an uploaded packing list entirely (manual box overrides are left alone).
app.delete("/api/overstock/batch/:batch", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const batch = String(req.params.batch || "").trim();
    if (!batch) return res.status(400).json({ error: "batch required" });
    const c = await db(`DELETE FROM overstock_cartons WHERE lower(batch)=lower($1) RETURNING id`, [batch]);
    const s = await db(`DELETE FROM overstock_skus WHERE lower(batch)=lower($1) RETURNING sku`, [batch]);
    if (!c.rows.length && !s.rows.length) return res.status(404).json({ error: `no upload named ${batch}` });
    await db(`INSERT INTO overstock_log (sku,from_box,to_box,scope,user_name) VALUES (NULL,$1,NULL,'batch-delete',$2)`, [batch, actorOf(req)]);
    res.json({ ok: true, batch, cartons: c.rows.length, skus: s.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// A SKU's cartons: a manual override wins; otherwise every carton holding that style + colour.
async function overstockFor(sku) {
  try {
    const man = await db(`SELECT box FROM overstock_manual WHERE lower(sku)=lower($1)`, [sku]);
    const rec = await db(`SELECT batch,item_code,title,variant FROM overstock_skus WHERE lower(sku)=lower($1)`, [sku]);
    const r = rec.rows[0];
    let boxes = [];
    if (r && r.item_code) {
      const b = await db(`SELECT box, sum(qty)::int AS qty FROM overstock_cartons
                          WHERE batch=$1 AND item_code=$2 GROUP BY box
                          ORDER BY (CASE WHEN box ~ '^[0-9]+$' THEN box::int END), box`, [r.batch, r.item_code]);
      boxes = b.rows;
    }
    if (!man.rows.length && !boxes.length) return null;
    return {
      manual_box: man.rows[0] ? man.rows[0].box : null,
      boxes, batch: r ? r.batch : null, item_code: r ? r.item_code : null,
      units: boxes.reduce((n, x) => n + (x.qty || 0), 0),
      level: "style+colour",
    };
  } catch (e) { return null; }
}
// Search: a SKU, a box number, a batch, or part of a product name.
app.get("/api/overstock", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const q = String(req.query.q || "").trim();
    if (!q) {
      const r = await db(`SELECT s.batch, max(s.source_file) AS source_file, count(*)::int AS skus, max(s.updated_at) AS updated_at,
                                 (SELECT count(DISTINCT box)::int FROM overstock_cartons c WHERE c.batch=s.batch) AS boxes,
                                 (SELECT sum(qty)::int FROM overstock_cartons c WHERE c.batch=s.batch) AS units
                          FROM overstock_skus s GROUP BY s.batch ORDER BY max(s.updated_at) DESC`);
      const m = await db(`SELECT count(*)::int AS n FROM overstock_manual`);
      return res.json({ batches: r.rows, manual: m.rows[0] ? m.rows[0].n : 0 });
    }
    const r = await db(
      `SELECT s.sku, s.title, s.variant, s.batch, s.item_code, m.box AS manual_box,
              (SELECT string_agg(t.box, ', ' ORDER BY t.k) FROM (SELECT DISTINCT c.box, (CASE WHEN c.box ~ '^[0-9]+$' THEN lpad(c.box,8,'0') ELSE c.box END) AS k FROM overstock_cartons c WHERE c.batch=s.batch AND c.item_code=s.item_code) t) AS boxes
         FROM overstock_skus s
         LEFT JOIN overstock_manual m ON lower(m.sku)=lower(s.sku)
        WHERE lower(s.sku)=lower($1) OR lower(s.batch)=lower($1) OR lower(m.box)=lower($1)
           OR s.sku ILIKE '%'||$1||'%' OR s.title ILIKE '%'||$1||'%'
           OR EXISTS (SELECT 1 FROM overstock_cartons c WHERE c.batch=s.batch AND c.item_code=s.item_code AND lower(c.box)=lower($1))
        ORDER BY s.title, s.sku LIMIT 300`, [q]);
    // Manual entries survive a deleted upload, so surface them even with no packing list behind them.
    const man = await db(
      `SELECT m.sku, NULL::text AS title, NULL::text AS variant, NULL::text AS batch, NULL::text AS item_code,
              m.box AS manual_box, NULL::text AS boxes
         FROM overstock_manual m
        WHERE (lower(m.sku)=lower($1) OR lower(m.box)=lower($1) OR m.sku ILIKE '%'||$1||'%')
          AND NOT EXISTS (SELECT 1 FROM overstock_skus s WHERE lower(s.sku)=lower(m.sku))
        ORDER BY m.sku LIMIT 100`, [q]);
    res.json({ items: [...r.rows, ...man.rows], count: r.rows.length + man.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// What is inside one carton.
app.get("/api/overstock/box/:box", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const box = String(req.params.box || "").trim();
    const lines = await db(
      `SELECT c.box, c.item_code, c.qty, c.style, c.color, c.batch,
              (SELECT string_agg(s.variant, ', ') FROM overstock_skus s WHERE s.batch=c.batch AND s.item_code=c.item_code) AS sizes,
              (SELECT min(s.title) FROM overstock_skus s WHERE s.batch=c.batch AND s.item_code=c.item_code) AS title
         FROM overstock_cartons c WHERE lower(c.box)=lower($1) ORDER BY c.item_code`, [box]);
    const manual = await db(`SELECT sku, box FROM overstock_manual WHERE lower(box)=lower($1) ORDER BY sku`, [box]);
    res.json({ box, lines: lines.rows, manual: manual.rows, count: lines.rows.length, units: lines.rows.reduce((n, x) => n + (x.qty || 0), 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Set or clear a manual carton for one SKU (overrides the packing list for that SKU only).
app.post("/api/overstock/set", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const sku = String((req.body && req.body.sku) || "").trim();
    const box = String((req.body && req.body.box) || "").trim();
    if (!sku) return res.status(400).json({ error: "sku required" });
    const by = actorOf(req);
    const prev = await db(`SELECT box FROM overstock_manual WHERE lower(sku)=lower($1)`, [sku]);
    const fromBox = prev.rows[0] ? prev.rows[0].box : null;
    if (!box) {
      await db(`DELETE FROM overstock_manual WHERE lower(sku)=lower($1)`, [sku]);
      await db(`INSERT INTO overstock_log (sku,from_box,to_box,scope,user_name) VALUES ($1,$2,NULL,'sku',$3)`, [sku, fromBox, by]);
      return res.json({ ok: true, sku, box: null, cleared: true, from_box: fromBox });
    }
    await db(`INSERT INTO overstock_manual (sku,box,updated_by,updated_at) VALUES ($1,$2,$3,now())
              ON CONFLICT (sku) DO UPDATE SET box=EXCLUDED.box, updated_by=EXCLUDED.updated_by, updated_at=now()`, [sku, box, by]);
    await db(`INSERT INTO overstock_log (sku,from_box,to_box,scope,user_name) VALUES ($1,$2,$3,'sku',$4)`, [sku, fromBox, box, by]);
    res.json({ ok: true, sku, box, from_box: fromBox });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Re-label a whole carton — the common case when a box is physically moved.
app.post("/api/overstock/move-box", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const from = String((req.body && req.body.from) || "").trim();
    const to = String((req.body && req.body.to) || "").trim();
    if (!from || !to) return res.status(400).json({ error: "from and to required" });
    if (from.toLowerCase() === to.toLowerCase()) return res.status(400).json({ error: "that's the same box" });
    const by = actorOf(req);
    const c = await db(`UPDATE overstock_cartons SET box=$2 WHERE lower(box)=lower($1) RETURNING id`, [from, to]);
    const m = await db(`UPDATE overstock_manual SET box=$2, updated_at=now(), updated_by=$3 WHERE lower(box)=lower($1) RETURNING sku`, [from, to, by]);
    if (!c.rows.length && !m.rows.length) return res.status(404).json({ error: `nothing is in box ${from}` });
    await db(`INSERT INTO overstock_log (sku,from_box,to_box,scope,user_name) VALUES (NULL,$1,$2,'box',$3)`, [from, to, by]);
    res.json({ ok: true, from, to, moved: c.rows.length + m.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Recent manual changes, newest first.
app.get("/api/overstock/log", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const r = await db(`SELECT sku,from_box,to_box,scope,user_name,ts FROM overstock_log ORDER BY ts DESC LIMIT 50`);
    res.json({ log: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Out of stock — preview the drafted customer email for one item on an order.
app.get("/api/oos/preview", async (req, res) => {
  if (!guard(req, res)) return;
  try { res.json(await oosContext(req.query.order, req.query.skus || req.query.sku)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Out of stock — record the case (with the approved/edited draft). The Helpdesk sends it to the customer automatically.
app.post("/api/oos/create", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { order, sku, skus, subject, text } = req.body || {};
    const list = Array.isArray(skus) && skus.length ? skus : (sku ? [sku] : []);
    if (!order || !list.length) return res.status(400).json({ error: "order and at least one sku required" });
    const ctx = await oosContext(order, list);
    if (!ctx.found) return res.status(404).json({ error: ctx.no_item ? "none of those items are on that order" : "order not found" });
    const subj = (subject && String(subject).trim()) || ctx.subject;
    const body = (text && String(text).trim()) || ctx.text;
    const by = actorOf(req);
    const names = ctx.items.map((i) => i.name).join(" + ");
    const ins = await db(
      `INSERT INTO oos_cases (order_number,sku,item_name,qty,unit_price,item_value,credit_value,brand,customer_name,customer_email,email_subject,email_text,status,created_by,items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_approval',$13,$14) RETURNING id`,
      [ctx.order_number, ctx.items.map((i) => i.sku).join(","), names, ctx.items.reduce((a, i) => a + (Number(i.qty) || 1), 0), ctx.items.length === 1 ? ctx.items[0].unit_price : null,
       ctx.item_value, ctx.credit_value, ctx.brand, ctx.customer_name, ctx.customer_email, subj, body, by, JSON.stringify(ctx.items)]
    );
    const caseId = ins.rows[0].id;
    // The case row IS the hand-off: the Helpdesk picks it up within a minute, emails the customer from the brand
    // mailbox, opens a ticket for the reply, and follows up itself after 48 hours of silence.
    res.json({ ok: true, case_id: caseId, queued: true, auto_send: true, subject: subj, text: body, item_value: ctx.item_value, credit_value: ctx.credit_value, items: ctx.items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Out of stock — recent cases (for a future review view).
app.get("/api/oos/cases", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const r = await db(`SELECT id,order_number,sku,item_name,item_value,credit_value,brand,customer_name,status,resolution,created_by,created_at FROM oos_cases ORDER BY created_at DESC LIMIT 100`);
    res.json({ cases: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Full item detail by SKU.
app.get("/api/item/:sku", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const sku = req.params.sku;
    const matches = (await shopifyFind({ sku })).filter((m) => !m.error);
    const loc = await getItemLocation(sku);
    let currentBin = loc?.bin || null;
    if (!currentBin) currentBin = await readThroughBin(sku, matches[0]?.title);
    res.json({
      sku, title: matches[0]?.title || loc?.title || null, barcode: matches[0]?.barcode || loc?.barcode || null,
      image: matches.find((m) => m.image)?.image || null,
      stores: matches.map((m) => ({ brand: m.brand, qty: m.qty, status: m.status, variant: m.variant, price: m.price })),
      total_qty: matches.reduce((s, m) => s + (Number(m.qty) || 0), 0),
      current_bin: currentBin, location_updated_at: loc?.updated_at || null, location_updated_by: loc?.updated_by || null,
      overstock: await overstockFor(sku),
      history: await getHistory(sku, 50),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Bin contents.
app.get("/api/bin/:code", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const b = await db(`SELECT code,label FROM bins WHERE lower(code)=lower($1)`, [req.params.code]);
    res.json({ bin: b.rows[0]?.code || req.params.code, label: b.rows[0]?.label || null, items: await binItems(req.params.code) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// History for a SKU.
app.get("/api/history/:sku", async (req, res) => {
  if (!guard(req, res)) return;
  try { res.json({ sku: req.params.sku, history: await getHistory(req.params.sku, 200) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Move / set an item's bin (writes DB + history + pushes to ShipStation).
app.post("/api/move", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { sku, toBin, addBin, removeBin, note, qtySeen } = req.body || {};
    if (!sku) return res.status(400).json({ error: "sku required" });
    // Actor is derived from the login key, not the client — so history always reflects who is signed in.
    res.json(await moveItem({ sku, toBin, addBin, removeBin, user: actorOf(req), note, qtySeen, source: "scan" }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Remove a bin from EVERY item that has it (clear the whole bin).
app.post("/api/bin-clear", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const bin = (req.body && req.body.bin) || "";
    if (!bin) return res.status(400).json({ error: "bin required" });
    const items = await binItems(bin);
    let cleared = 0, ssFailed = 0;
    for (const it of items) {
      try { const r = await moveItem({ sku: it.sku, removeBin: bin, user: actorOf(req), source: "scan" }); cleared++; if (r.shipstation && r.shipstation.error) ssFailed++; }
      catch (e) { /* skip a single failure, keep clearing */ }
    }
    res.json({ ok: true, cleared, ss_failed: ssFailed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Bins registry.
app.get("/api/bins", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    // Single-pass count: expand every item's location into tokens ONCE, group, then join to bins.
    // (The old per-bin correlated subquery was O(bins×items) and timed out on a full catalog.)
    const r = await db(`
      WITH toks AS (
        SELECT trim(lower(x)) AS code FROM item_location, unnest(string_to_array(bin, ',')) AS x
        WHERE bin IS NOT NULL AND bin <> ''
      ), counts AS (
        SELECT code, COUNT(*)::int AS items FROM toks WHERE code <> '' GROUP BY code
      )
      SELECT b.code, b.label, COALESCE(c.items, 0) AS items
      FROM bins b LEFT JOIN counts c ON lower(b.code) = c.code
      ORDER BY b.code`);
    res.json({ bins: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Import existing bin locations from ShipStation (warehouseLocation → app DB). Idempotent.
app.post("/api/sync-shipstation", async (req, res) => {
  if (!guard(req, res)) return;
  try { res.json(await syncFromShipStation()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/bins", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { code, label } = req.body || {};
    if (!code) return res.status(400).json({ error: "code required" });
    await db(`INSERT INTO bins (code,label) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label`, [code, label || code]);
    res.json({ ok: true, code, label: label || code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Product NAME / SKU search across the whole Shopify catalog (all 3 stores), with current bins merged in.
app.get("/api/find", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const term = String(req.query.q || "").trim();
    if (term.length < 2) return res.json({ items: [], count: 0 });
    let rows = await shopifySearchByName(term);
    const skus = [...new Set(rows.map((r) => r.sku).filter(Boolean))];
    const binBySku = {};
    if (skus.length) { const b = await db(`SELECT sku,bin FROM item_location WHERE sku = ANY($1)`, [skus]); for (const r of b.rows) binBySku[r.sku] = r.bin; }
    const osBySku = {};
    if (skus.length) {
      const o = await db(
        `SELECT s.sku, COALESCE(m.box, (SELECT string_agg(t.box, ', ' ORDER BY t.k) FROM (SELECT DISTINCT c.box, (CASE WHEN c.box ~ '^[0-9]+$' THEN lpad(c.box,8,'0') ELSE c.box END) AS k FROM overstock_cartons c WHERE c.batch=s.batch AND c.item_code=s.item_code) t)) AS box
           FROM overstock_skus s LEFT JOIN overstock_manual m ON lower(m.sku)=lower(s.sku)
          WHERE s.sku = ANY($1)`, [skus]);
      for (const r of o.rows) osBySku[r.sku] = r.box;
    }
    rows = rows.map((r) => ({ ...r, bin: r.sku ? (binBySku[r.sku] || null) : null, overstock_box: r.sku ? (osBySku[r.sku] || null) : null }));
    rows.sort((a, b) => (a.title || "").localeCompare(b.title || "") || (a.brand || "").localeCompare(b.brand || ""));
    res.json({ items: rows, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Simple search (SKU/title contains) over what we've located, for the browse view.
app.get("/api/search", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const q = `%${String(req.query.q || "").toLowerCase()}%`;
    const r = await db(`SELECT sku,bin,title,barcode,updated_at FROM item_location WHERE lower(sku) LIKE $1 OR lower(coalesce(title,'')) LIKE $1 ORDER BY updated_at DESC LIMIT 100`, [q]);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- Stock Verification API ---- */
// Header counts.
app.get("/api/stock/summary", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const r = await db(`
      SELECT
        (SELECT COUNT(*) FROM stock_items WHERE status IS NULL OR status<>'ARCHIVED')::int AS total,
        (SELECT COUNT(*) FROM stock_items si WHERE (si.status IS NULL OR si.status<>'ARCHIVED') AND NOT EXISTS (SELECT 1 FROM stock_verifications sv WHERE sv.sku=si.sku))::int AS never_verified,
        (SELECT COUNT(*) FROM stock_items WHERE on_hand IS NOT NULL AND on_hand<=3 AND (status IS NULL OR status<>'ARCHIVED'))::int AS low_stock,
        (SELECT COUNT(*) FROM stock_verifications WHERE verified_at < now() - interval '30 days')::int AS stale,
        (SELECT COUNT(*) FROM stock_verifications WHERE matched = false AND coalesce(corrected,false) = false)::int AS discrepancies`);
    res.json({ ...r.rows[0], sync: invSync });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Filtered / sorted verification worklist.
app.get("/api/stock/list", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const q = String(req.query.q || "").trim(), brand = String(req.query.brand || "").trim();
    const qtyMin = req.query.qtyMin !== undefined && req.query.qtyMin !== "" ? Number(req.query.qtyMin) : null;
    const qtyMax = req.query.qtyMax !== undefined && req.query.qtyMax !== "" ? Number(req.query.qtyMax) : null;
    const status = String(req.query.status || "").trim().toUpperCase(); // ACTIVE / DRAFT / ARCHIVED / ALL
    const vop = String(req.query.vop || "any").toLowerCase(), vdate = String(req.query.vdate || "").trim();
    const disc = req.query.disc === "1", nobin = req.query.nobin === "1";
    const sort = String(req.query.sort || "onhand_asc").toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 500, 2000), offset = Number(req.query.offset) || 0;
    const where = [], p = [];
    if (status && status !== "ALL") { p.push(status); where.push(`upper(coalesce(si.status,'')) = $${p.length}`); }
    if (q) { p.push(`%${q.toLowerCase()}%`); where.push(`(lower(si.sku) LIKE $${p.length} OR lower(coalesce(si.title,'')) LIKE $${p.length})`); }
    if (brand) { p.push(brand); where.push(`si.brand = $${p.length}`); }
    if (qtyMin !== null && Number.isFinite(qtyMin)) { p.push(qtyMin); where.push(`si.on_hand IS NOT NULL AND si.on_hand >= $${p.length}`); }
    if (qtyMax !== null && Number.isFinite(qtyMax)) { p.push(qtyMax); where.push(`si.on_hand IS NOT NULL AND si.on_hand <= $${p.length}`); }
    if (disc) where.push(`sv.matched = false AND coalesce(sv.corrected,false) = false`); // unresolved mismatches only
    if (nobin) where.push(`(il.bin IS NULL OR il.bin = '')`);
    if (vop === "never") where.push(`sv.verified_at IS NULL`);
    else if (["before", "after", "on"].includes(vop) && vdate) { p.push(vdate); const op = vop === "before" ? "<" : vop === "after" ? ">" : "="; where.push(`sv.verified_at IS NOT NULL AND sv.verified_at::date ${op} $${p.length}::date`); }
    const orderBy = sort === "onhand_desc" ? "si.on_hand DESC NULLS LAST" : sort === "verified_old" ? "sv.verified_at ASC NULLS FIRST" : sort === "verified_new" ? "sv.verified_at DESC NULLS LAST" : sort === "title" ? "si.title ASC" : "si.on_hand ASC NULLS FIRST";
    const joinWhere = `FROM stock_items si
      LEFT JOIN stock_verifications sv ON sv.sku = si.sku
      LEFT JOIN item_location il ON il.sku = si.sku
      ${where.length ? "WHERE " + where.join(" AND ") : ""}`;
    const total = (await db(`SELECT COUNT(*)::int n ${joinWhere}`, p)).rows[0].n;
    const sql = `SELECT si.sku, si.brand, si.title, si.variant, si.on_hand, si.status,
        sv.verified_at, sv.verified_by, sv.counted_qty, sv.system_qty, sv.matched, sv.corrected, il.bin
      ${joinWhere}
      ORDER BY ${orderBy}, si.sku LIMIT ${limit} OFFSET ${offset}`;
    const r = await db(sql, p);
    res.json({ items: r.rows, count: r.rows.length, total, offset, limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// One SKU's verification detail + history.
app.get("/api/stock/item/:sku", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const sku = req.params.sku;
    const items = (await db(`SELECT brand,title,variant,on_hand,status FROM stock_items WHERE sku=$1`, [sku])).rows;
    const last = (await db(`SELECT counted_qty,system_qty,matched,corrected,verified_by,verified_at,note FROM stock_verifications WHERE sku=$1`, [sku])).rows[0] || null;
    const bin = (await db(`SELECT bin FROM item_location WHERE sku=$1`, [sku])).rows[0]?.bin || null;
    const history = (await db(`SELECT counted_qty,system_qty,corrected,correction_note,user_name,note,ts FROM stock_verification_log WHERE sku=$1 ORDER BY ts DESC LIMIT 30`, [sku])).rows;
    const system = items.length ? items.reduce((m, r) => (r.on_hand != null ? Math.max(m, r.on_hand) : m), 0) : null;
    res.json({ sku, title: items[0]?.title || null, bin, brands: items, system_qty: items.length ? system : null, last, history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Record a physical count (who/when) and correct Shopify on-hand to it when it differs.
// Shared by /api/stock/verify and the low-stock path of /api/stock/putback. Returns the result object.
async function doVerify(sku, cnt, by, note) {
  const items = (await db(`SELECT brand,on_hand FROM stock_items WHERE sku=$1`, [sku])).rows;
  const system = items.length ? items.reduce((m, r) => (r.on_hand != null ? Math.max(m, r.on_hand) : m), 0) : null;
  const matched = system != null && cnt === system;
  let correction = null, correctionNote = null;
  if (system == null || cnt !== system) {
    correction = await shopifySetOnHand(sku, cnt);
    const okc = correction.filter((c) => c.ok), bad = correction.filter((c) => !c.ok);
    correctionNote = correction.length ? [okc.length ? `set ${okc.map((c) => c.brand).join(", ")} → ${cnt}` : "", bad.length ? `failed: ${bad.map((c) => `${c.brand} (${c.error})`).join("; ")}` : ""].filter(Boolean).join(" · ") : "no Shopify inventory item on file";
  }
  // "corrected" = the count differed AND we successfully wrote Shopify to match (so it's now consistent).
  const corrected = !!(correction && correction.some((c) => c.ok));
  await db(`INSERT INTO stock_verifications (sku,counted_qty,system_qty,matched,corrected,verified_by,verified_at,note)
    VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
    ON CONFLICT (sku) DO UPDATE SET counted_qty=$2, system_qty=$3, matched=$4, corrected=$5, verified_by=$6, verified_at=now(), note=$7`,
    [sku, cnt, system, matched, corrected, by, note || null]);
  await db(`INSERT INTO stock_verification_log (sku,counted_qty,system_qty,corrected,correction_note,user_name,note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sku, cnt, system, corrected, correctionNote, by, note || null]);
  return { ok: true, sku, counted: cnt, system_qty: system, matched, corrected, verified_by: by, correction, correction_note: correctionNote };
}
app.post("/api/stock/verify", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { sku, counted, note } = req.body || {};
    if (!sku || counted === undefined || counted === null || counted === "") return res.status(400).json({ error: "sku and counted required" });
    const cnt = Number(counted);
    if (!Number.isFinite(cnt) || cnt < 0) return res.status(400).json({ error: "counted must be a non-negative number" });
    res.json(await doVerify(sku, cnt, actorOf(req), note));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Strays — put a wrong-pick / found item / sellable return back into a bin. Logs the put-back.
// If the item is under 3 on hand, a physical recount is REQUIRED and that recount corrects Shopify.
const STRAY_VERIFY_THRESHOLD = 3; // "under 3" → recount required
app.post("/api/stock/putback", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { sku, qty, counted, note } = req.body || {};
    if (!sku) return res.status(400).json({ error: "sku required" });
    const putQty = qty === undefined || qty === null || qty === "" ? 1 : Number(qty);
    if (!Number.isFinite(putQty) || putQty < 1) return res.status(400).json({ error: "quantity must be at least 1" });
    const by = actorOf(req);
    const items = (await db(`SELECT brand,title,on_hand FROM stock_items WHERE sku=$1`, [sku])).rows;
    if (!items.length) return res.status(404).json({ error: "item not found in stock" });
    const system = items.reduce((m, r) => (r.on_hand != null ? Math.max(m, r.on_hand) : m), null);
    const title = items.find((r) => r.title)?.title || null;
    const bin = (await db(`SELECT bin FROM item_location WHERE sku=$1`, [sku])).rows[0]?.bin || null;
    const needsVerify = system != null && system < STRAY_VERIFY_THRESHOLD;
    const hasCount = counted !== undefined && counted !== null && counted !== "";
    // Low-stock items must be recounted before the put-back can be saved.
    if (needsVerify && !hasCount) return res.status(400).json({ error: "recount required", needs_verify: true, sku, title, bin, system_qty: system });
    let verify = null;
    if (hasCount) {
      const cnt = Number(counted);
      if (!Number.isFinite(cnt) || cnt < 0) return res.status(400).json({ error: "count must be a non-negative number" });
      verify = await doVerify(sku, cnt, by, note ? `put-back · ${note}` : "put-back recount");
    }
    const verified = !!verify;
    await db(`INSERT INTO stock_strays (sku,title,qty,bin,system_qty,verified,counted_qty,user_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sku, title, putQty, bin, system, verified, verify ? verify.counted : null, by]);
    res.json({ ok: true, sku, title, bin, qty: putQty, system_qty: system, needs_verify: needsVerify, verified, verify, user_name: by });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Strays — recent put-backs (audit list for the Strays screen).
app.get("/api/stock/strays", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const r = await db(`SELECT sku,title,qty,bin,system_qty,verified,counted_qty,user_name,ts FROM stock_strays ORDER BY ts DESC LIMIT 60`);
    res.json({ strays: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Trigger / poll the Shopify inventory snapshot sync.
app.post("/api/stock/sync-inventory", async (req, res) => {
  if (!guard(req, res)) return;
  if (invSync.running) return res.json({ running: true, synced: invSync.synced });
  syncShopifyInventory().catch(() => {});
  res.json({ started: true });
});
app.get("/api/stock/sync-status", (req, res) => { if (!guard(req, res)) return; res.json(invSync); });

const PORT = process.env.PORT || 8080;
(async () => {
  try { await migrate(); console.log("🗄️  Postgres schema ready"); }
  catch (e) { console.error("❌ DB migrate failed:", e.message); }
  app.listen(PORT, () => {
    console.log(`📦 Stockroom on :${PORT}`);
    console.log(`🔎 boot → users:${USERS.length ? USERS.map((u) => u.name).join("/") : "(none)"}${ACCESS_KEY ? "+admin-key" : ""} · db:${process.env.DATABASE_URL ? "set" : "MISSING"} · shopify:${STORES.length} stores · shipstation:${ssConfigured() ? "set" : "off"} · ver:${SHOP_VER}`);
  });
  // Live reachability probes.
  if (ssConfigured()) {
    try { const c = await ssReq("GET", "/carriers"); console.log(`   ✅ ShipStation reachable — ${Array.isArray(c) ? c.length : 0} carriers`); }
    catch (e) { console.error(`   ❌ ShipStation FAILED — ${e.message}`); }
  }
  for (const st of STORES) {
    try { await storeToken(st); console.log(`   ✅ ${st.brand}: Shopify token OK`); }
    catch (e) { console.error(`   ❌ ${st.brand}: Shopify token FAILED — ${e.message}`); }
  }
  // Keep the app's bins mirrored from ShipStation: sync on every boot (background) and every 6 hours.
  if (ssConfigured()) {
    const runSync = (tag) => syncFromShipStation()
      .then((r) => console.log(`📥 ShipStation sync (${tag}): ${JSON.stringify(r)}`))
      .catch((e) => console.error(`📥 sync failed (${tag}):`, e.message));
    console.log("📥 syncing bins from ShipStation on boot…");
    runSync("boot");
    setInterval(() => runSync("6h"), 6 * 60 * 60 * 1000);
  }
  // Stock Verification: seed the Shopify inventory snapshot on first boot (only if empty), refresh every 12h.
  if (STORES.length) {
    // Purge rows for any store no longer in SHOPIFY_STORES (e.g. a merged/removed brand like Bumbunny).
    try {
      const brands = STORES.map((s) => s.brand);
      const del = await db(`DELETE FROM stock_items WHERE brand <> ALL($1::text[])`, [brands]);
      if (del.rowCount) console.log(`📊 purged ${del.rowCount} stock_items rows from removed stores (kept: ${brands.join(", ")})`);
    } catch (e) { console.error("📊 stock_items purge failed:", e.message); }
    try {
      const n = (await db(`SELECT COUNT(*)::int n FROM stock_items`)).rows[0].n;
      if (!n) { console.log("📊 stock_items empty — running first Shopify inventory sync (background)…"); syncShopifyInventory().then((r) => console.log("📊 inventory sync:", JSON.stringify(r))).catch((e) => console.error("📊 inventory sync failed:", e.message)); }
      else console.log(`📊 stock_items: ${n} rows (12h refresh scheduled)`);
    } catch (e) { console.error("📊 stock_items check failed:", e.message); }
    setInterval(() => { syncShopifyInventory().then((r) => console.log("📊 inventory 12h sync:", JSON.stringify(r))).catch(() => {}); }, 12 * 60 * 60 * 1000);
  }
})();
