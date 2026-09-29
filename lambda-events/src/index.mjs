import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

const EVENTS_TABLE_NAME = process.env.EVENTS_TABLE_NAME || "myfirstbank-email-events";
const LEADS_TABLE_NAME = process.env.LEADS_TABLE_NAME || "myfirstbank-leads";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";

function baseHeaders() {
  return { "Content-Type": "application/json" };
}

// Brevo echoes back whatever `tags` was sent on the original transactional
// send (see lambda/src/index.mjs's brevoSendWelcomeEmail, which now sends
// tags: [item.lead_id]) as a `tags` array on every event type — except
// "unsubscribed", which uses a singular `tag` string field instead.
function extractLeadId(raw) {
  if (Array.isArray(raw.tags) && raw.tags.length > 0) return raw.tags[0];
  if (typeof raw.tag === "string" && raw.tag) return raw.tag;
  return null;
}

// Best-effort denormalization so later analysis (engagement by state / by
// product interest) doesn't need to cross-reference the leads table. Never
// fatal: an event is still stored even if the lead lookup fails or the
// lead_id can't be resolved at all (e.g. a malformed/pre-tags test event).
async function getLead(leadId) {
  if (!leadId) return null;
  try {
    const res = await ddb.send(new GetCommand({ TableName: LEADS_TABLE_NAME, Key: { lead_id: leadId } }));
    return res.Item || null;
  } catch (err) {
    console.error("Lead lookup failed", leadId, err);
    return null;
  }
}

// Builds and stores one event row. Wrapped in try/catch by the caller so one
// malformed event never fails the whole webhook request/response — Brevo
// retries on a non-2xx or slow response, which would otherwise pile up
// duplicate rows for events that already succeeded.
async function processEvent(raw) {
  const leadId = extractLeadId(raw);
  const receivedAt = new Date().toISOString();
  const eventType = raw.event || "unknown";
  // ISO timestamp first so lexicographic order == chronological order,
  // event_type for readability when scanning, trailing uuid (same
  // dependency-free id generator already used in lambda/src/index.mjs) so
  // same-millisecond events and Brevo retries never collide/overwrite.
  const sortKey = `${receivedAt}#${eventType}#${randomUUID()}`;

  const lead = await getLead(leadId);

  const item = {
    lead_id: leadId || "unknown",
    sort_key: sortKey,
    event_type: eventType,
    email: raw.email ?? null,
    // Brevo's field is literally named "message-id" (hyphenated) — cannot
    // be accessed with dot notation (raw.message-id is a subtraction
    // expression, not a property access), so bracket notation is required.
    message_id: raw["message-id"] ?? null,
    event_ts: raw.ts_epoch ?? raw.ts ?? raw.date ?? null,
    received_at: receivedAt,
    link_url: raw.link ?? null, // only present on "click" events
    user_agent: raw.user_agent ?? null, // present on opened/uniqueOpened/click/unsubscribed
    // Brevo's standard transactional webhook payload does not expose the
    // recipient's IP (only `sending_ip`, Brevo's own outbound relay IP) —
    // kept for schema completeness in case a future payload variant adds
    // it; expect null in practice. See raw_payload below for the ground truth.
    ip: raw.ip ?? null,
    lead_state: lead?.state ?? null,
    lead_interested_in: lead?.interested_in ?? null,
    // The full event exactly as Brevo sent it, stored as a native DynamoDB
    // map (not a stringified blob) — future-proofs against any field Brevo
    // adds that isn't extracted above, and is the ground truth to check
    // field-name assumptions against once real events start arriving.
    raw_payload: raw,
  };

  await ddb.send(new PutCommand({ TableName: EVENTS_TABLE_NAME, Item: item }));
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const headers = baseHeaders();

  if (method !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const token = event.queryStringParameters?.token || "";
  if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  // Brevo's docs describe one event object per webhook call, not a batch
  // array — handled defensively anyway in case that's ever wrong for some
  // account/config, per the plan's "confirm the real format" instruction.
  const events = Array.isArray(payload) ? payload : [payload];

  const results = await Promise.allSettled(events.map(processEvent));
  for (const r of results) {
    if (r.status === "rejected") console.error("Failed to process Brevo event", r.reason);
  }

  // Always 200 fast, even if some individual events failed above (logged to
  // CloudWatch, not surfaced here) — a non-2xx/slow response makes Brevo
  // retry the entire webhook call and duplicate the events that already
  // succeeded.
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
