// Sales Hunter — Metabase sync
// Connection (base URL) + API key come from integration_config /
// integration_secrets (see supabase/migrations/013_integrations.sql),
// same as HubSpot. Card IDs are configured on the Integrations page:
//   card_subscriptions → "Sales Hunter Deals Details" — invoice-level:
//     purchasable name, VAT-excluded amount, and commission amount,
//     joined by hubspot_deal_id.
//   card_topstores → Top Zid Stores showcase card (all-time orders per
//     store; ranked within each category, no per-category cap).
// Deal owner names are resolved separately (syncOwnerNames) via a native
// query against the warehouse table directly, covering every deal, not
// just the ones with a purchase.
// Runs in MOCK mode (no-op) until a Metabase connection has been saved.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

type MBSettings = {
  base_url?: string;
  card_subscriptions?: string;
  card_commissions?: string;
  card_topstores?: string;
};

async function loadConnection() {
  const { data: cfg } = await supabase
    .from("integration_config")
    .select("settings, secret_set")
    .eq("name", "metabase")
    .maybeSingle();
  if (!cfg?.secret_set) return { configured: false as const };
  const { data: key, error } = await supabase.rpc("get_integration_secret", { p_name: "metabase" });
  if (error || !key) throw new Error(`could not read saved Metabase key: ${error?.message ?? "empty"}`);
  const settings = (cfg.settings ?? {}) as MBSettings;
  let base = settings.base_url || "";
  try { base = new URL(base).origin; } catch { /* left as typed; request below will fail loudly */ }
  return { configured: true as const, key: key as string, base, settings };
}

async function runCard(base: string, key: string, cardId: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${base}/api/card/${cardId}/query/json`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Metabase card ${cardId}: HTTP ${res.status} — ${await res.text()}`);
  return await res.json();
}

// database 2 is this Metabase instance's "Data Warehouse" — fixed, not
// something the Integrations page needs to expose as a setting.
const WAREHOUSE_DB_ID = 2;

async function runNativeQuery(base: string, key: string, sql: string): Promise<unknown[][]> {
  const res = await fetch(`${base}/api/dataset`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ database: WAREHOUSE_DB_ID, type: "native", native: { query: sql } }),
  });
  if (!res.ok) throw new Error(`Metabase native query: HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  return body?.data?.rows ?? [];
}

function periodOf(dateStr: unknown): string {
  return String(dateStr ?? "").slice(0, 7); // "2026-06-10" -> "2026-06"
}

function billingCycleOf(name: unknown): string | null {
  const s = String(name ?? "").toLowerCase();
  if (s.includes("year")) return "yearly";
  if (s.includes("month")) return "monthly";
  return null;
}

// Bulk-patch existing deals with a subset of columns. Postgres validates
// NOT NULL constraints on the full proposed row before it even checks
// for a conflict, so a plain `.upsert()` with only {hubspot_deal_id,
// ...patch} fails on deals.stage (not null, no default) even though
// every one of these rows already exists and would just be an UPDATE —
// this pulls each row's current stage back in so the insert-side check
// passes.
async function patchDeals(rows: { hubspot_deal_id: string; [col: string]: unknown }[]) {
  if (!rows.length) return 0;
  const { data: existing, error: selErr } = await supabase.from("deals").select("hubspot_deal_id, stage");
  if (selErr) throw selErr;
  const stageOf = new Map((existing ?? []).map((r: { hubspot_deal_id: string; stage: string }) => [r.hubspot_deal_id, r.stage]));

  const patched = rows
    .filter((r) => stageOf.has(r.hubspot_deal_id))
    .map((r) => ({ ...r, stage: stageOf.get(r.hubspot_deal_id) }));

  const CHUNK = 500;
  for (let i = 0; i < patched.length; i += CHUNK) {
    const { error } = await supabase.from("deals").upsert(patched.slice(i, i + CHUNK));
    if (error) throw error;
  }
  return patched.length;
}

// One card carries invoice-level purchase data, joined by
// hubspot_deal_id — feeds subscriptions + commissions and overwrites
// deals.amount_net for any deal it covers. Metabase is the source of
// truth: its real invoiced, VAT-excluded amount replaces whatever
// HubSpot's deal-level amount property said. (Owner names are handled
// separately by syncOwnerNames — this card's owner data only covers
// deals with a purchase; the plain deals table needs every deal.)
// When sales merges duplicate deals in HubSpot the surviving record keeps
// a new id, but the warehouse still reports purchases under the id that
// was merged away — so those invoices matched no row in `deals` and their
// revenue and commission silently went unattributed. A GET by the old id
// follows the merge and reports the survivor's id, so ids we can't match
// locally get resolved that way (only the unmatched handful, not every
// deal). Returns old id -> canonical id.
async function resolveMergedDeals(unknownIds: string[]): Promise<Map<string, string>> {
  const remap = new Map<string, string>();
  if (!unknownIds.length) return remap;
  const { data: token } = await supabase.rpc("get_integration_secret", { p_name: "hubspot" });
  if (!token) return remap;
  for (const id of unknownIds) {
    try {
      const res = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${id}?properties=hs_object_id`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) continue;
      const canonical = String((await res.json())?.id ?? "");
      if (canonical && canonical !== id) remap.set(id, canonical);
    } catch { /* leave unmapped; a later run retries */ }
  }
  return remap;
}

