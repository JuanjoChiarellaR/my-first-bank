// myfirstbank-leads-handler — the only server-side code behind
// stay-updated.html's lead-capture form. Writes the lead to DynamoDB, then
// best-effort fires a Brevo welcome email + SMS directly from here (no
// Brevo dashboard automation workflow involved). Mirrors the CORS/secret
// discipline already established by worker/src/index.js for Ask the Agent:
// the AWS credentials never touch the browser, and CORS is locked to the
// one real GitHub Pages origin, never "*".
//
// Brevo calls are feature-flagged on BREVO_API_KEY being set as an
// environment variable. Until the user supplies that key, this handler
// still writes every lead to DynamoDB correctly (sent_communications stays
// []) — the Brevo section just no-ops with a clear CloudWatch log line
// instead of throwing. Once BREVO_API_KEY is added later via
// `aws lambda update-function-configuration`, the exact same deployed code
// starts sending real emails/SMS with no code redeploy needed.

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

const TABLE_NAME = process.env.TABLE_NAME || "myfirstbank-leads";
const EMAIL_INDEX_NAME = process.env.EMAIL_INDEX_NAME || "email-index";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://juanjochiarellar.github.io";
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || "";
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || "MyFirstBank";
const BREVO_SMS_SENDER = process.env.BREVO_SMS_SENDER || "MyFirstBank"; // Brevo caps this at 11 alphanumeric chars

const VALID_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV",
  "WI","WY","DC",
]);
const VALID_PRODUCTS = new Set(["checking", "savings", "credit_card"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Access-Control-* headers are deliberately NOT set here. The Lambda
// Function URL's own CORS config (AllowOrigins: [ALLOWED_ORIGIN],
// AllowMethods: [POST], AllowHeaders: [Content-Type] — see lambda/README.md)
// already adds them to every response whose real Origin matches, and adds
// nothing when it doesn't. Setting them again from code produced a second,
// duplicate Access-Control-Allow-Origin header on every real-origin
// response — harmless to curl, but real browsers reject a response with
// more than one value for that header outright (confirmed live: the actual
// form submission failed in Chromium with exactly that CORS error, even
// though curl showed a normal 200). One source of truth, not two.
//
// This does NOT make the explicit origin check below redundant: CORS is a
// browser-only mechanism the Function URL's native config enforces for
// browser requests, but a non-browser client (curl, a script) can send any
// Origin header it likes and native CORS never even looks at it outside a
// real browser context. The check below is what actually rejects that.
function baseHeaders() {
  return { "Content-Type": "application/json" };
}

function validate(body) {
  if (!body.first_name || typeof body.first_name !== "string") return "first_name is required";
  if (!body.last_name || typeof body.last_name !== "string") return "last_name is required";
  if (!body.phone_country_code || typeof body.phone_country_code !== "string") return "phone_country_code is required";
  if (!body.phone_number || typeof body.phone_number !== "string") return "phone_number is required";
  if (!body.email || typeof body.email !== "string" || body.email.length > 254 || !EMAIL_RE.test(body.email)) return "a valid email is required";
  if (!body.state || !VALID_STATES.has(body.state)) return "a valid state is required";
  if (!Array.isArray(body.interested_in) || body.interested_in.length === 0) return "interested_in must have at least one product";
  if (!body.interested_in.every((p) => VALID_PRODUCTS.has(p))) return "interested_in contains an invalid product";
  if (!body.arrival_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.arrival_date)) return "a valid arrival_date (YYYY-MM-DD) is required";
  if (body.consent_email_sms !== true) return "consent_email_sms must be explicitly true";
  return null;
}

async function brevoUpsertContact(item) {
  const res = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: item.email,
      attributes: {
        FIRSTNAME: item.first_name,
        LASTNAME: item.last_name,
        SMS: `${item.phone_country_code}${item.phone_number}`,
        STATE: item.state,
      },
      updateEnabled: true, // create-or-update by email, no separate lookup call needed
    }),
  });
  if (!res.ok) throw new Error(`Brevo contact upsert failed: ${res.status} ${await res.text()}`);
}

async function brevoSendWelcomeEmail(item) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: { email: BREVO_SENDER_EMAIL, name: BREVO_SENDER_NAME },
      to: [{ email: item.email, name: `${item.first_name} ${item.last_name}` }],
      subject: "You're on the list — MyFirstBank",
      htmlContent: `<p>Hi ${item.first_name},</p><p>Thanks for signing up. We'll email you when we add a bank or product that matches what you told us you're looking for.</p><p>— MyFirstBank</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Brevo welcome email failed: ${res.status} ${await res.text()}`);
}

async function brevoSendWelcomeSms(item) {
  const res = await fetch("https://api.brevo.com/v3/transactionalSMS/sms", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: BREVO_SMS_SENDER,
      recipient: `${item.phone_country_code}${item.phone_number}`,
      content: `Hi ${item.first_name} — you're on the MyFirstBank list. We'll text/email you about new banks or products that match what you're looking for.`,
      type: "transactional",
    }),
  });
  if (!res.ok) throw new Error(`Brevo welcome SMS failed: ${res.status} ${await res.text()}`);
}

