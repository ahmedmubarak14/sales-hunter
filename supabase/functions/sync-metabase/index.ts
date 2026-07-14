// Sales Hunter — Metabase sync (Q1 commissions, Q2 subscriptions, Q3 top stores)
// Schedule: hourly for Q1, daily for Q2/Q3 (Supabase Dashboard → Edge Functions → Schedules)
// Secrets required (Dashboard → Edge Functions → Secrets):
//   METABASE_URL   e.g. https://metabase.zid.sa
//   METABASE_KEY   Metabase API key
//   MB_CARD_COMMISSIONS / MB_CARD_SUBSCRIPTIONS / MB_CARD_TOPSTORES  (card IDs)
// Without secrets it runs in MOCK mode so the pipeline is testable end-to-end.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // service role: bypasses RLS for sync writes
);

const MB_URL = Deno.env.get("METABASE_URL");
const MB_KEY = Deno.env.get("METABASE_KEY");
const MOCK = !MB_URL || !MB_KEY;

async function runCard(cardId: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${MB_URL}/api/card/${cardId}/query/json`, {
    method: "POST",
    headers: { "x-api-key": MB_KEY!, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Metabase card ${cardId}: HTTP ${res.status}`);
  return await res.json();
}

async function syncCommissions() {
  const rows = MOCK
    ? [{ hubspot_deal_id: "MOCK-1", hunter_email: "ahmedmubaraks@hotmail.com", base_amount: 2990, commission_amount: 598, period: "2026-07", collected: true }]
    : await runCard(Deno.env.get("MB_CARD_COMMISSIONS")!);
  // TODO once Q1 columns are confirmed: map column names here.
  for (const r of rows) {
    const { error } = await supabase.from("commissions").upsert({
      hubspot_deal_id: String(r.hubspot_deal_id),
      hunter_email: String(r.hunter_email).trim().toLowerCase(),
      period: String(r.period ?? ""),
      base_amount: r.base_amount,
      commission_amount: r.commission_amount,
      calculated_at: r.calculated_at ?? new Date().toISOString(),
      collected: r.collected ?? null,
      synced_at: new Date().toISOString(),
    }, { onConflict: "hubspot_deal_id,hunter_email,period", ignoreDuplicates: false });
    if (error) throw error;
  }
  await supabase.rpc("rematch_commissions");
  return rows.length;
}

async function syncSubscriptions() {
  const rows = MOCK ? [] : await runCard(Deno.env.get("MB_CARD_SUBSCRIPTIONS")!);
  for (const r of rows) {
    await supabase.from("subscriptions").upsert({ ...r, synced_at: new Date().toISOString() });
  }
  return rows.length;
}

async function syncTopStores() {
  const rows = MOCK ? [] : await runCard(Deno.env.get("MB_CARD_TOPSTORES")!);
  for (const r of rows) {
    await supabase.from("store_showcase").upsert({ ...r, synced_at: new Date().toISOString() });
  }
  return rows.length;
}

Deno.serve(async () => {
  const started = new Date().toISOString();
  try {
    const counts = {
      commissions: await syncCommissions(),
      subscriptions: await syncSubscriptions(),
      top_stores: await syncTopStores(),
      mock: MOCK,
    };
    await supabase.from("sync_state").upsert({
      source: "metabase", last_run_at: started, last_status: "ok", last_error: null,
    });
    return Response.json({ ok: true, ...counts });
  } catch (e) {
    await supabase.from("sync_state").upsert({
      source: "metabase", last_run_at: started, last_status: "error", last_error: String(e),
    });
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