async function syncDealDetails(base: string, key: string, cardId: string) {
  const rawRows = await runCard(base, key, cardId);
  const amountByDeal = new Map<string, { net: number; gross: number }>();

  const { data: dealRows } = await supabase.from("deals").select("hubspot_deal_id, hunter_email");
  const knownDeals = new Map((dealRows ?? []).map((r) => [r.hubspot_deal_id as string, r.hunter_email as string | null]));
  const unknownIds = [...new Set(rawRows
    .map((r) => String(r["id"] ?? ""))
    .filter((id) => id && !knownDeals.has(id)))];
  const remap = await resolveMergedDeals(unknownIds);

  const rows = rawRows.map((r) => {
    const id = String(r["id"] ?? "");
    return remap.has(id) ? { ...r, id: remap.get(id) } : r;
  });

  // The card is invoice-level: a store can buy more than once, so several
  // rows can share a store_id (subscriptions' primary key) or a
  // deal+hunter+period (commissions' unique key). Writing row-by-row made
  // the last invoice silently overwrite the earlier ones instead of adding
  // to them, under-reporting both revenue and commission. Fold the
  // invoices together first, then write one row per key.
  type SubAcc = { store_id: string; hubspot_deal_id: string; package: unknown; amount_net: number; amount_gross: number; started_at: unknown; top: number };
  type CommAcc = { hubspot_deal_id: string; hunter_email: string; period: string; base_amount: number; commission_amount: number };
  const subAcc = new Map<string, SubAcc>();
  const commAcc = new Map<string, CommAcc>();

  for (const r of rows) {
    const dealId = String(r["id"] ?? "");
    if (!dealId) continue;
    const storeId = r["Purchases - invoice → Store ID"];
    const purchasable = r["Purchases - invoice → Purchasable Name"];
    const vatExcluded = typeof r["VAT Excluded"] === "number" ? r["VAT Excluded"] as number : 0;
    // What the merchant actually paid, VAT included — taken from the
    // invoice rather than derived from the net figure, so discounted or
    // VAT-exempt purchases stay accurate.
    const amountPaid = typeof r["Purchases - invoice → Amount Paid"] === "number"
      ? r["Purchases - invoice → Amount Paid"] as number : 0;
    const purchaseDate = r["Purchases - invoice → Purchase Date"];
    // The card's own email column is blank on some rows (notably deals
    // that were merged); the deal record we already hold still knows who
    // owns it, so fall back to that rather than dropping the commission.
    const hunterEmail = r["Hubspot Fact Deals - Deal → Lead Owner Email"] || knownDeals.get(dealId) || null;
    const commissionAmount = r["Commission Amount"];

    if (storeId != null) {
      const skey = String(storeId);
      const prev = subAcc.get(skey);
      if (!prev) {
        subAcc.set(skey, {
          store_id: skey, hubspot_deal_id: dealId, package: purchasable ?? null,
          amount_net: vatExcluded, amount_gross: amountPaid,
          started_at: purchaseDate ?? null, top: vatExcluded,
        });
      } else {
        prev.amount_net += vatExcluded;
        prev.amount_gross += amountPaid;
        // The plan shown for a store is its biggest purchase, not whichever
        // invoice happened to be last in the card's row order.
        if (vatExcluded > prev.top) {
          prev.top = vatExcluded;
          prev.package = purchasable ?? null;
          prev.hubspot_deal_id = dealId;
          prev.started_at = purchaseDate ?? null;
        }
      }
    }

    if (hunterEmail && commissionAmount != null) {
      const email = String(hunterEmail).trim().toLowerCase();
      const period = periodOf(purchaseDate);
      const ckey = `${dealId}|${email}|${period}`;
      const prev = commAcc.get(ckey);
      if (!prev) {
        commAcc.set(ckey, {
          hubspot_deal_id: dealId, hunter_email: email, period,
          base_amount: vatExcluded, commission_amount: Number(commissionAmount),
        });
      } else {
        prev.base_amount += vatExcluded;
        prev.commission_amount += Number(commissionAmount);
      }
    }

    const acc = amountByDeal.get(dealId) ?? { net: 0, gross: 0 };
    acc.net += vatExcluded;
    acc.gross += amountPaid;
    amountByDeal.set(dealId, acc);
  }

  const now = new Date().toISOString();
  const subRows = Array.from(subAcc.values(), (s) => ({
    store_id: s.store_id, hubspot_deal_id: s.hubspot_deal_id,
    package: s.package, billing_cycle: billingCycleOf(s.package),
    started_at: s.started_at, amount_net: s.amount_net, amount_gross: s.amount_gross,
    synced_at: now,
  }));
  if (subRows.length) {
    const { error } = await supabase.from("subscriptions").upsert(subRows);
    if (error) throw error;
  }
  const commRows = Array.from(commAcc.values(), (c) => ({ ...c, calculated_at: now, synced_at: now }));
  if (commRows.length) {
    const { error } = await supabase.from("commissions")
      .upsert(commRows, { onConflict: "hubspot_deal_id,hunter_email,period", ignoreDuplicates: false });
    if (error) throw error;
  }
  const subs = subRows.length, comms = commRows.length;

  const amountRows = Array.from(amountByDeal, ([hubspot_deal_id, a]) => ({
    hubspot_deal_id, amount_net: a.net, amount_gross: a.gross,
  }));
  const dealsUpdated = await patchDeals(amountRows);

  if (comms) await supabase.rpc("rematch_commissions");
  return { subscriptions: subs, commissions: comms, deals_amount_updated: dealsUpdated };
}

