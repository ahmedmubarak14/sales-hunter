// Sales Hunter — HubSpot webhook receiver (deal stage changes, near-real-time)
// Configure in HubSpot: webhooks → deal.propertyChange (dealstage) →
//   https://<project-ref>.functions.supabase.co/hubspot-webhook
// Secrets: HUBSPOT_APP_SECRET (for v3 signature verification).

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const APP_SECRET = Deno.env.get("HUBSPOT_APP_SECRET");

async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
  if (!APP_SECRET) return true; // mock mode
  const ts = req.headers.get("x-hubspot-request-timestamp") ?? "";
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return false;
  const base = `POST${new URL(req.url).href}${rawBody}${ts}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(APP_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return expected === req.headers.get("x-hubspot-signature-v3");
}

Deno.serve(async (req) => {
  const raw = await req.text();
  if (!(await verifySignature(req, raw))) {
    return new Response("bad signature", { status: 401 });
  }
  const events = JSON.parse(raw); // array of subscription events
  for (const ev of events) {
    if (ev.subscriptionType === "deal.propertyChange" && ev.propertyName === "dealstage") {
      const dealId = String(ev.objectId);
      const { data: existing } = await supabase.from("deals")
        .select("stage").eq("hubspot_deal_id", dealId).maybeSingle();
      await supabase.from("deals").upsert({
        hubspot_deal_id: dealId,
        stage: ev.propertyValue,
        synced_at: new Date().toISOString(),
      });
      await supabase.from("deal_stage_events").insert({
        hubspot_deal_id: dealId,
        from_stage: existing?.stage ?? null,
        to_stage: ev.propertyValue,
        occurred_at: new Date(ev.occurredAt).toISOString(),
        source: "webhook",
      });
      // TODO Phase 3: notify the hunter (email/Slack) on qualified / won.
    }
  }
  return Response.json({ ok: true, received: events.length });
});