// Duplicate-email check, via the email-index GSI (partition key: email,
// KEYS_ONLY projection — we only need to know whether a row exists, not
// read any of its other fields). IAM is scoped to dynamodb:Query on this
// one index's own ARN only, not the base table and not Scan — see
// lambda/iam/permissions-policy.json.
async function emailAlreadyExists(email) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: EMAIL_INDEX_NAME,
    KeyConditionExpression: "email = :e",
    ExpressionAttributeValues: { ":e": email },
    Limit: 1,
  }));
  return (res.Items || []).length > 0;
}

async function appendSentCommunication(lead_id, label) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { lead_id },
    UpdateExpression: "SET sent_communications = list_append(sent_communications, :v)",
    ExpressionAttributeValues: { ":v": [label] },
  }));
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const origin = event.headers?.origin || event.headers?.Origin || "";
  const headers = baseHeaders();

  if (method === "OPTIONS") {
    return { statusCode: 204, headers };
  }
  if (method !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Independent, fail-closed origin check — the CORS header above is not
  // itself the security boundary; this explicit reject is. Same two-layer
  // shape as worker/src/index.js.
  if (origin !== ALLOWED_ORIGIN) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "Origin not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  // Normalize email server-side too, not just in js/stay-updated.js — the
  // duplicate-email check below only works if "Juan@Gmail.com" and
  // "juan@gmail.com" are treated as the same address, and the Lambda can't
  // assume every caller (a future client, a direct API test) already
  // lowercased it before sending.
  if (typeof body.email === "string") body.email = body.email.trim().toLowerCase();

  // Honeypot: a filled value means a bot bypassed the client-side skip in
  // js/stay-updated.js entirely. Fake-succeed with a fresh throwaway
  // lead_id — no DynamoDB write, no Brevo calls, nothing that distinguishes
  // this response from a real success for a scripted bot to learn from.
  // This is deliberately distinct from a real validation failure below,
  // which always returns a genuine 400.
  if (body.website) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, lead_id: randomUUID() }) };
  }

  const validationError = validate(body);
  if (validationError) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: validationError }) };
  }

  // Duplicate-email check: don't create a second row or fire Brevo again
  // for an email already on the list. Responds 200 either way (never 409)
  // so a bot can't enumerate which emails are already registered by
  // watching the status code — {duplicate:true} is the only signal, and
  // it's identical in shape/cost to a normal success from the outside.
  // If the check itself errors (e.g. a transient DynamoDB issue), fail
  // open — log it and proceed as a new signup rather than blocking a
  // legitimate user over an infrastructure hiccup; a false negative here
  // just means a possible duplicate row, not a security problem.
  try {
    if (await emailAlreadyExists(body.email)) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, duplicate: true }) };
    }
  } catch (err) {
    console.error("Duplicate-email check failed, proceeding as new signup", { email: body.email, error: String(err) });
  }

  const lead_id = randomUUID();
  const created_at = new Date().toISOString();
  const item = {
    lead_id,
    created_at,
    first_name: body.first_name,
    last_name: body.last_name,
    phone_country_code: body.phone_country_code,
    phone_number: body.phone_number,
    email: body.email,
    state: body.state,
    interested_in: body.interested_in,
    interest_note: String(body.interest_note || "").slice(0, 200),
    arrival_date: body.arrival_date,
    consent_email_sms: true,
    consent_timestamp: created_at,
    source_page: body.source_page || "unknown",
    sent_communications: [],
  };

  try {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  } catch (err) {
    console.error("DynamoDB PutItem failed", { lead_id, error: String(err) });
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Could not save signup" }) };
  }

  // Everything below is best-effort — the lead is already durably saved.
  // Each Brevo call is independently caught so one failure never blocks the
  // next, and sent_communications only gets an entry when Brevo actually
  // confirmed success, not just attempted (see README.md for why this
  // matters for a future reminder-trigger Lambda and for auditing failures).
  if (!BREVO_API_KEY) {
    console.log("BREVO_API_KEY not set — skipping Brevo calls", { lead_id });
  } else {
    try {
      await brevoUpsertContact(item);
    } catch (err) {
      console.error("Brevo contact upsert failed", { lead_id, error: String(err) });
    }

    try {
      await brevoSendWelcomeEmail(item);
      await appendSentCommunication(lead_id, "welcome_email");
    } catch (err) {
      console.error("Welcome email failed", { lead_id, error: String(err) });
    }

    try {
      await brevoSendWelcomeSms(item);
      await appendSentCommunication(lead_id, "welcome_sms");
    } catch (err) {
      console.error("Welcome SMS failed", { lead_id, error: String(err) });
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, lead_id }) };
};
