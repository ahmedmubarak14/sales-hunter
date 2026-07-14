// Sales Hunter — HubSpot deal sync (hourly reconciliation poll + backfill)
// Secrets: HUBSPOT_TOKEN (private app), HS_HUNTER_EMAIL_PROP (internal name
// of the deal property that carries the hunter's Zid email).
// MOCK mode when secrets are absent.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const HS_TOKEN = Deno.env.get("HUBSPOT_TOKEN");
const HUNTER_PROP = Deno.env.get("HS_HUNTER_EMAIL_PROP") ?? "hunter_email";
const MOCK = !HS_TOKEN;

// TODO once stage IDs are provided: map HubSpot stage IDs → app stage labels.
const STAGE_MAP: Record<string, string> = {
  // "appointmentscheduled": "New Lead", ...
};

async function fetchModifiedDeals(since: string | null) {
  if (MOCK) {
    return [{
      id: "MOCK-1",
      properties: {
        dealname: "Mock Merchant", dealstage: "closedwon", amount: "2990",
        [HUNTER_PROP]: "ahmed.mubarak@zid.sa",
        hs_lastmodifieddate: new Date().toISOString(),
      },
    }];
  }
  const body = {
    filterGroups: since ? [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GT", value: since }] }] : [],
    properties: ["dealname", "dealstage", "amount", "hubspot_owner_id",
      "closed_lost_reason", HUNTER_PROP, "hs_lastmodifieddate", "createdate", "closedate"],
    sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
    limit: 100,
  };
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HubSpot search: HTTP ${res.status}`);
  return (await res.json()).results ?? [];
}

Deno.serve(async () => {
  const started = new Date().toISOString();
  try {
    const { data: state } = await supabase.from("sync_state").select().eq("source", "hubspot").maybeSingle();
    const deals = await fetchModifiedDeals(state?.bookmark ?? null);
    let bookmark = state?.bookmark ?? null;

    for (const d of deals) {
      const p = d.properties;
      const stage = STAGE_MAP[p.dealstage] ?? p.dealstage;
      const { data: existing } = await supabase.from("deals").select("stage").eq("hubspot_deal_id", d.id).maybeSingle();
      await supabase.from("deals").upsert({
        hubspot_deal_id: d.id,
        company: p.dealname,
        hunter_email: p[HUNTER_PROP]?.trim().toLowerCase() ?? null,
        stage,
        amount_net: p.amount ? Number(p.amount) : null,
        lost_reason: p.closed_lost_reason ?? null,
        hs_created_at: p.createdate,
        hs_closed_at: p.closedate,
        synced_at: new Date().toISOString(),
      });
      if (existing && existing.stage !== stage) {
        await supabase.from("deal_stage_events").insert({
          hubspot_deal_id: d.id, from_stage: existing.stage, to_stage: stage,
          occurred_at: p.hs_lastmodifieddate ?? new Date().toISOString(), source: "poll",
        });
      }
      bookmark = p.hs_lastmodifieddate ?? bookmark;
    }

    await supabase.from("sync_state").upsert({
      source: "hubspot", bookmark, last_run_at: started, last_status: "ok", last_error: null,
    });
    return Response.json({ ok: true, synced: deals.length, mock: MOCK });
  } catch (e) {
    await supabase.from("sync_state").upsert({
      source: "hubspot", last_run_at: started, last_status: "error", last_error: String(e),
    });
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
