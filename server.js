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
async function moveItem({ sku, toBin, user, note, qtySeen, source }) {
  if (!sku) throw new Error("sku required");
  const cur = await getItemLocation(sku);
  const fromBin = cur ? cur.bin : null;
  // enrich title/barcode from Shopify (best-effort) so the DB row is self-describing
  let title = cur?.title || null, barcode = cur?.barcode || null;
  try { const f = (await shopifyFind({ sku }))[0]; if (f && !f.error) { title = f.title || title; barcode = f.barcode || barcode; } } catch {}
  await db(
    `INSERT INTO item_location (sku,bin,title,barcode,updated_at,updated_by) VALUES ($1,$2,$3,$4,now(),$5)
     ON CONFLICT (sku) DO UPDATE SET bin=$2, title=COALESCE($3,item_location.title), barcode=COALESCE($4,item_location.barcode), updated_at=now(), updated_by=$5`,
    [sku, toBin || null, title, barcode, user || null]
  );
  await db(
    `INSERT INTO location_history (sku,from_bin,to_bin,qty_seen,user_name,source,note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sku, fromBin, toBin || null, qtySeen ?? null, user || null, source || "scan", note || null]
  );
  // Register each bin token (locations can be compound, e.g. "1008-L, G-5").
  if (toBin) await registerBinTokens(toBin);
  // Push to ShipStation (best-effort — never block the local move on it).
  let shipstation = { pushed: false };
  if (ssConfigured()) {
    try { const r = await ssSetWarehouseLocation(sku, toBin || ""); shipstation = { pushed: true, ...r }; }
    catch (e) { shipstation = { pushed: false, error: e.message }; }
  }
  return { sku, from_bin: fromBin, to_bin: toBin || null, shipstation };
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
  } while (page <= pages);
  return { ok: true, scanned, with_location: withLoc, imported, updated };
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
      history: await getHistory(sku, 15),
    };
  }
  // 3) unknown — let the user assign it as a new SKU if they want.
  return { type: "unknown", code };
}

/* --------------------------------------- HTTP --------------------------------------- */
const app = express();
app.use(express.json({ limit: "1mb" }));
function keyFrom(req) { return req.query.key || req.get("x-stockroom-key") || (req.body && req.body.key) || ""; }
const authed = (req) => ACCESS_KEY && keyFrom(req) === ACCESS_KEY;
function guard(req, res) { if (!authed(req)) { res.status(401).json({ error: "unauthorized" }); return false; } return true; }

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, p) => { if (p.endsWith(".webmanifest")) res.set("Content-Type", "application/manifest+json"); if (p.endsWith("sw.js")) res.set("Cache-Control", "no-cache"); },
}));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/role", (req, res) => res.json({ ok: authed(req) }));

// Resolve any scanned/typed code.
app.get("/api/resolve", async (req, res) => {
  if (!guard(req, res)) return;
  try { res.json(await resolveCode(req.query.code)); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
    const { sku, toBin, user, note, qtySeen } = req.body || {};
    if (!sku) return res.status(400).json({ error: "sku required" });
    res.json(await moveItem({ sku, toBin, user, note, qtySeen, source: "scan" }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Bins registry.
app.get("/api/bins", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    // Count items whose location contains each bin as a comma-separated token (handles "1008-L, G-5").
    const r = await db(`SELECT b.code, b.label,
      (SELECT COUNT(*) FROM item_location il
        WHERE lower(b.code) = ANY(SELECT trim(lower(x)) FROM unnest(string_to_array(il.bin, ',')) x))::int AS items
      FROM bins b ORDER BY b.code`);
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
    rows = rows.map((r) => ({ ...r, bin: r.sku ? (binBySku[r.sku] || null) : null }));
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

const PORT = process.env.PORT || 8080;
(async () => {
  try { await migrate(); console.log("🗄️  Postgres schema ready"); }
  catch (e) { console.error("❌ DB migrate failed:", e.message); }
  app.listen(PORT, () => {
    console.log(`📦 Stockroom on :${PORT}`);
    console.log(`🔎 boot → key:${ACCESS_KEY ? "set" : "MISSING"} · db:${process.env.DATABASE_URL ? "set" : "MISSING"} · shopify:${STORES.length} stores · shipstation:${ssConfigured() ? "set" : "off"} · ver:${SHOP_VER}`);
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
  // First-run seeding: if we have no locations yet, import them from ShipStation in the background.
  try {
    const c = await db(`SELECT COUNT(*)::int AS n FROM item_location`);
    if (c.rows[0].n === 0 && ssConfigured()) {
      console.log("📥 item_location empty — importing existing bins from ShipStation…");
      syncFromShipStation().then((r) => console.log(`📥 ShipStation import done: ${JSON.stringify(r)}`)).catch((e) => console.error("📥 import failed:", e.message));
    } else { console.log(`📥 locations on hand: ${c.rows[0].n} (skipping auto-import)`); }
  } catch (e) { console.error("auto-import check failed:", e.message); }
})();
