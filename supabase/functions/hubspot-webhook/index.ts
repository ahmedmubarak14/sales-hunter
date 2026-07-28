// Sales Hunter — HubSpot webhook receiver (deal stage changes, near-real-time)
// Configure in HubSpot: webhooks → deal.propertyChange (dealstage) →
//   https://<project-ref>.functions.supabase.co/hubspot-webhook
// Secrets: HUBSPOT_APP_SECRET (for v3 signature verification), and
// WEBHOOK_PUBLIC_URL — the exact URL HubSpot is configured to call. The
// signature base includes the request URL, and req.url inside the edge
// runtime is not necessarily what HubSpot signed (proxy/prefix
// differences), so this has to be supplied explicitly rather than read
// off the incoming request.
//
// Fails closed: with no secret configured, every request is rejected
// (503) rather than accepted unverified. There is no "mock mode" for a
// webhook that writes to production tables under the service role — an
// unauthenticated version of this endpoint is a standing way for anyone
// on the internet to rewrite deal stages.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const APP_SECRET = Deno.env.get("HUBSPOT_APP_SECRET");
const PUBLIC_URL = Deno.env.get("WEBHOOK_PUBLIC_URL");

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
  if (!APP_SECRET || !PUBLIC_URL) return false;
  const ts = req.headers.get("x-hubspot-request-timestamp") ?? "";
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return false;
  const base = `POST${PUBLIC_URL}${rawBody}${ts}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(APP_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  const given = req.headers.get("x-hubspot-signature-v3") ?? "";
  return timingSafeEqual(expected, given);
}

type SubscriptionEvent = {
  subscriptionType?: string;
  propertyName?: string;
  objectId?: string | number;
  propertyValue?: string;
  occurredAt?: number;
};

Deno.serve(async (req) => {
  if (!APP_SECRET || !PUBLIC_URL) {
    // Configuration incomplete: refuse rather than accept unverified
    // writes. sync-hubspot's hourly poll still covers every stage
    // change, so this only costs near-real-time updates until
    // HUBSPOT_APP_SECRET and WEBHOOK_PUBLIC_URL are both set.
    return new Response("webhook not configured", { status: 503 });
  }

  const raw = await req.text();
  if (!(await verifySignature(req, raw))) {
    return new Response("bad signature", { status: 401 });
  }

  let events: unknown;
  try {
    events = JSON.parse(raw);
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  if (!Array.isArray(events)) {
    return new Response("expected an array of events", { status: 400 });
  }

  let processed = 0;
  for (const ev of events as SubscriptionEvent[]) {
    if (ev.subscriptionType !== "deal.propertyChange" || ev.propertyName !== "dealstage") continue;
    if (ev.objectId == null || ev.propertyValue == null) continue;
    const dealId = String(ev.objectId);

    const { data: existing, error: selErr } = await supabase.from("deals")
      .select("stage").eq("hubspot_deal_id", dealId).maybeSingle();
    if (selErr) {
      return Response.json({ ok: false, error: selErr.message }, { status: 500 });
    }

    const { error: upsertErr } = await supabase.from("deals").upsert({
      hubspot_deal_id: dealId,
      stage: ev.propertyValue,
      synced_at: new Date().toISOString(),
    });
    if (upsertErr) {
      return Response.json({ ok: false, error: upsertErr.message }, { status: 500 });
    }

    const { error: evErr } = await supabase.from("deal_stage_events").insert({
      hubspot_deal_id: dealId,
      from_stage: existing?.stage ?? null,
      to_stage: ev.propertyValue,
      occurred_at: ev.occurredAt ? new Date(ev.occurredAt).toISOString() : new Date().toISOString(),
      source: "webhook",
    });
    if (evErr) {
      return Response.json({ ok: false, error: evErr.message }, { status: 500 });
    }
    processed++;
    // TODO Phase 3: notify the hunter (email/Slack) on qualified / won.
  }
  return Response.json({ ok: true, received: events.length, processed });
});
