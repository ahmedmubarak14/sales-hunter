// Sales Hunter — Metabase sync
// Connection (base URL) + API key come from integration_config /
// integration_secrets (see supabase/migrations/013_integrations.sql),
// same as HubSpot. Card IDs are configured on the Integrations page:
//   card_subscriptions → "Sales Hunter Deals Details" — invoice-level:
//     purchasable name, VAT-excluded amount, commission amount, and the
//     deal owner's name/id, all joined by hubspot_deal_id in one card.
//   card_topstores → Top Zid Stores showcase card.
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

function periodOf(dateStr: unknown): string {
  return String(dateStr ?? "").slice(0, 7); // "2026-06-10" -> "2026-06"
}

function billingCycleOf(name: unknown): string | null {
  const s = String(name ?? "").toLowerCase();
  if (s.includes("year")) return "yearly";
  if (s.includes("month")) return "monthly";
  return null;
}

// One card carries invoice-level purchase data AND the deal-owner
// name/id, joined by hubspot_deal_id — feeds subscriptions + commissions
// and resolves deals.sales_owner (raw HubSpot owner IDs → real names,
// since the HubSpot token isn't scoped for crm.objects.owners.read) in
// a single pass.
async function syncDealDetails(base: string, key: string, cardId: string) {
  const rows = await runCard(base, key, cardId);
  let subs = 0, comms = 0;
  const ownerByDeal = new Map<string, string>();

  for (const r of rows) {
    const dealId = String(r["id"] ?? "");
    if (!dealId) continue;
    const storeId = r["Purchases - invoice → Store ID"];
    const purchasable = r["Purchases - invoice → Purchasable Name"];
    const vatExcluded = r["VAT Excluded"];
    const purchaseDate = r["Purchases - invoice → Purchase Date"];
    const hunterEmail = r["Hubspot Fact Deals - Deal → Lead Owner Email"];
    const commissionAmount = r["Commission Amount"];
    const ownerName = r["Zid Insights Deals Stages → Owner Name"];

    if (storeId != null) {
      const { error } = await supabase.from("subscriptions").upsert({
        store_id: String(storeId),
        hubspot_deal_id: dealId,
        package: purchasable ?? null,
        billing_cycle: billingCycleOf(purchasable),
        started_at: purchaseDate ?? null,
        amount_net: vatExcluded ?? null,
        synced_at: new Date().toISOString(),
      });
      if (error) throw error;
      subs++;
    }

    if (hunterEmail && commissionAmount != null) {
      const { error } = await supabase.from("commissions").upsert({
        hubspot_deal_id: dealId,
        hunter_email: String(hunterEmail).trim().toLowerCase(),
        period: periodOf(purchaseDate),
        base_amount: vatExcluded ?? null,
        commission_amount: commissionAmount,
        calculated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }, { onConflict: "hubspot_deal_id,hunter_email,period", ignoreDuplicates: false });
      if (error) throw error;
      comms++;
    }

    if (ownerName) ownerByDeal.set(dealId, String(ownerName));
  }

  let ownersResolved = 0;
  for (const [dealId, name] of ownerByDeal) {
    const { error } = await supabase.from("deals").update({ sales_owner: name }).eq("hubspot_deal_id", dealId);
    if (error) throw error;
    ownersResolved++;
  }

  if (comms) await supabase.rpc("rematch_commissions");
  return { subscriptions: subs, commissions: comms, owners_resolved: ownersResolved };
}

async function syncTopStores(base: string, key: string, cardId: string) {
  // The Top Stores card's columns (all-time Store ID / Name / Category /
  // Orders Total) don't line up with store_showcase's monthly-rank shape
  // (orders_month, growth, rank_in_category) yet — left as a read-only
  // probe until that mapping is designed, rather than guessing at ranks.
  const rows = await runCard(base, key, cardId);
  return rows.length;
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
      : { subscriptions: 0, commissions: 0, owners_resolved: 0 };
    const storesSeen = conn.settings.card_topstores
      ? await syncTopStores(conn.base, conn.key, conn.settings.card_topstores)
      : 0;

    await supabase.from("sync_state").upsert({ source: "metabase", last_run_at: started, last_status: "ok", last_error: null });
    await supabase.from("integration_config").update({ last_synced_at: started, last_status: "ok" }).eq("name", "metabase");
    return Response.json({ ok: true, ...details, top_stores_seen: storesSeen, mock: false });
  } catch (e) {
    await supabase.from("sync_state").upsert({
      source: "metabase", last_run_at: started, last_status: "error", last_error: String(e),
    });
    if (configured) {
      await supabase.from("integration_config").update({ last_synced_at: started, last_status: `error: ${String(e)}` }).eq("name", "metabase");
    }
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