// Deal owner names, for EVERY Sales Hunter deal, not just the ones with
// a purchase — pulled straight from the warehouse table the invoice card
// itself draws "Owner Name" from, so pipeline-stage deals get a real
// name too instead of a raw HubSpot owner ID (which the HubSpot token
// can't resolve — it isn't scoped for crm.objects.owners.read).
async function syncOwnerNames(base: string, key: string) {
  const rows = await runNativeQuery(
    base, key,
    "select deal_id, owner_name from platinum.zid_insights__deals_stages " +
    "where target_type = 'Sales Hunter' and owner_name is not null",
  );

  const ownerRows = rows.map(([dealId, ownerName]) => ({ hubspot_deal_id: String(dealId), sales_owner: String(ownerName) }));
  return await patchDeals(ownerRows);
}

// Ranked by all-time order count within each category, no per-category
// cap — every store the card returns gets a showcase row. Written as one
// batched upsert (not one round-trip per store) since this card returns
// hundreds of rows.
async function syncTopStores(base: string, key: string, cardId: string) {
  const rows = await runCard(base, key, cardId);
  const byCategory = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const category = String(r["Store Category Name"] ?? "");
    if (!category) continue;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push(r);
  }

  const now = new Date().toISOString();
  const showcaseRows: Record<string, unknown>[] = [];
  for (const [category, stores] of byCategory) {
    stores.sort((a, b) => Number(b["Orders Count"] ?? 0) - Number(a["Orders Count"] ?? 0));
    stores.forEach((r, i) => {
      const storeId = r["Store ID"];
      if (storeId == null) return;
      showcaseRows.push({
        store_id: String(storeId),
        name: r["Store Name"] ?? String(storeId),
        category,
        orders_count: r["Orders Count"] ?? null,
        orders_total_sar: r["Orders Total Sar"] ?? null,
        rank_in_category: i + 1,
        synced_at: now,
      });
    });
  }

  const CHUNK = 500;
  for (let i = 0; i < showcaseRows.length; i += CHUNK) {
    const { error } = await supabase.from("store_showcase").upsert(showcaseRows.slice(i, i + CHUNK));
    if (error) throw error;
  }
  return showcaseRows.length;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const anyE = e as Record<string, unknown>;
    return String(anyE.message ?? anyE.error ?? anyE.details ?? JSON.stringify(e));
  }
  return String(e);
}

Deno.serve(async () => {
  const started = new Date().toISOString();
  let configured = false;
  try {
    const conn = await loadConnection();
    configured = conn.configured;

    if (!conn.configured) {
      await supabase.from("sync_state").upsert({ source: "metabase", last_run_at: started, last_status: "ok", last_error: null });
      return Response.json({ ok: true, mock: true });
    }

    const details = conn.settings.card_subscriptions
      ? await syncDealDetails(conn.base, conn.key, conn.settings.card_subscriptions)
      : { subscriptions: 0, commissions: 0, deals_amount_updated: 0 };
    const ownersResolved = await syncOwnerNames(conn.base, conn.key);
    const storesSeen = conn.settings.card_topstores
      ? await syncTopStores(conn.base, conn.key, conn.settings.card_topstores)
      : 0;

    await supabase.from("sync_state").upsert({ source: "metabase", last_run_at: started, last_status: "ok", last_error: null });
    await supabase.from("integration_config").update({ last_synced_at: started, last_status: "ok" }).eq("name", "metabase");
    return Response.json({ ok: true, ...details, owners_resolved: ownersResolved, top_stores_seen: storesSeen, mock: false });
  } catch (e) {
    await supabase.from("sync_state").upsert({
      source: "metabase", last_run_at: started, last_status: "error", last_error: errMsg(e),
    });
    if (configured) {
      await supabase.from("integration_config").update({ last_synced_at: started, last_status: `error: ${errMsg(e)}` }).eq("name", "metabase");
    }
    return Response.json({ ok: false, error: errMsg(e) }, { status: 500 });
  }
});
