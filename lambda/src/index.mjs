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

// Same 51-entry [code, name] list independently duplicated in js/app.js:5-19,
// js/agent.js, and js/stay-updated.js — this Lambda has never imported
// frontend JS and shouldn't start now, so it's duplicated here too, matching
// that established convention for small static lists.
const STATE_NAMES = Object.fromEntries([
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"],
  ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"],
  ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"],
  ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
  ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"],
  ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
  ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"],
  ["WI", "Wisconsin"], ["WY", "Wyoming"], ["DC", "District of Columbia"],
]);

// Dependency-free HTML-entity escaping for lead-supplied strings
// interpolated into htmlContent. validate() below only checks that
// first_name/last_name are non-empty strings — it does NOT restrict their
// character set the way js/stay-updated.js's browser-side regex does, so a
// direct API caller (curl, bypassing the browser — already used repeatedly
// this session as a normal testing method against this same Function URL)
// could submit HTML/script content as a name. Same injection class the
// welcome email deliberately avoids for interest_note; applied here
// proactively for the same reason, even though not requested by name.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PRODUCT_LABELS = { checking: "Checking", savings: "Savings", credit_card: "Credit Card" };
const PRODUCT_ORDER = ["checking", "savings", "credit_card"];

// item.interested_in reflects checkbox/submission order from the browser,
// not a canonical order — without normalizing, two otherwise-identical
// leads could get "Savings and Checking" vs. "Checking and Savings"
// depending on click order. Always iterate in this fixed order instead.
function orderedInterests(interestedIn) {
  return PRODUCT_ORDER.filter((p) => interestedIn.includes(p));
}

