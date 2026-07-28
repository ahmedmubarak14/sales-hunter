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

// PostgREST caps any single response at its configured max-rows (1000 on
// this project) regardless of caller role — a plain .select() on a full
// table silently returns only the first page once the table passes that
// count, with no error to signal it. This is exactly how the
// amount-carry-forward set below went incomplete in an earlier incident.
// Pages via .range() behind a caller-supplied order (pagination is only
// correct with a stable sort; ties on a non-unique column let rows shift
// between pages) until a page comes back short — proof nothing was left
// behind, no separate row-count check needed.
const PAGE_SIZE = 1000;
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}

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

// A deal that was marked lost or unqualified rarely stays in that stage —
// sales re-opens it, or it moves to the nurturing pipeline. HubSpot keeps
// a "date entered <stage>" property per stage, which is how its own
// reports count these, so collect the ones belonging to lost /
// unqualified stages in the pipelines we sync. Resolved from the
// pipelines API rather than hardcoded: stage ids are portal-specific.
function terminalStageProps(
  stageLabels: Record<string, Record<string, string>>,
  pipelines: string[] | undefined,
): { lost: string[]; unqualified: string[] } {
  const lost: string[] = [], unqualified: string[] = [];
  for (const [pipeId, stages] of Object.entries(stageLabels)) {
    if (pipelines?.length && !pipelines.includes(pipeId)) continue;
    for (const [stageId, label] of Object.entries(stages)) {
      const l = String(label).toLowerCase();
      if (l.includes("lost")) lost.push(`hs_v2_date_entered_${stageId}`);
      else if (l.includes("unqual")) unqualified.push(`hs_v2_date_entered_${stageId}`);
    }
  }
  return { lost, unqualified };
}

// Earliest of the given date properties — when a deal has bounced through
// more than one lost stage, the first time it happened is the honest one.
function earliestOf(props: Record<string, unknown>, keys: string[]): string | null {
  let best: number | null = null, bestRaw: string | null = null;
  for (const k of keys) {
    const raw = props[k];
    if (raw == null || String(raw).trim() === "") continue;
    const ms = new Date(String(raw)).getTime();
    if (Number.isNaN(ms)) continue;
    if (best === null || ms < best) { best = ms; bestRaw = new Date(ms).toISOString(); }
  }
  return bestRaw;
}

