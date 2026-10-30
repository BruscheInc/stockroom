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
const crypto = require("crypto");
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
// Built-in (Railway setting) users who are admins. Everyone else in STOCKROOM_USERS is staff.
const ENV_ADMINS = (process.env.STOCKROOM_ADMINS || "Jose").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/* Accounts made in the app live in sr_users (username + password, role admin|staff). Signing in creates a
 * session token; the app sends that token as its key, so every existing API call works unchanged.
 * The built-in STOCKROOM_USERS logins and ACCESS_KEY keep working, so nobody gets locked out. */
const SESSIONS = new Map();   // token -> { name, role, user_id, exp }
const TAKEN = new Set();      // lower-case usernames that have an app account — a built-in login with that name is retired
const retired = (u) => TAKEN.has(u.name.toLowerCase()) || TAKEN.has(u.key.toLowerCase());
const SESSION_DAYS = 180;     // warehouse phones stay signed in
function hashPassword(pw) { const salt = crypto.randomBytes(16).toString("hex"); return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString("hex") }; }
function checkPassword(pw, salt, hash) { try { const h = crypto.scryptSync(String(pw), salt, 64), b = Buffer.from(hash, "hex"); return h.length === b.length && crypto.timingSafeEqual(h, b); } catch { return false; } }
// Resolve a key to { name, role }. Order: session token, built-in user, legacy ACCESS_KEY.
function whoFromKey(key) {
  const k = String(key || "").trim();
  if (!k) return null;
  const s = SESSIONS.get(k);
  if (s) { if (s.exp > Date.now()) return { name: s.name, role: s.role, user_id: s.user_id }; SESSIONS.delete(k); }
  const u = USERS.find((u) => u.key.toLowerCase() === k.toLowerCase() && !retired(u));
  if (u) return { name: u.name, role: ENV_ADMINS.includes(u.name.toLowerCase()) ? "admin" : "staff", builtin: true };
  if (ACCESS_KEY && k === ACCESS_KEY) return { name: "admin", role: "admin", builtin: true };
  return null;
}
function userFromKey(key) { const w = whoFromKey(key); return w ? w.name : null; }

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
  // App accounts (admin portal) + their sign-in sessions + who changed what.
  await db(`CREATE TABLE IF NOT EXISTS sr_users (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL,
    pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff',
    active BOOLEAN NOT NULL DEFAULT true, created_by TEXT, created_at TIMESTAMPTZ DEFAULT now(), last_login TIMESTAMPTZ)`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sr_users_uname ON sr_users (lower(username))`);
  await db(`CREATE TABLE IF NOT EXISTS sr_sessions (token TEXT PRIMARY KEY, user_id INT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL)`);
  await db(`CREATE TABLE IF NOT EXISTS sr_user_log (id BIGSERIAL PRIMARY KEY, who TEXT, target TEXT, detail TEXT, ts TIMESTAMPTZ DEFAULT now())`);
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
  // Bins are kept as written (S-25 and 534-L are both real formats). Only case, spaces, a missing dash and leading
  // zeros are tidied: "s - 025", "S25" and "s-25" are all S-25.
  await db(`CREATE OR REPLACE FUNCTION bin_canon(t TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT regexp_replace(
             regexp_replace(regexp_replace(
               regexp_replace(upper(trim(coalesce(t, ''))), '[[:space:]]*-[[:space:]]*', '-', 'g'),
             '^([A-Z]+)[[:space:]]*([0-9]+)$', '\\1-\\2'), '^([0-9]+)[[:space:]]*([A-Z]+)$', '\\1-\\2'),
           '(^|-)0+([0-9])', '\\1\\2', 'g') $$`);
  // The bin's identity: location letters + number, whichever side they're written on (R-35 = 35-R = R35).
  await db(`CREATE OR REPLACE FUNCTION bin_key(t TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN c ~ '^[A-Z]+-[0-9]+$' THEN substring(c from '^([A-Z]+)') || '|' || substring(c from '([0-9]+)$')
                WHEN c ~ '^[0-9]+-[A-Z]+$' THEN substring(c from '([A-Z]+)$') || '|' || substring(c from '^([0-9]+)')
                ELSE c END FROM (SELECT bin_canon(t) AS c) s $$`);
  await db(`CREATE INDEX IF NOT EXISTS idx_loc_bin ON item_location(bin)`);
  // Archived bins: hidden from the bin list and reports (keyed by bin identity, so any spelling matches). Reversible.
  await db(`CREATE TABLE IF NOT EXISTS sr_settings (key TEXT PRIMARY KEY, value TEXT, updated_by TEXT, updated_at TIMESTAMPTZ DEFAULT now())`);
  await db(`INSERT INTO sr_settings (key,value,updated_by) VALUES ('rebin_since','2026-10-30','setup') ON CONFLICT (key) DO NOTHING`);
  await db(`CREATE TABLE IF NOT EXISTS bin_archive (key TEXT PRIMARY KEY, code TEXT, archived_by TEXT, archived_at TIMESTAMPTZ DEFAULT now(), items_cleared INT DEFAULT 0)`);
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
  // Quantity activity: every time a SKU's on-hand goes down or up, why, who and when.
  // Sources: ShipStation shipments (an order shipped), manual adjustments, stock-verification corrections.
  // `ref` de-duplicates entries pulled from outside (one row per shipment + SKU).
  await db(`CREATE TABLE IF NOT EXISTS stock_activity (
    id BIGSERIAL PRIMARY KEY,
    sku TEXT NOT NULL,
    title TEXT,
    change INTEGER NOT NULL,
    qty_before INTEGER,
    qty_after INTEGER,
    reason TEXT,
    detail TEXT,
    ref TEXT,
    user_name TEXT,
    ts TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`CREATE INDEX IF NOT EXISTS idx_act_sku ON stock_activity(sku, ts DESC)`);
  await db(`CREATE INDEX IF NOT EXISTS idx_act_ts ON stock_activity(ts DESC)`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS idx_act_ref ON stock_activity(ref) WHERE ref IS NOT NULL`);
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
  inventoryItem{ id inventoryLevels(first:10){ edges{ node{ location{ name } quantities(names:["available","committed","on_hand","reserved","damaged","quality_control","safety_stock"]){ name quantity } } } } }
}}}}`;
// Shopify's inventory columns, per location and summed. "Unavailable" = damaged + quality control + safety stock + reserved,
// the same way Shopify admin adds it up.
function levelsOf(node) {
  const locs = [];
  for (const e of (node?.inventoryItem?.inventoryLevels?.edges || [])) {
    const q = {}; for (const x of (e.node.quantities || [])) q[x.name] = Number(x.quantity) || 0;
    locs.push({ location: e.node.location?.name || "", on_hand: q.on_hand ?? 0, available: q.available ?? 0, committed: q.committed ?? 0,
      unavailable: (q.damaged || 0) + (q.quality_control || 0) + (q.safety_stock || 0) + (q.reserved || 0) });
  }
  if (!locs.length) return null;
  const sum = (k) => locs.reduce((a, l) => a + l[k], 0);
  return { on_hand: sum("on_hand"), available: sum("available"), committed: sum("committed"), unavailable: sum("unavailable"), locations: locs };
}
// Only ACTIVE listings count toward stock. Archived/draft listings are shown on their own and never added in.
const isActive = (status) => String(status || "").toUpperCase() === "ACTIVE";
function activeOnly(rows, statusKey = "status") { const a = rows.filter((r) => isActive(r[statusKey])); return a.length ? a : rows; }
// Per-store rows for the product view, plus totals over ACTIVE listings only.
function stockSummary(matches) {
  const stores = matches.map((m) => ({ brand: m.brand, qty: m.levels ? m.levels.on_hand : m.qty, status: m.status, variant: m.variant, price: m.price,
    active: isActive(m.status), levels: m.levels || null }));
  const act = stores.filter((x) => x.active);
  const tot = (k) => act.length && act.every((x) => x.levels) ? act.reduce((a, x) => a + x.levels[k], 0) : null;
  return {
    stores,
    total_qty: act.length ? act.reduce((a, x) => a + (Number(x.qty) || 0), 0) : null,   // on hand, active only
    totals: act.length ? { on_hand: tot("on_hand"), available: tot("available"), committed: tot("committed"), unavailable: tot("unavailable") } : null,
    inactive_qty: stores.filter((x) => !x.active).reduce((a, x) => a + (Number(x.qty) || 0), 0),
  };
}
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
          status: n.product?.status, levels: levelsOf(n),
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
// Make sure stock_items has a row (with the Shopify inventory item id) for every store that carries a SKU.
// New products that haven't been through the 12-hour snapshot yet get looked up live and added.
async function ensureStockItem(sku) {
  const read = () => db(`SELECT sku,brand,title,variant,inv_item_id,on_hand,status FROM stock_items WHERE sku=$1`, [sku]).then((r) => r.rows);
  let rows = await read();
  if (rows.length && rows.every((r) => r.inv_item_id)) return rows;
  await Promise.all(STORES.map(async (st) => {
    try {
      const d = await storeGraphQL(st, VARIANT_QUERY, { q: `sku:${JSON.stringify(sku)}` });
      for (const e of (d.productVariants?.edges || [])) {
        const n = e.node;
        if (String(n.sku || "").toLowerCase() !== String(sku).toLowerCase() || !n.inventoryItem?.id) continue;
        await db(
          `INSERT INTO stock_items (sku,brand,title,variant,on_hand,status,inv_item_id,synced_at) VALUES ($1,$2,$3,$4,NULL,$5,$6,now())
           ON CONFLICT (sku,brand) DO UPDATE SET inv_item_id=EXCLUDED.inv_item_id, title=COALESCE(stock_items.title,EXCLUDED.title), status=EXCLUDED.status`,
          [n.sku, st.brand, n.product?.title || n.displayName, n.displayName, n.product?.status || null, n.inventoryItem.id]);
      }
    } catch (e) { /* a store that errors just doesn't get a row */ }
  }));
  return read();
}
// Live on-hand per store for a SKU (same location the set call writes to). null = couldn't read it.
async function liveOnHand(sku) {
  const rows = await ensureStockItem(sku);
  const out = [];
  for (const r of rows) {
    const st = STORES.find((s) => s.brand === r.brand);
    let onHand = null;
    if (st && r.inv_item_id) {
      try {
        const d = await storeGraphQL(st, `query($id:ID!){inventoryItem(id:$id){inventoryLevels(first:5){edges{node{quantities(names:["on_hand"]){name quantity}}}}}}`, { id: r.inv_item_id });
        const n = d.inventoryItem?.inventoryLevels?.edges?.[0]?.node;
        const q = n && (n.quantities || []).find((x) => x.name === "on_hand");
        if (q && q.quantity != null) { onHand = Number(q.quantity); await db(`UPDATE stock_items SET on_hand=$1, synced_at=now() WHERE sku=$2 AND brand=$3`, [onHand, sku, r.brand]); }
      } catch (e) { /* leave null */ }
    }
    out.push({ brand: r.brand, title: r.title, status: r.status, active: isActive(r.status), on_hand: onHand, cached_on_hand: r.on_hand });
  }
  return out;
}
// Reasons staff pick when adjusting → the matching Shopify inventory reason code.
const ADJUST_REASONS = {
  "Damaged": "damaged",
  "Lost / missing": "shrinkage",
  "Found extra": "correction",
  "Customer return": "restock",
  "Received": "received",
  "Count correction": "correction",
  "Other": "other",
};
// Set Shopify on-hand to a quantity for a SKU, across every store that carries it.
// meta = { reason, detail, user, shopReason, uri } — when reason is given, the change is written to the activity log.
async function shopifySetOnHand(sku, qty, meta) {
  meta = meta || {};
  const rows = activeOnly((await db(`SELECT brand, title, inv_item_id, on_hand, status FROM stock_items WHERE sku=$1`, [sku])).rows);
  const out = [];
  const setOne = async (st, invItemId, lvl, reason) => {
    const idem = require("crypto").randomUUID();
    const d = await storeGraphQL(st,
      `mutation($input:InventorySetOnHandQuantitiesInput!){ inventorySetOnHandQuantities(input:$input) @idempotent(key:"${idem}"){ userErrors{field message} } }`,
      { input: { reason, referenceDocumentUri: meta.uri || "logistics://stockroom/verification", setQuantities: [{ inventoryItemId: invItemId, locationId: lvl.locId, quantity: Number(qty), changeFromQuantity: lvl.onHand }] } });
    return d.inventorySetOnHandQuantities?.userErrors || [];
  };
  for (const r of rows) {
    const st = STORES.find((s) => s.brand === r.brand);
    if (!st || !r.inv_item_id) { out.push({ brand: r.brand, ok: false, error: "no Shopify inventory item on file" }); continue; }
    try {
      const lvl = await itemLevel(st, r.inv_item_id);
      if (!lvl.locId) { out.push({ brand: r.brand, ok: false, error: "no fulfillment location" }); continue; }
      const reason = meta.shopReason || "correction";
      let ue = await setOne(st, r.inv_item_id, lvl, reason);
      // If Shopify rejects the specific reason code, fall back to a plain correction rather than failing the save.
      if (ue.length && reason !== "correction" && ue.some((x) => /reason/i.test(`${x.field} ${x.message}`))) ue = await setOne(st, r.inv_item_id, lvl, "correction");
      if (ue.length) { out.push({ brand: r.brand, ok: false, error: ue.map((x) => x.message).join("; ") }); }
      else { out.push({ brand: r.brand, ok: true, from: lvl.onHand, to: Number(qty) }); await db(`UPDATE stock_items SET on_hand=$1, synced_at=now() WHERE sku=$2 AND brand=$3`, [Number(qty), sku, r.brand]); }
    } catch (e) { out.push({ brand: r.brand, ok: false, error: e.message }); }
  }
  const ok = out.filter((o) => o.ok);
  if (meta.reason && ok.length) {
    const from = Math.max(...ok.map((o) => Number(o.from) || 0));
    if (from !== Number(qty)) {
      await logActivity({ sku, title: rows.find((r) => r.title)?.title || null, change: Number(qty) - from, before: from, after: Number(qty),
        reason: meta.reason, detail: meta.detail || null, user: meta.user || null });
    }
  }
  return out;
}

/* --------------------------------------- Quantity activity log --------------------------------------- */
// Returns true when a row was written (false when `ref` says we already have it).
async function logActivity({ sku, title, change, before, after, reason, detail, ref, user, ts }) {
  if (!sku || !Number(change)) return false;
  const r = await db(
    `INSERT INTO stock_activity (sku,title,change,qty_before,qty_after,reason,detail,ref,user_name,ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz,now()))
     ON CONFLICT (ref) WHERE ref IS NOT NULL DO NOTHING RETURNING id`,
    [sku, title || null, Number(change), before ?? null, after ?? null, reason || null, detail || null, ref || null, user || null, ts ? new Date(ts).toISOString() : null]);
  return r.rowCount > 0;
}
async function getActivity(sku, limit = 30) {
  const r = await db(`SELECT id,change,qty_before,qty_after,reason,detail,user_name,ts FROM stock_activity WHERE sku=$1 ORDER BY ts DESC, id DESC LIMIT $2`, [sku, limit]);
  return r.rows;
}
// Last stock verification for one SKU, and for a batch of SKUs (used wherever a product is listed).
async function lastVerification(sku) {
  const r = await db(`SELECT counted_qty,system_qty,matched,corrected,verified_by,verified_at FROM stock_verifications WHERE sku=$1`, [sku]);
  return r.rows[0] || null;
}
async function verificationMap(skus) {
  const out = {};
  const list = [...new Set((skus || []).filter(Boolean))];
  if (!list.length) return out;
  const r = await db(`SELECT sku,verified_at,verified_by FROM stock_verifications WHERE sku = ANY($1)`, [list]);
  for (const row of r.rows) out[row.sku] = row;
  return out;
}

/* --------------------------------------- ShipStation (V1) --------------------------------------- */
const SS_KEY = process.env.SHIPSTATION_API_KEY || "";
const SS_SECRET = process.env.SHIPSTATION_API_SECRET || "";
function ssConfigured() { return !!(SS_KEY && SS_SECRET); }
async function ssReq(method, pathname, body, tries = 0) {
  const auth = "Basic " + Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString("base64");
  const r = await fetch(`https://ssapi.shipstation.com${pathname}`, {
    method, headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  // 40 requests/minute: when ShipStation says slow down, wait the seconds it asks for and try again.
  if (r.status === 429 && tries < 3) {
    const wait = Math.min(65, Number(r.headers.get("x-rate-limit-reset")) || 20) + 1;
    await new Promise((ok) => setTimeout(ok, wait * 1000));
    return ssReq(method, pathname, body, tries + 1);
  }
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

/* --------------------------------------- Shipments → activity log --------------------------------------- */
// Every shipped label pulls pieces off the shelf. Each ShipStation shipment becomes one "Shipped" row per SKU
// (−qty, order number, tracking). A voided label we already logged gets a matching "Label voided" (+qty) row.
// ShipStation V1 dates have no time zone and are US Pacific.
const SS_TZ = "America/Los_Angeles";
function tzOffsetMin(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}
function ssToDate(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return new Date(naive - tzOffsetMin(new Date(naive), SS_TZ) * 60000);
}
function ssFmt(date) { return new Date(date.getTime() + tzOffsetMin(date, SS_TZ) * 60000).toISOString().slice(0, 19).replace("T", " "); }

async function logShipment(s) {
  const bySku = {};
  for (const it of (s.shipmentItems || [])) {
    if (!it || !it.sku) continue;
    const q = Number(it.quantity) || 0; if (!q) continue;
    (bySku[it.sku] = bySku[it.sku] || { qty: 0, name: it.name || null }).qty += q;
  }
  let n = 0;
  for (const [sku, v] of Object.entries(bySku)) {
    const shipRef = `ss-ship:${s.shipmentId}:${sku}`;
    if (s.voided) {
      // Only reverse a shipment we actually logged — a label voided before we ever saw it never left the shelf.
      const had = await db(`SELECT 1 FROM stock_activity WHERE ref=$1`, [shipRef]);
      if (had.rows.length && await logActivity({ sku, title: v.name, change: v.qty, reason: "Label voided", detail: `Order ${s.orderNumber} — shipment voided`, ref: `ss-void:${s.shipmentId}:${sku}`, user: "ShipStation", ts: ssToDate(s.voidDate) || new Date() })) n++;
      continue;
    }
    if (await logActivity({ sku, title: v.name, change: -v.qty, reason: "Shipped", detail: `Order ${s.orderNumber}${s.trackingNumber ? ` · ${s.trackingNumber}` : ""}`, ref: shipRef, user: "ShipStation", ts: ssToDate(s.createDate) || new Date() })) n++;
  }
  return n;
}
let shipPoll = { running: false, at: null, logged: 0, error: null };
async function pollShipments(days) {
  if (!ssConfigured() || shipPoll.running) return shipPoll;
  shipPoll = { ...shipPoll, running: true };
  let logged = 0;
  try {
    const start = ssFmt(new Date(Date.now() - days * 864e5));
    let page = 1, pages = 1;
    do {
      const j = await ssReq("GET", `/shipments?createDateStart=${encodeURIComponent(start)}&includeShipmentItems=true&sortBy=CreateDate&sortDir=ASC&pageSize=500&page=${page}`);
      pages = j.pages || 1;
      for (const s of (j.shipments || [])) logged += await logShipment(s);
      page++;
      if (page <= pages) await new Promise((r) => setTimeout(r, 1600)); // ShipStation: 40 requests/min
    } while (page <= pages);
    shipPoll = { running: false, at: new Date().toISOString(), logged, error: null };
  } catch (e) {
    shipPoll = { running: false, at: new Date().toISOString(), logged, error: e.message };
    console.error("🚚 shipment pull failed:", e.message);
  }
  return shipPoll;
}

/* ---- ShipStation update queue: big moves (bin swaps) update ShipStation in the background, one at a time ---- */
const SSQ = new Map();          // sku -> location (latest wins)
let ssqRunning = false, ssqDone = 0, ssqFailed = [];
function ssQueuePush(sku, loc) { SSQ.delete(sku); SSQ.set(sku, loc); if (!ssqRunning) ssqRun(); }
async function ssqRun() {
  ssqRunning = true;
  while (SSQ.size) {
    const [sku, loc] = SSQ.entries().next().value; SSQ.delete(sku);
    try { await ssSetWarehouseLocation(sku, loc); ssqDone++; }
    catch (e) { ssqFailed.push({ sku, loc, error: e.message, ts: new Date().toISOString() }); ssqFailed = ssqFailed.slice(-50); console.error(`📦 ShipStation update ${sku} → ${loc} failed:`, e.message); }
    await new Promise((ok) => setTimeout(ok, 4500));          // 3 calls per item → stays under 40/min
  }
  ssqRunning = false;
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
async function moveItem({ sku, toBin, addBin, removeBin, user, note, qtySeen, source, batch }) {
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
  if (!batch) { try { const f = (await shopifyFind({ sku }))[0]; if (f && !f.error) { title = f.title || title; barcode = f.barcode || barcode; } } catch {} }
  await db(
    `INSERT INTO item_location (sku,bin,title,barcode,updated_at,updated_by) VALUES ($1,$2,$3,$4,now(),$5)
     ON CONFLICT (sku) DO UPDATE SET bin=$2, title=COALESCE($3,item_location.title), barcode=COALESCE($4,item_location.barcode), updated_at=now(), updated_by=$5`,
    [sku, finalBin, title, barcode, user || null]
  );
  await db(
    `INSERT INTO location_history (sku,from_bin,to_bin,qty_seen,user_name,source,note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sku, fromBin, finalBin, qtySeen ?? null, user || null, source || "scan", note || null]
  );
  if (finalBin) { await registerBinTokens(finalBin); await unarchiveTokens(finalBin, user); }
  // Push to ShipStation (best-effort — never block the local move on it).
  let shipstation = { pushed: false };
  if (batch && ssConfigured()) { ssQueuePush(sku, finalBin || ""); shipstation = { queued: true }; }
  else if (ssConfigured()) {
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
async function unarchiveTokens(loc, user) {
  try { await db(`DELETE FROM bin_archive WHERE key = ANY(SELECT bin_key(x) FROM unnest(regexp_split_to_array($1, '[,;/|]')) x WHERE trim(x) <> '')`, [loc]); } catch {}
}
// A bin code can be reused for a new bin while rebinning (old F-2 → F-26, then a new F-2). An archived bin that
// holds items again is in use, so it stops being archived — the archive only ever hides empty, retired bins.
async function pruneArchive() {
  try {
    const r = await db(`DELETE FROM bin_archive a WHERE EXISTS (
        SELECT 1 FROM item_location il, unnest(regexp_split_to_array(il.bin, '[,;/|]')) x
         WHERE il.bin IS NOT NULL AND trim(x) <> '' AND bin_key(x) = a.key) RETURNING code`);
    if (r.rowCount) console.log(`📦 back in use, un-archived: ${r.rows.map((x) => x.code).join(", ")}`);
    return r.rowCount;
  } catch (e) { return 0; }
}
// One-off data fixes, each run exactly once (recorded in sr_fixes).
async function oneTimeFixes() {
  await db(`CREATE TABLE IF NOT EXISTS sr_fixes (name TEXT PRIMARY KEY, ran_at TIMESTAMPTZ DEFAULT now(), detail TEXT)`);
  const once = async (name, fn) => { if ((await db(`SELECT 1 FROM sr_fixes WHERE name=$1`, [name])).rows.length) return; const d = await fn(); await db(`INSERT INTO sr_fixes (name,detail) VALUES ($1,$2)`, [name, d || null]); console.log(`🔧 ${name}: ${d}`); };
  // 2026-10-30: F-2 was archived when the old F-2 was swapped into F-26, but the number is reused for a new bin.
  // 2026-10-30 (read-only): which swaps done before the old/new-bin rule moved a NEW bin's items?
  await once("check-swaps-moved-new-bin-items-2026-10-30", async () => {
    const r = await db(`
      WITH sw AS (
        SELECT h.id, h.sku, h.ts, h.user_name, h.from_bin, h.to_bin, h.note,
               trim(split_part(substring(h.note from 'Bin swap (.*)'), '→', 1)) AS from_code,
               trim(split_part(substring(h.note from 'Bin swap (.*)'), '→', 2)) AS to_code
          FROM location_history h
         WHERE h.source = 'swap' AND h.ts >= '2026-10-30T05:00:00Z' AND h.note LIKE 'Bin swap %')
      SELECT sw.sku, sw.from_code, sw.to_code, sw.ts AS swapped_at, sw.user_name AS swapped_by,
             p.ts AS put_in_at, coalesce(p.user_name,'') AS put_in_by, p.source AS put_in_source, il.bin AS now_bin
        FROM sw
        JOIN LATERAL (
          SELECT p.ts, p.user_name, p.source FROM location_history p
           WHERE p.sku = sw.sku AND p.ts >= '2026-10-30T05:00:00Z' AND p.ts < sw.ts AND p.id <> sw.id
             AND EXISTS (SELECT 1 FROM unnest(regexp_split_to_array(coalesce(p.to_bin,''), '[,;/|]')) x WHERE trim(x) <> '' AND bin_key(x) = bin_key(sw.from_code))
             AND NOT EXISTS (SELECT 1 FROM unnest(regexp_split_to_array(coalesce(p.from_bin,''), '[,;/|]')) x WHERE trim(x) <> '' AND bin_key(x) = bin_key(sw.from_code))
           ORDER BY p.ts DESC LIMIT 1) p ON true
        LEFT JOIN item_location il ON il.sku = sw.sku
       ORDER BY sw.ts`);
    const total = (await db(`SELECT count(*)::int n, count(DISTINCT note)::int b FROM location_history WHERE source='swap' AND ts >= '2026-10-30T05:00:00Z'`)).rows[0];
    console.log(`🔎 swaps today: ${total.n} item moves across ${total.b} bin swaps · ${r.rows.length} of them moved an item that had been put into the old bin number today`);
    for (const x of r.rows) console.log(`🔎 MOVED-NEW sku=${x.sku} swap=${x.from_code}→${x.to_code} at=${new Date(x.swapped_at).toISOString()} by=${x.swapped_by} | put into ${x.from_code} at=${new Date(x.put_in_at).toISOString()} by=${x.put_in_by} (${x.put_in_source}) | now in: ${x.now_bin}`);
    return `${r.rows.length} of ${total.n}`;
  });
  await once("restore-F-2-reused-2026-10-30", async () => { const r = await db(`DELETE FROM bin_archive WHERE key = bin_key('F-2') RETURNING code`); return r.rowCount ? `restored ${r.rows[0].code}` : "F-2 wasn't archived"; });
}
async function isArchived(code) { return (await db(`SELECT archived_by, archived_at FROM bin_archive WHERE key = bin_key($1)`, [String(code || "").replace(/^BIN[-:]/i, "")])).rows[0] || null; }
// Items in a bin = any item whose location contains that bin as one of its comma-separated tokens.
async function binItems(code) {
  const r = await db(
    `SELECT il.sku,il.bin,il.title,il.barcode,il.updated_at,il.updated_by,sv.verified_at,sv.verified_by
       FROM item_location il LEFT JOIN stock_verifications sv ON sv.sku = il.sku
     WHERE bin_key($1) = ANY(SELECT bin_key(x) FROM unnest(regexp_split_to_array(il.bin, '[,;/|]')) x) ORDER BY il.sku`,
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
      await registerBinTokens(loc); await unarchiveTokens(loc);
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
      await registerBinTokens(loc); await unarchiveTokens(loc);
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
  const verBySku = await verificationMap(skus);
  const items = await Promise.all(skus.map(async (sku) => {
    const base = bySku[sku];
    let bin = binBySku[sku] || base.ss_loc || null;
    if (!bin) { try { bin = await readThroughBin(sku, base.name); } catch {} }
    let on_hand = null, title = base.name, image = base.image, status = null;
    try {
      const f = (await shopifyFind({ sku })).filter((m) => !m.error);
      if (f.length) { const act = f.filter((m) => isActive(m.status)); on_hand = act.length ? act.reduce((s, m) => s + (Number(m.levels ? m.levels.on_hand : m.qty) || 0), 0) : null; title = f[0].title || title; image = f.find((m) => m.image)?.image || image; status = f[0].status || null; }
    } catch {}
    const ver = verBySku[sku];
    return { sku, name: title, qty: base.qty, unit_price: base.unit_price, bin, on_hand, image, status,
      verified_at: ver ? ver.verified_at : null, verified_by: ver ? ver.verified_by : null };
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
  const knownBin = await db(`SELECT code,label FROM bins WHERE lower(code)=lower($1) OR bin_key(code)=bin_key($1) ORDER BY (lower(code)=lower($1)) DESC LIMIT 1`, [binGuess]);
  if (/^BIN[-:]/i.test(code) || knownBin.rows[0]) {
    const bin = knownBin.rows[0]?.code || binGuess;
    const items = await binItems(bin);
    return { type: "bin", bin, label: knownBin.rows[0]?.label || null, items, archived: items.length ? null : await isArchived(bin) };
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
      ...stockSummary(matches),
      current_bin: currentBin, location_updated_at: loc?.updated_at || null, location_updated_by: loc?.updated_by || null,
      overstock: await overstockFor(sku),
      history: await getHistory(sku, 15),
      verification: await lastVerification(sku),
      activity: await getActivity(sku, 20),
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
app.get("/api/role", (req, res) => { const w = whoFromKey(keyFrom(req)); res.json({ ok: !!w, user: w ? w.name : null, role: w ? w.role : null, account: !!(w && w.user_id) }); });

/* ---- Sign in / out ---- */
async function loadTaken() { const r = await db(`SELECT lower(username) AS u FROM sr_users`); TAKEN.clear(); for (const x of r.rows) TAKEN.add(x.u); }
async function loadSessions() {
  await loadTaken();
  const r = await db(`SELECT s.token, s.expires_at, u.id, u.name, u.role FROM sr_sessions s JOIN sr_users u ON u.id = s.user_id WHERE s.expires_at > now() AND u.active`);
  SESSIONS.clear();
  for (const x of r.rows) SESSIONS.set(x.token, { name: x.name, role: x.role, user_id: x.id, exp: new Date(x.expires_at).getTime() });
  await db(`DELETE FROM sr_sessions WHERE expires_at < now()`);
}
function dropSessions(userId) { for (const [t, s] of SESSIONS) if (s.user_id === Number(userId)) SESSIONS.delete(t); return db(`DELETE FROM sr_sessions WHERE user_id=$1`, [userId]); }
const FAILS = new Map(); // ip -> [timestamps] — slow down password guessing
function tooMany(ip) { const now = Date.now(); const a = (FAILS.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000); FAILS.set(ip, a); return a.length >= 10; }
app.post("/api/login", async (req, res) => {
  try {
    const ip = req.get("x-forwarded-for") || req.ip || "";
    if (tooMany(ip)) return res.status(429).json({ error: "Too many tries. Wait 15 minutes and try again." });
    const username = String((req.body && req.body.username) || "").trim(), password = String((req.body && req.body.password) || "");
    if (!username) return res.status(400).json({ error: "Enter your username." });
    const u = (await db(`SELECT * FROM sr_users WHERE lower(username)=lower($1)`, [username])).rows[0];
    if (u) {
      if (u.active && checkPassword(password, u.pass_salt, u.pass_hash)) {
        const token = crypto.randomBytes(32).toString("hex"), exp = Date.now() + SESSION_DAYS * 864e5;
        await db(`INSERT INTO sr_sessions (token,user_id,expires_at) VALUES ($1,$2,$3)`, [token, u.id, new Date(exp)]);
        await db(`UPDATE sr_users SET last_login=now() WHERE id=$1`, [u.id]);
        SESSIONS.set(token, { name: u.name, role: u.role, user_id: u.id, exp });
        return res.json({ ok: true, key: token, user: u.name, role: u.role });
      }
      FAILS.get(ip).push(Date.now());
      return res.status(401).json({ error: u.active ? "Wrong username or password." : "This account is turned off. Ask an admin." });
    }
    // Built-in logins (STOCKROOM_USERS): the username itself — or "Name" + its secret as the password — is the key.
    // Same forgiving match as the old one-box sign-in: case doesn't matter, and the secret can go in either box.
    const lc = (v) => String(v || "").trim().toLowerCase();
    const live = USERS.filter((x) => !retired(x));
    const env = live.find((x) => lc(x.key) === lc(username)) || (password && live.find((x) => lc(x.key) === lc(password) && (lc(x.name) === lc(username) || !username)));
    if (env) { const w = whoFromKey(env.key); return res.json({ ok: true, key: env.key, user: w.name, role: w.role }); }
    if (ACCESS_KEY && (username === ACCESS_KEY || password === ACCESS_KEY)) return res.json({ ok: true, key: ACCESS_KEY, user: "admin", role: "admin" });
    FAILS.get(ip).push(Date.now());
    res.status(401).json({ error: /@/.test(username) ? "Use your Stockroom username, not an email address." : "Wrong username or password. Built-in logins: type the same thing you always typed into Username and leave Password blank." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/logout", async (req, res) => {
  const k = keyFrom(req); if (SESSIONS.has(k)) { SESSIONS.delete(k); await db(`DELETE FROM sr_sessions WHERE token=$1`, [k]).catch(() => {}); }
  res.json({ ok: true });
});
// Change your own password (app accounts only).
app.post("/api/me/password", async (req, res) => {
  const w = whoFromKey(keyFrom(req)); if (!w) return res.status(401).json({ error: "unauthorized" });
  try {
    if (!w.user_id) return res.status(400).json({ error: "Built-in logins don't have a password here. Ask an admin to create you an account." });
    const { current, next } = req.body || {};
    const u = (await db(`SELECT * FROM sr_users WHERE id=$1`, [w.user_id])).rows[0];
    if (!u || !checkPassword(current || "", u.pass_salt, u.pass_hash)) return res.status(400).json({ error: "Current password is wrong." });
    if (String(next || "").length < 6) return res.status(400).json({ error: "New password must be at least 6 characters." });
    const h = hashPassword(next); await db(`UPDATE sr_users SET pass_salt=$2, pass_hash=$3 WHERE id=$1`, [u.id, h.salt, h.hash]);
    const keep = keyFrom(req); for (const [t, s] of SESSIONS) if (s.user_id === u.id && t !== keep) SESSIONS.delete(t);
    await db(`DELETE FROM sr_sessions WHERE user_id=$1 AND token<>$2`, [u.id, keep]);
    await db(`INSERT INTO sr_user_log (who,target,detail) VALUES ($1,$2,'changed own password')`, [w.name, u.username]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- Admin portal: users ---- */
function adminGuard(req, res) { const w = whoFromKey(keyFrom(req)); if (!w) { res.status(401).json({ error: "unauthorized" }); return null; } if (w.role !== "admin") { res.status(403).json({ error: "Admins only." }); return null; } return w; }
const ROLE = (r) => (r === "admin" ? "admin" : "staff");
const USERNAME_RE = /^[A-Za-z0-9._-]{2,32}$/;
app.get("/api/admin/users", async (req, res) => {
  if (!adminGuard(req, res)) return;
  try {
    const users = (await db(`SELECT id,name,username,role,active,created_by,created_at,last_login FROM sr_users ORDER BY active DESC, lower(name)`)).rows;
    const builtin = USERS.map((u) => ({ name: u.name, role: ENV_ADMINS.includes(u.name.toLowerCase()) ? "admin" : "staff", replaced: retired(u) }));
    const log = (await db(`SELECT who,target,detail,ts FROM sr_user_log ORDER BY ts DESC LIMIT 30`)).rows;
    res.json({ users, builtin, log });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/admin/users", async (req, res) => {
  const w = adminGuard(req, res); if (!w) return;
  try {
    const name = String((req.body && req.body.name) || "").trim(), username = String((req.body && req.body.username) || "").trim(), password = String((req.body && req.body.password) || "");
    if (!name) return res.status(400).json({ error: "Enter a name." });
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: "Username: 2–32 letters, numbers, dots, dashes or underscores. No spaces." });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
    if ((await db(`SELECT 1 FROM sr_users WHERE lower(username)=lower($1)`, [username])).rows.length) return res.status(400).json({ error: `Username "${username}" is taken.` });
    const h = hashPassword(password);
    try {
      const r = await db(`INSERT INTO sr_users (name,username,pass_salt,pass_hash,role,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,username,role,active,created_at`, [name, username, h.salt, h.hash, ROLE(req.body.role), w.name]);
      const took = USERS.find((u) => u.name.toLowerCase() === username.toLowerCase() || u.key.toLowerCase() === username.toLowerCase());
      TAKEN.add(username.toLowerCase());
      await db(`INSERT INTO sr_user_log (who,target,detail) VALUES ($1,$2,$3)`, [w.name, username, `created as ${ROLE(req.body.role)}${took ? ` — replaces built-in login ${took.name}` : ""}`]);
      res.json({ ok: true, user: r.rows[0] });
    } catch (e) { if (/unique/i.test(e.message)) return res.status(400).json({ error: `Username "${username}" is taken.` }); throw e; }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/admin/users/:id", async (req, res) => {
  const w = adminGuard(req, res); if (!w) return;
  try {
    const id = Number(req.params.id);
    const u = (await db(`SELECT * FROM sr_users WHERE id=$1`, [id])).rows[0]; if (!u) return res.status(404).json({ error: "User not found." });
    const b = req.body || {}, changes = [];
    if (w.user_id === id && (b.active === false || (b.role && ROLE(b.role) !== "admin"))) return res.status(400).json({ error: "You can't turn off or demote your own account." });
    if (b.name != null) { const n = String(b.name).trim(); if (!n) return res.status(400).json({ error: "Enter a name." }); await db(`UPDATE sr_users SET name=$2 WHERE id=$1`, [id, n]); changes.push(`name → ${n}`); }
    if (b.role != null) { await db(`UPDATE sr_users SET role=$2 WHERE id=$1`, [id, ROLE(b.role)]); changes.push(`role → ${ROLE(b.role)}`); }
    if (b.password != null) { if (String(b.password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." }); const h = hashPassword(b.password); await db(`UPDATE sr_users SET pass_salt=$2, pass_hash=$3 WHERE id=$1`, [id, h.salt, h.hash]); await dropSessions(id); changes.push("password reset"); }
    if (b.active != null) { await db(`UPDATE sr_users SET active=$2 WHERE id=$1`, [id, !!b.active]); if (!b.active) await dropSessions(id); changes.push(b.active ? "turned on" : "turned off"); }
    for (const [, s] of SESSIONS) if (s.user_id === id) { if (b.name != null) s.name = String(b.name).trim(); if (b.role != null) s.role = ROLE(b.role); }
    if (changes.length) await db(`INSERT INTO sr_user_log (who,target,detail) VALUES ($1,$2,$3)`, [w.name, u.username, changes.join(", ")]);
    res.json({ ok: true, user: (await db(`SELECT id,name,username,role,active,created_at,last_login FROM sr_users WHERE id=$1`, [id])).rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
      ...stockSummary(matches),
      current_bin: currentBin, location_updated_at: loc?.updated_at || null, location_updated_by: loc?.updated_by || null,
      overstock: await overstockFor(sku),
      history: await getHistory(sku, 50),
      verification: await lastVerification(sku),
      activity: await getActivity(sku, 50),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Bin contents.
app.get("/api/bin/:code", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const b = await db(`SELECT code,label FROM bins WHERE lower(code)=lower($1) OR bin_key(code)=bin_key($1) ORDER BY (lower(code)=lower($1)) DESC LIMIT 1`, [req.params.code]);
    const items = await binItems(req.params.code);
    res.json({ bin: b.rows[0]?.code || req.params.code, label: b.rows[0]?.label || null, items, archived: items.length ? null : await isArchived(req.params.code) });
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
// Bin swap — move everything in one bin to another (E-17 → R-35). Bins match however they were typed
// (E-17 = E17 = E-017); each item keeps its other bins; the old bin can be dropped from the bin list.
async function houseCode(raw) {
  const r = (await db(`SELECT bin_key($1) AS k, bin_canon($1) AS c`, [String(raw || "").replace(/^BIN[-:]/i, "")])).rows[0];
  if (!r || !r.c) return null;
  return { code: binShape(r.k, r.c, null).code, key: r.k };
}
async function binSkus(key) {
  return (await db(`SELECT il.sku, il.bin, il.title FROM item_location il
                     WHERE il.bin IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(regexp_split_to_array(il.bin, '[,;/|]')) x WHERE trim(x) <> '' AND bin_key(x) = $1)
                     ORDER BY il.sku`, [key])).rows;
}
// Rebinning start (a date, Central time). Anything put into a bin number on/after it is the NEW bin with that number;
// a swap only moves what was in the OLD bin and leaves the new bin's items where they are.
async function rebinSince() {
  const v = ((await db(`SELECT value FROM sr_settings WHERE key='rebin_since'`)).rows[0] || {}).value;
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`); return { date: v, at: new Date(d.getTime() - tzOffsetMin(d, "America/Chicago") * 60000) };
}
async function swapPlan(fromRaw, toRaw) {
  const rb = await rebinSince();
  const from = await houseCode(fromRaw), to = toRaw ? await houseCode(toRaw) : null;
  if (!from) throw new Error("Enter the bin to empty.");
  const rows = await binSkus(from.key);
  const skus = rows.map((r) => r.sku);
  const q = skus.length ? (await db(`SELECT sku, max(title) AS title, max(variant) AS variant,
       SUM(GREATEST(on_hand,0)) FILTER (WHERE upper(coalesce(status,''))='ACTIVE')::int AS act, SUM(GREATEST(on_hand,0))::int AS allq, bool_or(upper(coalesce(status,''))='ACTIVE') AS has_active
       FROM stock_items WHERE sku = ANY($1) GROUP BY sku`, [skus])).rows : [];
  const qs = Object.fromEntries(q.map((x) => [x.sku, x]));
  const toRows = to ? await binSkus(to.key) : [];
  const keysOf = async (bin) => (await db(`SELECT trim(x) AS t, bin_key(x) AS k FROM unnest(regexp_split_to_array($1, '[,;/|]')) x WHERE trim(x) <> ''`, [bin])).rows;
  // When each item was last put into this bin number, and by whom — tells an old bin's stock from a new bin
  // that reuses the same number (old F-25 vs new F-25).
  const since = skus.length ? Object.fromEntries((await db(`SELECT DISTINCT ON (h.sku) h.sku, h.ts, h.user_name, h.source FROM location_history h
      WHERE h.sku = ANY($1)
        AND EXISTS (SELECT 1 FROM unnest(regexp_split_to_array(coalesce(h.to_bin,''), '[,;/|]')) x WHERE trim(x) <> '' AND bin_key(x) = $2)
        AND NOT EXISTS (SELECT 1 FROM unnest(regexp_split_to_array(coalesce(h.from_bin,''), '[,;/|]')) x WHERE trim(x) <> '' AND bin_key(x) = $2)
      ORDER BY h.sku, h.ts DESC`, [skus, from.key])).rows.map((x) => [x.sku, x])) : {};
  const items = [];
  for (const r of rows) {
    const toks = await keysOf(r.bin);
    const others = toks.filter((t) => t.k !== from.key).map((t) => t.t);
    let next = toks.map((t) => (t.k === from.key ? (to ? to.code : null) : t.t)).filter(Boolean);
    const seen = new Set(); next = next.filter((t) => { const k = t.toUpperCase().replace(/[\s-]/g, ""); if (seen.has(k)) return false; seen.add(k); return true; });
    const x = qs[r.sku] || {};
    items.push({ sku: r.sku, title: x.title || r.title, variant: x.variant || null, qty: x.has_active ? x.act : (x.allq ?? null), inactive: x.sku ? !x.has_active : false,
      bin: r.bin, other_bins: others, next: next.join(", "), already_in_to: !!(to && toks.some((t) => t.k === to.key)),
      since: since[r.sku] ? since[r.sku].ts : null, since_by: since[r.sku] ? (since[r.sku].source === "import" ? "ShipStation" : since[r.sku].user_name) : null,
      new_bin: !!(rb && since[r.sku] && new Date(since[r.sku].ts) >= rb.at) });
  }
  const listed = (await db(`SELECT 1 FROM bins WHERE bin_key(code) = $1`, [from.key])).rows.length > 0;
  const arch = (await db(`SELECT archived_by, archived_at FROM bin_archive WHERE key = $1`, [from.key])).rows[0] || null;
  return { from: from.code, from_key: from.key, to: to ? to.code : null, to_key: to ? to.key : null, same: !!(to && to.key === from.key), items, to_count: toRows.length, from_listed: listed, from_archived: arch, rebin_since: rb ? rb.date : null,
    moving: items.filter((i) => !i.new_bin).length, staying: items.filter((i) => i.new_bin).length };
}
app.get("/api/bins/swap", async (req, res) => {
  if (!guard(req, res)) return;
  try { res.json(await swapPlan(req.query.from, req.query.to)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// One swap: move everything from → to; optionally archive the emptied bin.
// skus (optional): move only these items — the rest stay, and the bin isn't archived while it still holds them.
async function doSwap({ from, to, removeFrom, by, skus }) {
  const plan = await swapPlan(from, to);
  if (Array.isArray(skus)) { const pick = new Set(skus.map(String)); plan.items = plan.items.filter((i) => pick.has(String(i.sku))); }
  else plan.items = plan.items.filter((i) => !i.new_bin);       // only the old bin's items move; the new bin's stay
  if (!plan.to && plan.items.length) { const e = new Error("Enter the bin to move everything into."); e.status = 400; throw e; }
  const staying = plan.staying || 0;
  if (plan.same) { const e = new Error("That's the same bin."); e.status = 400; throw e; }
  const note = plan.to ? `Bin swap ${plan.from} → ${plan.to}` : `Removed bin ${plan.from}`;
  let moved = 0; const failed = [];
  for (const it of plan.items) {
    try { await moveItem({ sku: it.sku, toBin: it.next, user: by, source: "swap", note, batch: true }); moved++; }
    catch (e) { failed.push({ sku: it.sku, error: e.message }); }
  }
  if (plan.to) { await registerBinTokens(plan.to); await unarchiveTokens(plan.to, by); }
  let removed = false;
  if (removeFrom && !failed.length && !(await binSkus(plan.from_key)).length) {
    await archiveBin(plan.from_key, plan.from, by, 0); removed = true;      // archived (hidden, can be restored)
  }
  return { ok: true, from: plan.from, to: plan.to, moved, failed, removed, left: staying };
}
app.post("/api/bins/swap", async (req, res) => {
  if (!guard(req, res)) return;
  try { const { from, to, removeFrom, skus } = req.body || {}; res.json({ ...(await doSwap({ from, to, removeFrom, skus, by: actorOf(req) })), shipstation_pending: SSQ.size }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Up to 12 swaps in one go (E-17 → R-35, E-18 → R-36 …). Checked first so a bin can't be both emptied and filled.
app.post("/api/bins/swap-many", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const pairs = ((req.body && req.body.pairs) || []).filter((p) => p && String(p.from || "").trim());
    if (!pairs.length) return res.status(400).json({ error: "Add at least one bin." });
    if (pairs.length > 12) return res.status(400).json({ error: "Up to 12 bins at a time." });
    const keyed = [];
    for (const p of pairs) {
      const f = await houseCode(p.from), t = p.to ? await houseCode(p.to) : null;
      if (!f) return res.status(400).json({ error: `"${p.from}" isn't a bin code.` });
      keyed.push({ from: f, to: t });
    }
    const fromKeys = keyed.map((k) => k.from.key), toKeys = keyed.filter((k) => k.to).map((k) => k.to.key);
    const dupe = fromKeys.find((k, i) => fromKeys.indexOf(k) !== i);
    if (dupe) return res.status(400).json({ error: `${keyed.find((k) => k.from.key === dupe).from.code} is listed twice.` });
    const both = toKeys.find((k) => fromKeys.includes(k));
    if (both) return res.status(400).json({ error: `${keyed.find((k) => k.from.key === both).from.code} is being emptied and filled in the same run — do it in two runs.` });
    const by = actorOf(req), results = [];
    for (const p of pairs) {
      try { results.push(await doSwap({ from: p.from, to: p.to, removeFrom: !!req.body.removeFrom, by })); }
      catch (e) { results.push({ ok: false, from: String(p.from).toUpperCase(), to: p.to ? String(p.to).toUpperCase() : null, error: e.message, moved: 0, failed: [] }); }
    }
    res.json({ ok: true, results, moved: results.reduce((n, r) => n + (r.moved || 0), 0), shipstation_pending: SSQ.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
async function archiveBin(key, code, by, cleared) {
  await db(`INSERT INTO bin_archive (key,code,archived_by,archived_at,items_cleared) VALUES ($1,$2,$3,now(),$4)
            ON CONFLICT (key) DO UPDATE SET code=EXCLUDED.code, archived_by=EXCLUDED.archived_by, archived_at=now(), items_cleared=EXCLUDED.items_cleared`, [key, code, by, cleared || 0]);
}
// Archive a bin. clearItems=true also takes the bin off every item still in it (they keep their other bins).
app.post("/api/bins/archive", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { bin, clearItems } = req.body || {};
    const plan = await swapPlan(bin, null);
    const by = actorOf(req);
    let cleared = 0; const failed = [];
    if (plan.items.length) {
      if (!clearItems) return res.status(400).json({ error: `${plan.from} still holds ${plan.items.length} item${plan.items.length === 1 ? "" : "s"}. Move them first, or tick "also take it off those items".`, items: plan.items.length });
      for (const it of plan.items) {
        try { await moveItem({ sku: it.sku, toBin: it.next, user: by, source: "archive", note: `Bin ${plan.from} archived`, batch: true }); cleared++; }
        catch (e) { failed.push({ sku: it.sku, error: e.message }); }
      }
    }
    await archiveBin(plan.from_key, plan.from, by, cleared);
    res.json({ ok: true, bin: plan.from, cleared, failed, shipstation_pending: SSQ.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/bins/unarchive", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const r = await db(`DELETE FROM bin_archive WHERE key = bin_key($1) RETURNING code`, [String((req.body && req.body.bin) || "").replace(/^BIN[-:]/i, "")]);
    res.json({ ok: true, restored: r.rowCount > 0, bin: r.rows[0] ? r.rows[0].code : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/bins/archived", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    await pruneArchive();
    const q = String(req.query.q || "").trim();
    const r = await db(`SELECT a.code, a.archived_by, a.archived_at, a.items_cleared,
          (SELECT count(*)::int FROM item_location il WHERE il.bin IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(regexp_split_to_array(il.bin, '[,;/|]')) x WHERE trim(x) <> '' AND bin_key(x) = a.key)) AS items
        FROM bin_archive a ${q ? "WHERE a.code ILIKE '%'||$1||'%' OR a.key = bin_key($1)" : ""} ORDER BY a.archived_at DESC LIMIT 300`, q ? [q] : []);
    const n = (await db(`SELECT count(*)::int AS n FROM bin_archive`)).rows[0].n;
    res.json({ bins: r.rows, total: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/settings/rebin", async (req, res) => { if (!guard(req, res)) return; try { const r = await rebinSince(); res.json({ date: r ? r.date : null }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/settings/rebin", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const v = String((req.body && req.body.date) || "").trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return res.status(400).json({ error: "Pick a date." });
    await db(`INSERT INTO sr_settings (key,value,updated_by,updated_at) VALUES ('rebin_since',$1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [v || null, actorOf(req)]);
    res.json({ ok: true, date: v || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/shipstation-queue", (req, res) => { if (!guard(req, res)) return; res.json({ pending: SSQ.size, running: ssqRunning, done: ssqDone, failed: ssqFailed.slice(-10) }); });
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
    await pruneArchive();
    const r = await db(`
      WITH toks AS (
        SELECT trim(lower(x)) AS code FROM item_location, unnest(regexp_split_to_array(bin, '[,;/|]')) AS x
        WHERE bin IS NOT NULL AND bin <> ''
      ), counts AS (
        SELECT code, COUNT(*)::int AS items FROM toks WHERE code <> '' GROUP BY code
      )
      SELECT b.code, b.label, COALESCE(c.items, 0) AS items
      FROM bins b LEFT JOIN counts c ON lower(b.code) = c.code
      WHERE NOT EXISTS (SELECT 1 FROM bin_archive a WHERE a.key = bin_key(b.code))
      ORDER BY b.code`);
    res.json({ bins: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Bin fill report — every bin with the items in it and their on-hand quantity (active listings, summed across stores,
// same rule as the product view). Used to find near-empty bins and plan consolidation (e.g. 36 shelving units → 24).
// Which side of the number each warehouse location is written on. Anything else is an old / phased-out location.
const LOC_BEFORE = ["Q", "S", "R", "D", "E", "A", "C", "F", "G", "I", "J", "RS"];
const LOC_AFTER = ["T", "L", "B", "U", "UW"];
// Current locations whose side is taken from how their bins are actually written (majority wins).
const LOC_AUTO = ["H"];
const LOC_ALL = [...LOC_BEFORE, ...LOC_AFTER, ...LOC_AUTO];
function binShape(key, fallback, sides) {
  const m = String(key).match(/^([A-Z]+)\|(\d+)$/);
  if (!m) return { code: fallback || key, loc: null, num: null, known: false };
  const [, loc, num] = m;
  const v = (sides && sides[loc]) || { before: 0, after: 0 };
  const after = LOC_AFTER.includes(loc) || (!LOC_BEFORE.includes(loc) && v.after > v.before);
  return { code: after ? `${num}-${loc}` : `${loc}-${num}`, loc, num: Number(num), known: LOC_ALL.includes(loc) };
}
// How each location is written on a label: letters first (R-35) or last (35-T). Auto locations go by their bins.
app.get("/api/bins/formats", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const auto = {};
    for (const l of LOC_AUTO) {
      const r = await db(`SELECT count(*) FILTER (WHERE c ~ ('^' || $1 || '-[0-9]+$'))::int AS before, count(*) FILTER (WHERE c ~ ('^[0-9]+-' || $1 || '$'))::int AS after
                            FROM (SELECT bin_canon(code) AS c FROM bins UNION ALL SELECT bin_canon(x) FROM item_location, unnest(regexp_split_to_array(bin, '[,;/|]')) x WHERE bin IS NOT NULL) t`, [l]);
      auto[l] = r.rows[0].after > r.rows[0].before ? "after" : "before";
    }
    res.json({ before: LOC_BEFORE, after: LOC_AFTER, auto });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Add many bins at once (label printing). Existing ones are left as they are.
app.post("/api/bins/batch", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const codes = [...new Set(((req.body && req.body.codes) || []).map((c) => String(c).trim().toUpperCase()).filter((c) => /^[A-Z0-9-]{1,20}$/.test(c)))].slice(0, 500);
    let added = 0;
    let restored = 0;
    for (const c of codes) {
      const r = await db(`INSERT INTO bins (code,label) SELECT $1,$1 WHERE NOT EXISTS (SELECT 1 FROM bins WHERE bin_key(code)=bin_key($1))`, [c]); added += r.rowCount;
      restored += (await db(`DELETE FROM bin_archive WHERE key = bin_key($1)`, [c])).rowCount;     // labeling a bin = it's in use
    }
    res.json({ ok: true, added, restored, total: codes.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/bins/report", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const r = await db(`
      WITH toks AS (
        SELECT il.sku, il.title AS loc_title, bin_canon(x) AS code_raw, bin_key(x) AS code
          FROM item_location il, unnest(regexp_split_to_array(il.bin, '[,;/|]')) AS x
         WHERE il.bin IS NOT NULL AND il.bin <> '' AND trim(x) <> ''
      ), nb AS (SELECT sku, COUNT(DISTINCT code)::int AS nbins FROM toks WHERE code <> '' GROUP BY sku
      ), q AS (
        SELECT sku,
               SUM(GREATEST(on_hand,0)) FILTER (WHERE upper(coalesce(status,''))='ACTIVE')::int AS act_qty,
               SUM(GREATEST(on_hand,0))::int AS all_qty,
               bool_or(upper(coalesce(status,''))='ACTIVE') AS has_active,
               bool_or(on_hand IS NOT NULL) AS known,
               max(title) AS title, max(variant) AS variant,
               string_agg(DISTINCT brand, ',') AS brands
          FROM stock_items GROUP BY sku
      )
      SELECT t.code, t.code_raw, t.sku, COALESCE(q.title, t.loc_title) AS title, q.variant, q.brands,
             CASE WHEN q.sku IS NULL OR NOT q.known THEN NULL WHEN q.has_active THEN q.act_qty ELSE q.all_qty END AS qty,
             (q.has_active IS NOT TRUE AND q.sku IS NOT NULL) AS inactive, nb.nbins, sv.verified_at
        FROM toks t LEFT JOIN q ON q.sku = t.sku LEFT JOIN nb ON nb.sku = t.sku LEFT JOIN stock_verifications sv ON sv.sku = t.sku
       WHERE t.code <> ''`);
    const bins = {};
    const binRows = (await db(`SELECT bin_key(code) AS k, bin_canon(code) AS c, label, code AS raw FROM bins`)).rows;
    // How each location is usually written (letters first or last) — decides the side for LOC_AUTO locations.
    const sides = {};
    for (const c of [...binRows.map((b) => b.c), ...r.rows.map((x) => x.code_raw)]) {
      const m1 = String(c || "").match(/^([A-Z]+)-\d+$/), m2 = String(c || "").match(/^\d+-([A-Z]+)$/);
      const l = m1 ? m1[1] : m2 ? m2[1] : null; if (!l) continue;
      (sides[l] = sides[l] || { before: 0, after: 0 })[m1 ? "before" : "after"]++;
    }
    // One bin per location + number, written the house way (R-35, 35-T), however it was typed.
    for (const b of binRows) { if (!b.k) continue; if (!bins[b.k]) bins[b.k] = { ...binShape(b.k, b.c, sides), label: b.label && b.label !== b.raw ? b.label : null, items: [] }; }
    const seen = new Set();
    for (const x of r.rows) {
      const k = x.code; if (seen.has(k + "|" + x.sku)) continue; seen.add(k + "|" + x.sku);
      if (!bins[k]) bins[k] = { ...binShape(k, x.code_raw, sides), label: null, items: [], unlisted: true };
      bins[k].items.push({ sku: x.sku, title: x.title, variant: x.variant, brands: x.brands, qty: x.qty, inactive: !!x.inactive, shared: (x.nbins || 1) > 1, verified_at: x.verified_at });
    }
    await pruneArchive();
    const archived = new Set((await db(`SELECT key FROM bin_archive`)).rows.map((x) => x.key));
    for (const k of Object.keys(bins)) if (archived.has(k)) delete bins[k];
    const out = Object.values(bins).map((b) => {
      b.items.sort((a, c) => (a.qty ?? -1) - (c.qty ?? -1) || String(a.sku).localeCompare(String(c.sku)));
      return { ...b, skus: b.items.length, units: b.items.reduce((s, i) => s + (Number(i.qty) || 0), 0), unknown: b.items.filter((i) => i.qty == null).length, zero: b.items.filter((i) => i.qty === 0).length };
    });
    out.sort((a, b) => a.units - b.units || a.skus - b.skus || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
    res.json({ bins: out, locations: [...LOC_ALL].sort(), synced: (invSync && invSync.at) || null, archived: archived.size });
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
    const restored = (await db(`DELETE FROM bin_archive WHERE key = bin_key($1)`, [code])).rowCount > 0;
    res.json({ ok: true, code, label: label || code, restored });
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
    const verBySku = await verificationMap(skus);
    rows = rows.map((r) => ({ ...r, bin: r.sku ? (binBySku[r.sku] || null) : null, overstock_box: r.sku ? (osBySku[r.sku] || null) : null,
      verified_at: r.sku && verBySku[r.sku] ? verBySku[r.sku].verified_at : null, verified_by: r.sku && verBySku[r.sku] ? verBySku[r.sku].verified_by : null }));
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
    const act = activeOnly(items);
    const system = act.length ? act.reduce((m, r) => (r.on_hand != null ? Math.max(m, r.on_hand) : m), 0) : null;
    res.json({ sku, title: items[0]?.title || null, bin, brands: items.map((r) => ({ ...r, active: isActive(r.status) })), system_qty: act.length ? system : null, last, history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Record a physical count (who/when) and correct Shopify on-hand to it when it differs.
// Shared by /api/stock/verify and the low-stock path of /api/stock/putback. Returns the result object.
// meta (optional) = { reason, detail, shopReason } — overrides how the correction is labelled in the activity log.
async function doVerify(sku, cnt, by, note, meta) {
  const items = activeOnly((await db(`SELECT brand,on_hand,status FROM stock_items WHERE sku=$1`, [sku])).rows);
  const system = items.length ? items.reduce((m, r) => (r.on_hand != null ? Math.max(m, r.on_hand) : m), 0) : null;
  const matched = system != null && cnt === system;
  let correction = null, correctionNote = null;
  if (system == null || cnt !== system) {
    correction = await shopifySetOnHand(sku, cnt, {
      reason: (meta && meta.reason) || "Stock verification",
      detail: (meta && meta.detail) || `shelf count ${cnt}`,
      shopReason: (meta && meta.shopReason) || "correction",
      user: by,
    });
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
    const items = activeOnly((await db(`SELECT brand,title,on_hand,status FROM stock_items WHERE sku=$1`, [sku])).rows);
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

/* ---- Adjust quantity (from the product view) ---- */
// Live Shopify on-hand + last verification, for the adjust screen.
app.get("/api/stock/live/:sku", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const sku = req.params.sku;
    const brands = await liveOnHand(sku);
    const vals = activeOnly(brands).map((b) => b.on_hand).filter((v) => v != null);
    res.json({ sku, title: brands.find((b) => b.title)?.title || null, brands, on_hand: vals.length ? Math.max(...vals) : null,
      verification: await lastVerification(sku), reasons: Object.keys(ADJUST_REASONS) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Set a new on-hand quantity with a reason. counted=true also records it as a stock verification.
app.post("/api/stock/adjust", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { sku, qty, reason, note, counted } = req.body || {};
    if (!sku) return res.status(400).json({ error: "sku required" });
    const target = Number(qty);
    if (qty === "" || qty == null || !Number.isInteger(target) || target < 0) return res.status(400).json({ error: "quantity must be a whole number, 0 or more" });
    const why = String(reason || "").trim();
    if (!why) return res.status(400).json({ error: "pick a reason" });
    const by = actorOf(req);
    const rows = await ensureStockItem(sku);
    if (!rows.length) return res.status(404).json({ error: "this SKU isn't in Shopify" });
    const detail = String(note || "").trim() || null;
    const shopReason = ADJUST_REASONS[why] || "correction";
    if (counted) {
      const v = await doVerify(sku, target, by, `adjust · ${why}${detail ? " · " + detail : ""}`, { reason: why, detail, shopReason });
      return res.json({ ok: true, sku, qty: target, verified: true, matched: v.matched, corrected: v.corrected, correction: v.correction, correction_note: v.correction_note });
    }
    const results = await shopifySetOnHand(sku, target, { reason: why, detail, shopReason, user: by, uri: "logistics://stockroom/adjustment" });
    const ok = results.filter((r) => r.ok), bad = results.filter((r) => !r.ok);
    if (!ok.length) return res.status(502).json({ error: bad.map((b) => `${b.brand}: ${b.error}`).join("; ") || "Shopify wasn't updated" });
    res.json({ ok: true, sku, qty: target, from: Math.max(...ok.map((r) => Number(r.from) || 0)), results, failed: bad });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- Quantity activity log ---- */
app.get("/api/activity/:sku", async (req, res) => {
  if (!guard(req, res)) return;
  try { res.json({ sku: req.params.sku, activity: await getActivity(req.params.sku, 200) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Recent activity across every SKU. ?drops=1 → only quantity drops; ?q= → SKU / name / order contains.
app.get("/api/activity", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const where = [], p = [];
    if (req.query.drops === "1") where.push(`a.change < 0`);
    const q = String(req.query.q || "").trim();
    if (q) { p.push(`%${q.toLowerCase()}%`); where.push(`(lower(a.sku) LIKE $${p.length} OR lower(coalesce(a.title,'')) LIKE $${p.length} OR lower(coalesce(a.detail,'')) LIKE $${p.length})`); }
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const r = await db(
      `SELECT a.id,a.sku,COALESCE(a.title,(SELECT si.title FROM stock_items si WHERE si.sku=a.sku LIMIT 1)) AS title,
              a.change,a.qty_before,a.qty_after,a.reason,a.detail,a.user_name,a.ts
         FROM stock_activity a ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY a.ts DESC, a.id DESC LIMIT ${limit}`, p);
    res.json({ activity: r.rows, shipments: shipPoll });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 8080;
(async () => {
  try { await migrate(); await loadSessions(); await pruneArchive(); await oneTimeFixes(); console.log(`🗄️  Postgres schema ready · ${SESSIONS.size} signed-in sessions`); }
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
    // Shipments → activity log. First run back-fills 14 days; after that every 10 min re-reads the last
    // 2 days (cheap, de-duplicated) so late voids are caught too.
    try {
      const had = (await db(`SELECT 1 FROM stock_activity WHERE ref LIKE 'ss-ship:%' LIMIT 1`)).rows.length;
      const days = had ? 2 : 14;
      console.log(`🚚 pulling ShipStation shipments (last ${days} days)…`);
      pollShipments(days).then((r) => console.log(`🚚 shipments: ${JSON.stringify(r)}`));
    } catch (e) { console.error("🚚 shipment pull setup failed:", e.message); }
    setInterval(() => { pollShipments(2).catch(() => {}); }, 10 * 60 * 1000);
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