// Body-copy joiner, Oxford-comma-less: 1→"Savings", 2→"Checking and
// Savings", 3→"Checking, Savings and Credit Card".
function joinInterestsAnd(orderedProducts) {
  const labels = orderedProducts.map((p) => PRODUCT_LABELS[p]);
  if (labels.length <= 1) return labels[0] || "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

// Hidden-preheader joiner, same shape with "&" instead of "and" — matches
// the user's 2-item example ("Checking & Savings"); the 3-item case mirrors
// the body joiner's comma pattern with "&" swapped in.
function joinInterestsAmpersand(orderedProducts) {
  const labels = orderedProducts.map((p) => PRODUCT_LABELS[p]);
  if (labels.length <= 1) return labels[0] || "";
  if (labels.length === 2) return `${labels[0]} & ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} & ${labels[labels.length - 1]}`;
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Manual split, not `new Date(isoString)` — mirrors the same defensive
// pattern already established in js/stay-updated.js's parseIsoDateLocal/
// toIsoDateLocal (fixed a real UTC-midnight timezone bug there). Not
// strictly needed server-side since Lambda defaults to UTC, but kept for
// consistency with that established convention.
function shortDate(isoDateStr) {
  const [, m, d] = isoDateStr.split("-").map(Number);
  return `${MONTH_SHORT[m - 1]} ${d}`;
}

// Whole calendar days between "today" (UTC midnight) and the arrival date
// (also UTC midnight, since arrival_date has no time component), floored,
// clamped at a minimum of 0 — never shows a negative number even in the
// unlikely edge case of a cold-start retry landing exactly on the boundary.
function daysLeft(isoDateStr, now = new Date()) {
  const [y, m, d] = isoDateStr.split("-").map(Number);
  const arrival = Date.UTC(y, m - 1, d);
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(Math.floor((arrival - todayUtcMidnight) / 86400000), 0);
}

// Fixed label + static descriptive copy per product — text never changes
// per lead, only row order/styling does (see buildProductRows below).
const PRODUCT_ROWS = {
  checking: { label: "Checking", copy: "Monthly fees, ATM network size, whether it accepts ITIN / no SSN" },
  savings: { label: "Savings", copy: "APY, minimum balance, whether it accepts ITIN / no SSN" },
  credit_card: { label: "Credit Card", copy: "Whether credit history is required, annual fee, secured vs. unsecured" },
};

// Always all 3 rows, selected products first. Selected rows get
// background:#E7F3EC/color:#1F6B42 and a "✓ " prefix — a deliberate,
// conscious exception to this site's usual "green reserved for eligibility
// badges only" rule (this is an email, not the site itself; approved as
// part of the reviewed email design). Unselected rows get
// background:#F2F1EC/color:#A3A29B, no prefix.
function buildProductRows(interestedIn) {
  const selected = orderedInterests(interestedIn);
  const unselected = PRODUCT_ORDER.filter((p) => !selected.includes(p));
  return [...selected, ...unselected].map((key) => {
    const isSelected = selected.includes(key);
    const { label, copy } = PRODUCT_ROWS[key];
    const bg = isSelected ? "#E7F3EC" : "#F2F1EC";
    const color = isSelected ? "#1F6B42" : "#A3A29B";
    const labelText = isSelected ? `✓ ${label}` : label;
    return `
              <tr style="background:${bg};">
                <td style="border-radius:8px 0 0 8px; padding:12px 14px; font-family:'Inter',Arial,sans-serif; font-size:13px; font-weight:600; color:${color}; width:120px;">${labelText}</td>
                <td style="border-radius:0 8px 8px 0; padding:12px 14px; font-family:'Inter',Arial,sans-serif; font-size:13px; color:${color};">${copy}</td>
              </tr>`;
  }).join("");
}

// Hidden preview-text technique: an invisible div as the very first element
// inside <body>, padded with zero-width-joiner/nbsp filler so inbox clients
// (which read forward into the visible body if the preheader is short)
// don't leak real body text into the inbox preview snippet.
function buildPreheader(interestedIn) {
  const text = `What to check: ${joinInterestsAmpersand(orderedInterests(interestedIn))}`;
  return `<div style="display:none; max-height:0px; overflow:hidden; opacity:0; mso-hide:all;">${escapeHtml(text)}${"&zwnj;&nbsp;".repeat(40)}</div>`;
}

const LOGO_URL = "https://juanjochiarellar.github.io/my-first-bank/assets/logos/_mark-email.png";
// One pre-cropped (1200x480) licensed photo per state, self-hosted at
// assets/state-collages/{CODE}.jpg — a zero-latency string lookup, never
// Lambda-side image fetching/compositing (that would add network calls and
// timeout risk to the critical send path). validate() already guarantees
// item.state is a known 2-letter code, so every lookup hits; the fallback
// below only guards against that invariant ever changing.
const STATE_COLLAGE_BASE_URL = "https://juanjochiarellar.github.io/my-first-bank/assets/state-collages";
function stateCollageUrl(stateCode) {
  return `${STATE_COLLAGE_BASE_URL}/${stateCode}.jpg`;
}

// Footer social links — pre-rendered icon-in-circle PNGs (28x28, matching
// the site's #F2F1EC/#6B6B65 muted style) rather than live SVG, since many
// email clients strip <svg>. Same self-hosted-asset pattern as LOGO_URL.
const SOCIAL_LINKS = [
  { key: "linkedin", label: "LinkedIn", url: "https://www.linkedin.com/in/juanjo-chiarella/" },
  { key: "instagram", label: "Instagram", url: "https://www.instagram.com/juanjo.chiarella/" },
  { key: "facebook", label: "Facebook", url: "https://www.facebook.com/Juanjo.Chiarella" },
  { key: "github", label: "GitHub", url: "https://github.com/JuanjoChiarellaR" },
];

function buildSocialLinksHtml() {
  return SOCIAL_LINKS.map(({ key, label, url }, i) => {
    const padding = i < SOCIAL_LINKS.length - 1 ? "padding-right:8px;" : "";
    const iconUrl = `https://juanjochiarellar.github.io/my-first-bank/assets/logos/social/${key}.png`;
    return `
          <td style="${padding}"><a href="${url}"><img src="${iconUrl}" width="28" height="28" alt="${label}" style="display:block; width:28px; height:28px; border-radius:50%;"></a></td>`;
  }).join("");
}

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

// Builds the fully-resolved subject + HTML for the welcome email. Split out
// from brevoSendWelcomeEmail() so it can also be exercised in isolation
// (e.g. for a local preview render) without making a real Brevo call.
export function buildWelcomeEmail(item) {
  const firstNameSafe = escapeHtml(item.first_name);
  const stateName = STATE_NAMES[item.state] || item.state;
  const selected = orderedInterests(item.interested_in);
  const days = daysLeft(item.arrival_date);
  // subject is a plain-text mail header, not HTML — raw first_name is
  // correct here (escaping it would show a literal "&amp;" to a recipient
  // whose name contains "&"). Anything inside htmlContent, including
  // <title>, uses the HTML-escaped version instead.
  const subject = `${item.first_name}, your ${stateName} checklist — ${days} days to go`;
  const preheader = buildPreheader(item.interested_in);
  const productRowsHtml = buildProductRows(item.interested_in);
  const interestsJoinedAnd = joinInterestsAnd(selected);

  const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(subject)}</title>
<style>
  @media screen and (max-width: 480px){
    .cta-cell{ display:block !important; width:100% !important; padding:0 0 10px 0 !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background:#FAFAF9;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF9;">
  <tr>
    <td style="padding:28px 32px 20px;">
      <img src="${LOGO_URL}" width="150" alt="MyFirstBank" style="display:block; width:150px; height:auto;">
    </td>
  </tr>

  <tr>
    <td style="padding:0 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF; border:1px solid #E4E3DD; border-radius:12px;">
        <tr>
          <td style="padding:32px;">

            <p style="font-family:'Inter',Arial,sans-serif; font-size:16px; color:#1F1F1D; margin:0 0 16px;">Hi ${firstNameSafe},</p>

            <p style="font-family:'Inter',Arial,sans-serif; font-size:15px; line-height:1.6; color:#1F1F1D; margin:0 0 20px;">
              You told us you're looking for <strong>${interestsJoinedAnd}</strong> for your move to <strong>${stateName}</strong> — happy to help with that search.
            </p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr>
                <td style="border-radius:12px; overflow:hidden;">
                  <img src="${stateCollageUrl(item.state)}" width="100%" alt="${escapeHtml(stateName)}" style="display:block; width:100%; height:auto; border-radius:12px;">
                </td>
              </tr>
            </table>

            <p style="font-family:'Inter Tight',Arial,sans-serif; font-size:13px; font-weight:600; color:#1F1F1D; margin:0 0 12px; text-transform:uppercase; letter-spacing:.04em;">What to compare, product by product</p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px; border-collapse:separate; border-spacing:0 8px;">${productRowsHtml}
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F1EC; border-radius:10px; margin:0 0 28px;">
              <tr>
                <td style="padding:16px 20px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-family:'Inter',Arial,sans-serif; font-size:13px; color:#6B6B65;">Landing in ${stateName}</td>
                      <td align="right" style="font-family:'IBM Plex Mono',Consolas,monospace; font-size:13px; color:#1F1F1D; font-weight:500;">${shortDate(item.arrival_date)} · ${days} days left</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td class="cta-cell" width="50%" style="padding-right:6px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center" style="background:#1F1F1D; border-radius:8px; padding:12px 16px;">
                        <a href="https://juanjochiarellar.github.io/my-first-bank/agent.html" style="display:block; font-family:'Inter',Arial,sans-serif; font-size:13px; font-weight:600; color:#FFFFFF; text-decoration:none;">Ask the Agent about your options</a>
                      </td>
                    </tr>
                  </table>
                </td>
                <td class="cta-cell" width="50%" style="padding-left:6px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center" style="background:#FFFFFF; border:1px solid #1F1F1D; border-radius:8px; padding:11px 16px;">
                        <a href="https://juanjochiarellar.github.io/my-first-bank/compare.html" style="display:block; font-family:'Inter',Arial,sans-serif; font-size:13px; font-weight:600; color:#1F1F1D; text-decoration:none;">Compare accounts side by side</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <p style="font-family:'Inter',Arial,sans-serif; font-size:14px; color:#6B6B65; margin:28px 0 0;">
              We'll follow up before you land.<br>— The MyFirstBank Team
            </p>

          </td>
        </tr>
      </table>
    </td>
  </tr>

  <tr>
    <td style="padding:24px 32px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
        <tr>
${buildSocialLinksHtml()}
        </tr>
      </table>
      <p style="font-family:'Inter',Arial,sans-serif; font-size:12px; color:#A3A29B; margin:0 0 8px; line-height:1.6;">
        MyFirstBank · [Mailing address — pending]
      </p>
      <p style="font-family:'Inter',Arial,sans-serif; font-size:12px; color:#A3A29B; margin:0 0 8px;">
        You're receiving this because you signed up for updates at MyFirstBank.
        <a href="#" style="color:#A3A29B;">Manage preferences</a> · <a href="#" style="color:#A3A29B;">Unsubscribe</a>
      </p>
      <p style="font-family:'Inter',Arial,sans-serif; font-size:11px; color:#A3A29B; margin:0;">
        © 2026 MyFirstBank. All rights reserved.
      </p>
    </td>
  </tr>
</table>
</body>
</html>`;

  return { subject, htmlContent };
}

async function brevoSendWelcomeEmail(item) {
  const { subject, htmlContent } = buildWelcomeEmail(item);
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: { email: BREVO_SENDER_EMAIL, name: BREVO_SENDER_NAME },
      to: [{ email: item.email, name: `${item.first_name} ${item.last_name}` }],
      subject,
      htmlContent,
      // Echoed back on every webhook event Brevo sends for this message, so
      // the events-capture Lambda (lambda-events/) can correlate opens/
      // clicks/bounces back to this lead without cross-referencing email.
      tags: [item.lead_id],
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