// The portal id is what turns a deal id into a clickable CRM link. Store
// it in `settings` (readable by any signed-in user, and not a secret)
// rather than hardcoding it, so the links follow the connected account.
async function saveAccountInfo(token: string) {
  const res = await fetch("https://api.hubapi.com/account-info/v3/details", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return;
  const info = await res.json();
  if (!info?.portalId) return;
  await supabase.from("settings").upsert([
    { key: "hubspot_portal_id", value: String(info.portalId) },
    { key: "hubspot_ui_domain", value: info.uiDomain || "app.hubspot.com" },
  ]);
}

async function fetchModifiedDeals(token: string, settings: HSSettings, properties: string[], since: string | null) {
  const filters: Record<string, unknown>[] = [];
  if (since) filters.push({ propertyName: "hs_lastmodifieddate", operator: "GT", value: since });
  if (settings.pipelines?.length) filters.push({ propertyName: "pipeline", operator: "IN", values: settings.pipelines });
  if (settings.target_type) filters.push({ propertyName: "target_type", operator: "EQ", value: settings.target_type });

  // The search endpoint caps at 100 results per page. Without following
  // the cursor this poll only ever saw the oldest 100 modified deals and
  // needed as many hourly runs as there were pages to catch up, so stage
  // changes showed up in the app hours late. Page until HubSpot stops
  // handing back a cursor.
  const all: Record<string, never>[] = [];
  let after: string | null = null;
  do {
    const body: Record<string, unknown> = {
      filterGroups: filters.length ? [{ filters }] : [],
      properties,
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
      limit: 100,
    };
    if (after) body.after = after;
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HubSpot search: HTTP ${res.status} — ${await res.text()}`);
    const page = await res.json();
    all.push(...(page.results ?? []));
    after = page.paging?.next?.after ?? null;
  } while (after);
  return all;
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

    // Stage labels come first: the lost/unqualified stage-history
    // properties are derived from them and have to be part of the deal
    // query itself.
    const stageLabels = conn.configured ? await fetchStageLabels(conn.token) : {};
    const terminal = terminalStageProps(stageLabels, settings.pipelines);

    const properties = Array.from(new Set([
      "dealname", "dealstage", "pipeline", "hs_lastmodifieddate", "createdate", "closedate",
      hunterProp, amountProp, closeProp,
      ...(lostProp ? [lostProp] : []),
      ...(unqualProp ? [unqualProp] : []),
      ...terminal.lost,
      ...terminal.unqualified,
      ...extraProps,
    ]));

    const { data: state } = await supabase.from("sync_state").select().eq("source", "hubspot").maybeSingle();
    let bookmark = state?.bookmark ?? null;

    const deals = conn.configured
      ? await fetchModifiedDeals(conn.token, settings, properties, bookmark)
      : mockDeals(hunterProp);
    if (conn.configured) await saveAccountInfo(conn.token);

    // Metabase is the source of truth for amount once a deal has a real
    // invoiced purchase — don't let this HubSpot poll (which only sees
    // the deal's quoted amount) stomp back over what sync-metabase
    // already corrected. Owner names are entirely sync-metabase's job
    // now (the HubSpot token isn't scoped for crm.objects.owners.read,
    // so this sync never had a real name to offer anyway).
    // Read this defensively: if the query silently returns nothing, every
    // deal looks un-owned and the write below would wipe Metabase's
    // amounts wholesale. Fail the run instead of destroying data.
    const subRows = await fetchAll<{ hubspot_deal_id: string }>((from, to) =>
      supabase.from("subscriptions").select("hubspot_deal_id").order("hubspot_deal_id").range(from, to)
    ).catch((e) => { throw new Error(`could not read subscriptions (needed to protect Metabase amounts): ${e.message}`); });
    const metabaseOwned = new Set(subRows.map((r) => r.hubspot_deal_id));

    // One read of current stages up front and chunked writes at the end —
    // a select + upsert per deal ran up against the function timeout once
    // a full page set (hundreds of deals) arrives in a single run.
    const current = await fetchAll<{ hubspot_deal_id: string; stage: string; amount_net: number | null }>((from, to) =>
      supabase.from("deals").select("hubspot_deal_id, stage, amount_net").order("hubspot_deal_id").range(from, to)
    );
    const stageOf = new Map(current.map((r) => [r.hubspot_deal_id, r.stage]));
    const amountOf = new Map(current.map((r) => [r.hubspot_deal_id, r.amount_net]));

    const now = new Date().toISOString();
    const patches: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];

    for (const d of deals) {
      const p = d.properties;
      const stage = stageLabels[p.pipeline]?.[p.dealstage] ?? p.dealstage;

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
        entered_lost_at: earliestOf(p, terminal.lost),
        entered_unqualified_at: earliestOf(p, terminal.unqualified),
        extra,
        synced_at: now,
      };
      // amount_net is ALWAYS written, never conditionally omitted. These
      // rows go out as one bulk upsert, and PostgREST unions the columns
      // across the batch — so a row that leaves amount_net off does not
      // keep its stored value, it gets NULL. Omitting the key wiped every
      // Metabase-sourced amount on the first full backfill. Carry the
      // stored value forward explicitly instead.
      const hsAmount = p[amountProp] != null && String(p[amountProp]).trim() !== ""
        ? Number(p[amountProp]) : null;
      const keepStored = metabaseOwned.has(d.id) || hsAmount === null || Number.isNaN(hsAmount);
      patch.amount_net = keepStored ? (amountOf.get(d.id) ?? null) : hsAmount;
      patches.push(patch);

      const prevStage = stageOf.get(d.id);
      if (prevStage !== undefined && prevStage !== stage) {
        events.push({
          hubspot_deal_id: d.id, from_stage: prevStage, to_stage: stage,
          occurred_at: p.hs_lastmodifieddate ?? now, source: "poll",
        });
      }
      bookmark = p.hs_lastmodifieddate ?? bookmark;
    }

    const CHUNK = 500;
    for (let i = 0; i < patches.length; i += CHUNK) {
      const { error } = await supabase.from("deals").upsert(patches.slice(i, i + CHUNK));
      if (error) throw error;
    }
    for (let i = 0; i < events.length; i += CHUNK) {
      const { error } = await supabase.from("deal_stage_events").insert(events.slice(i, i + CHUNK));
      if (error) throw error;
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
