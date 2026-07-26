// Sales Hunter — HubSpot deal sync (hourly reconciliation poll + backfill)
// Connection + field mapping are configured from the app's Integrations
// page (management only) and stored in integration_config /
// integration_secrets — see supabase/migrations/013_integrations.sql.
// Runs in MOCK mode until a HubSpot token has been saved there.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

type HSSettings = {
  pipelines?: string[];
  target_type?: string;
  hunter_prop?: string;
  amount_prop?: string;
  close_date_prop?: string;
  lost_reason_prop?: string;
  unqualified_reason_prop?: string;
  extra_properties?: string[];
};

async function loadConnection() {
  const { data: cfg } = await supabase
    .from("integration_config")
    .select("settings, secret_set")
    .eq("name", "hubspot")
    .maybeSingle();
  if (!cfg?.secret_set) return { configured: false as const };
  const { data: token, error } = await supabase.rpc("get_integration_secret", { p_name: "hubspot" });
  if (error || !token) throw new Error(`could not read saved HubSpot token: ${error?.message ?? "empty"}`);
  return { configured: true as const, token: token as string, settings: (cfg.settings ?? {}) as HSSettings };
}

// Deal stage IDs are only unique per-pipeline, so labels are resolved via
// the pipelines API rather than a hardcoded map.
async function fetchStageLabels(token: string): Promise<Record<string, Record<string, string>>> {
  const res = await fetch("https://api.hubapi.com/crm/v3/pipelines/deals", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return {};
  const pipelines = (await res.json()).results ?? [];
  const map: Record<string, Record<string, string>> = {};
  for (const p of pipelines) {
    map[p.id] = {};
    for (const s of p.stages ?? []) map[p.id][s.id] = s.label;
  }
  return map;
}

async function fetchModifiedDeals(token: string, settings: HSSettings, properties: string[], since: string | null) {
  const filters: Record<string, unknown>[] = [];
  if (since) filters.push({ propertyName: "hs_lastmodifieddate", operator: "GT", value: since });
  if (settings.pipelines?.length) filters.push({ propertyName: "pipeline", operator: "IN", values: settings.pipelines });
  if (settings.target_type) filters.push({ propertyName: "target_type", operator: "EQ", value: settings.target_type });

  const body = {
    filterGroups: filters.length ? [{ filters }] : [],
    properties,
    sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
    limit: 100,
  };
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HubSpot search: HTTP ${res.status} — ${await res.text()}`);
  return (await res.json()).results ?? [];
}

function mockDeals(hunterProp: string) {
  return [{
    id: "MOCK-1",
    properties: {
      dealname: "Mock Merchant", dealstage: "closedwon", pipeline: "mock",
      amount: "2990", [hunterProp]: "ahmedmubaraks@hotmail.com",
      hs_lastmodifieddate: new Date().toISOString(),
      createdate: new Date().toISOString(), closedate: new Date().toISOString(),
    },
  }];
}

Deno.serve(async () => {
  const started = new Date().toISOString();
  let configured = false;
  try {
    const conn = await loadConnection();
    configured = conn.configured;
    const settings: HSSettings = conn.configured ? conn.settings : {};

    const hunterProp = settings.hunter_prop || "hunter_email";
    const amountProp = settings.amount_prop || "amount";
    const closeProp = settings.close_date_prop || "closedate";
    const lostProp = settings.lost_reason_prop || "";
    const unqualProp = settings.unqualified_reason_prop || "";
    const extraProps = settings.extra_properties ?? [];

    const properties = Array.from(new Set([
      "dealname", "dealstage", "pipeline", "hs_lastmodifieddate", "createdate", "closedate",
      hunterProp, amountProp, closeProp,
      ...(lostProp ? [lostProp] : []),
      ...(unqualProp ? [unqualProp] : []),
      ...extraProps,
    ]));

    const { data: state } = await supabase.from("sync_state").select().eq("source", "hubspot").maybeSingle();
    let bookmark = state?.bookmark ?? null;

    const deals = conn.configured
      ? await fetchModifiedDeals(conn.token, settings, properties, bookmark)
      : mockDeals(hunterProp);
    const stageLabels = conn.configured ? await fetchStageLabels(conn.token) : {};

    // Metabase is the source of truth for amount once a deal has a real
    // invoiced purchase — don't let this HubSpot poll (which only sees
    // the deal's quoted amount) stomp back over what sync-metabase
    // already corrected. Owner names are entirely sync-metabase's job
    // now (the HubSpot token isn't scoped for crm.objects.owners.read,
    // so this sync never had a real name to offer anyway).
    const { data: subRows } = await supabase.from("subscriptions").select("hubspot_deal_id");
    const metabaseOwned = new Set((subRows ?? []).map((r) => r.hubspot_deal_id));

    for (const d of deals) {
      const p = d.properties;
      const stage = stageLabels[p.pipeline]?.[p.dealstage] ?? p.dealstage;
      const { data: existing } = await supabase.from("deals").select("stage").eq("hubspot_deal_id", d.id).maybeSingle();

      const extra: Record<string, unknown> = {};
      for (const key of extraProps) if (p[key] != null) extra[key] = p[key];

      const patch: Record<string, unknown> = {
        hubspot_deal_id: d.id,
        company: p.dealname,
        hunter_email: p[hunterProp] ? String(p[hunterProp]).trim().toLowerCase() : null,
        stage,
        lost_reason: lostProp ? (p[lostProp] ?? null) : null,
        unqualified_reason: unqualProp ? (p[unqualProp] ?? null) : null,
        hs_created_at: p.createdate,
        hs_closed_at: p[closeProp] ?? p.closedate,
        extra,
        synced_at: new Date().toISOString(),
      };
      if (!metabaseOwned.has(d.id)) {
        patch.amount_net = p[amountProp] != null ? Number(p[amountProp]) : null;
      }

      await supabase.from("deals").upsert(patch);

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
    if (configured) {
      await supabase.from("integration_config").update({ last_synced_at: started, last_status: "ok" }).eq("name", "hubspot");
    }
    return Response.json({ ok: true, synced: deals.length, mock: !conn.configured });
  } catch (e) {
    await supabase.from("sync_state").upsert({
      source: "hubspot", last_run_at: started, last_status: "error", last_error: String(e),
    });
    if (configured) {
      await supabase.from("integration_config").update({ last_synced_at: started, last_status: `error: ${String(e)}` }).eq("name", "hubspot");
    }
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
