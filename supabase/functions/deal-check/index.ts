// Sales Hunter — deal check (one domain, on demand)
//
// Answers "is this domain eligible?" by asking Metabase for the single
// matching row of the deal-checker question (card 18789), the same way a
// person does in the Metabase UI by filtering domain_url.
//
// WHY NOT A SYNC. The obvious design was to mirror the card into a table
// on a schedule. It does not work: the card is a catalogue of every Zid
// store, and three separate attempts to traverse it — as JSON, as
// streamed CSV, and as streamed CSV keeping only the interesting rows —
// were all killed with WORKER_RESOURCE_LIMIT partway through. It is also
// pointless: of the first 202,000 rows, 98.7% were "eligible for
// hunting", for which the answer is identical to the one a domain that is
// absent already gets. A partial mirror is worse than none, because every
// domain the run never reached reads as "not on the list", which the tab
// reports as Eligible.
//
// Querying one domain avoids all of it: no table, no schedule, nothing
// stale, and the work is proportional to what was actually asked.
//
// The Metabase key stays here. The browser never sees it, and the caller
// must present a valid app JWT (verify_jwt is on for this function).

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// The Metabase instance's "Data Warehouse", same id the other syncs use.
const WAREHOUSE_DB_ID = 2;

async function loadConnection() {
  const { data: cfg, error: cfgErr } = await supabase
    .from("integration_config")
    .select("settings, secret_set")
    .eq("name", "metabase")
    .maybeSingle();
  if (cfgErr) throw new Error(`could not read metabase integration config: ${cfgErr.message}`);
  if (!cfg?.secret_set) return { configured: false as const };
  const { data: key, error } = await supabase.rpc("get_integration_secret", { p_name: "metabase" });
  if (error || !key) throw new Error(`could not read saved Metabase key: ${error?.message ?? "empty"}`);
  const settings = (cfg.settings ?? {}) as { base_url?: string; card_deal_checker?: string };
  let base = settings.base_url || "";
  try { base = new URL(base).origin; } catch { /* left as typed; the request below fails loudly */ }
  return { configured: true as const, key: key as string, base, settings };
}

// Same reduction the browser applies, so both sides agree on what a host is.
function normalizeDomain(raw: unknown): string {
  let v = String(raw ?? "").trim().toLowerCase();
  if (!v) return "";
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.replace(/^[^@/]*@/, "");
  v = v.split(/[/?#]/)[0];
  v = v.replace(/:\d+$/, "");
  v = v.replace(/^www\./, "").replace(/\.$/, "");
  return v;
}

/* Case is prose maintained by whoever owns the question. Observed:
   "eligible for hunting", "Eligible for Upgrade", "not eligible" — mixed
   case, and a sample showed plenty of wording beyond those three.
   "not eligible" is tested first because it contains "eligible".
   Anything unrecognised returns null, which the tab shows as needing a
   human check: recoverable, where a wrong "eligible" sends a hunter after
   a merchant they cannot be paid for. */
function eligibleFromCase(caseText: string): boolean | null {
  const v = caseText.trim().toLowerCase();
  if (!v) return null;
  if (/\bnot\s+eligible\b|\bineligible\b|\bnot_eligible\b/.test(v)) return false;
  if (/\beligible\b/.test(v)) return true;
  return null;
}

/* Query the saved question as a source table and filter it, which is what
   the Metabase UI does when someone types into the domain_url filter. */
async function queryDomain(base: string, key: string, cardId: string, domain: string) {
  const body = {
    database: WAREHOUSE_DB_ID,
    type: "query",
    query: {
      "source-table": `card__${cardId}`,
      filter: ["=", ["field", "domain_url", { "base-type": "type/Text" }], domain],
      limit: 5,
    },
  };
  const res = await fetch(`${base}/api/dataset`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Metabase dataset: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  }
  const payload = await res.json();
  if (payload?.status === "failed") {
    throw new Error(`Metabase dataset failed: ${String(payload?.error ?? "").slice(0, 300)}`);
  }
  const cols: string[] = (payload?.data?.cols ?? []).map((c: Record<string, unknown>) =>
    String(c?.name ?? "").toLowerCase()
  );
  const rows: unknown[][] = payload?.data?.rows ?? [];
  return { cols, rows };
}

function cell(cols: string[], row: unknown[], ...names: string[]): unknown {
  for (const want of names) {
    const i = cols.indexOf(want.toLowerCase());
    if (i >= 0) return row[i];
  }
  return undefined;
}

function numOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(String(raw).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const anyE = e as Record<string, unknown>;
    return String(anyE.message ?? anyE.error ?? anyE.details ?? JSON.stringify(e));
  }
  return String(e);
}

/* The browser calls this function directly, and every call carries
   Authorization, apikey and Content-Type — three headers that make it a
   non-simple request, so Chrome sends an OPTIONS preflight first. Without
   these headers the preflight is rejected and the real POST is never
   sent: fetch rejects with a TypeError, which the tab could only report
   as "could not check". A function only cron calls never needs this;
   one a page calls always does. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  // Answer the preflight before anything else — it carries no body and no
  // JWT, so parsing or authorising it would fail on a request that is
  // only asking whether the real one is allowed.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    const input = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    /* Status probe. The tab asks once on render whether the list can be
       consulted at all, so it can say so before anyone types rather than
       letting every check discover it separately. Answered without
       touching Metabase — it is a question about configuration. */
    if (input?.status === true) {
      const c = await loadConnection();
      return json({
        ok: true,
        status: (c.configured && c.settings.card_deal_checker) ? "ready" : "notconfigured",
      });
    }

    const domain = normalizeDomain(input?.domain);
    if (!domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      return json({ ok: false, verdict: "invalid", domain }, 400);
    }

    const conn = await loadConnection();
    if (!conn.configured || !conn.settings.card_deal_checker) {
      return json({ ok: true, verdict: "notconfigured", domain });
    }

    const { cols, rows } = await queryDomain(
      conn.base, conn.key, conn.settings.card_deal_checker, domain,
    );
    if (!cols.includes("domain_url")) {
      // The question's columns changed. Say so rather than reporting the
      // empty result as "not on the list", which reads as eligible.
      throw new Error(`no domain_url column in card ${conn.settings.card_deal_checker} (saw ${cols.join(", ")})`);
    }
    if (!rows.length) {
      // Genuinely absent from the card: not a Zid store, so it is the
      // hunter's to go after.
      return json({ ok: true, verdict: "yes", domain, found: false });
    }

    const row = rows[0];
    const caseText = String(cell(cols, row, "case", "case_text", "status") ?? "").trim();
    const eligible = eligibleFromCase(caseText);
    return json({
      ok: true,
      verdict: eligible === true ? "yes" : eligible === false ? "no" : "unclear",
      domain,
      found: true,
      caseText: caseText || null,
      storeId: cell(cols, row, "store_id") ?? null,
      packageType: cell(cols, row, "package_type") ?? null,
      daysSinceEnded: numOrNull(cell(cols, row, "days_since_subscription_ended")),
    });
  } catch (e) {
    // Never "yes" on a failure: unknown is recoverable, a wrong pass is not.
    return json({ ok: false, verdict: "unavailable", error: errMsg(e) }, 500);
  }
});
