# Email-events Lambda

Receives Brevo's transactional-webhook events (delivered, opened, click, bounces, etc.) for the welcome email sent by `lambda/`'s handler, and stores one row per event in `myfirstbank-email-events` (region `us-east-2`). Independent from `lambda/` — separate table, separate role, separate Function URL — so nothing here can affect the tested lead-capture flow. Not served by GitHub Pages — deployed separately, same as `lambda/` and `worker/`.

AWS account: `797781631822`, region `us-east-2` — same as `lambda/`.

## Why this exists

`lambda/src/index.mjs`'s `brevoSendWelcomeEmail()` now sends `tags: [item.lead_id]` on every welcome email. Brevo echoes that tag back on every webhook event it fires for that message (a `tags` array on most event types, a singular `tag` string on `unsubscribed`), which is what lets this Lambda correlate an inbound event back to a specific lead without ever cross-referencing by email address.

## One-time setup

1. **DynamoDB table**:
   ```
   aws dynamodb create-table --profile myfirstbank --region us-east-2 \
     --table-name myfirstbank-email-events \
     --attribute-definitions AttributeName=lead_id,AttributeType=S AttributeName=sort_key,AttributeType=S \
     --key-schema AttributeName=lead_id,KeyType=HASH AttributeName=sort_key,KeyType=RANGE \
     --billing-mode PAY_PER_REQUEST
   ```
   `sort_key` is `${received_at}#${event_type}#${uuid}` (ISO-8601 timestamp first, so a `Query` on `lead_id` naturally returns events in chronological order). On-demand billing, same as `myfirstbank-leads`.

2. **IAM role** (`iam/trust-policy.json` + `iam/permissions-policy.json` in this directory — `PutItem` on this function's own table only, plus `GetItem` on `myfirstbank-leads` for the state/interested_in denormalization, nothing broader):
   ```
   aws iam create-role --profile myfirstbank \
     --role-name myfirstbank-email-events-lambda-role \
     --assume-role-policy-document file://lambda-events/iam/trust-policy.json

   aws iam put-role-policy --profile myfirstbank \
     --role-name myfirstbank-email-events-lambda-role \
     --policy-name myfirstbank-email-events-permissions \
     --policy-document file://lambda-events/iam/permissions-policy.json
   ```

3. **Package and create the function** (Node 20.x, zero dependencies — same "runtime already bundles AWS SDK v3" reasoning as `lambda/`; verify at deploy time the same way):
   ```
   cd lambda-events/src && zip -r ../function.zip . && cd ../..
   aws lambda create-function --profile myfirstbank --region us-east-2 \
     --function-name myfirstbank-email-events-handler \
     --runtime nodejs20.x \
     --handler index.handler \
     --role arn:aws:iam::797781631822:role/myfirstbank-email-events-lambda-role \
     --zip-file fileb://lambda-events/function.zip \
     --timeout 10 \
     --environment "Variables={EVENTS_TABLE_NAME=myfirstbank-email-events,LEADS_TABLE_NAME=myfirstbank-leads,WEBHOOK_TOKEN=<generate-a-random-secret>}"
   ```
   Generate the token with something like `openssl rand -hex 32` — it's the only thing standing between this endpoint and anyone who discovers its URL (see "Security notes" below).

4. **Function URL** — no native CORS config needed or wanted here: Brevo's webhook call is server-to-server, never a browser, so there's no `Origin` header and no CORS preflight to answer. Still needs the same two permission statements as `lambda/` (mandatory since AWS's October 2025 policy change):
   ```
   aws lambda create-function-url-config --profile myfirstbank \
     --function-name myfirstbank-email-events-handler \
     --auth-type NONE

   aws lambda add-permission --profile myfirstbank --function-name myfirstbank-email-events-handler \
     --action lambda:InvokeFunctionUrl --statement-id FunctionURLAllowPublicAccess \
     --principal "*" --function-url-auth-type NONE

   aws lambda add-permission --profile myfirstbank --function-name myfirstbank-email-events-handler \
     --action lambda:InvokeFunction --statement-id FunctionURLAllowPublicInvoke \
     --principal "*" --invoked-via-function-url
   ```
   Prints the live Function URL. See "Brevo dashboard configuration" below for what to do with it.

## Brevo dashboard configuration (manual — Brevo has no API/webhook automation triggered from this repo)

1. Log into Brevo → left sidebar **Transactional** → **Settings** → **Webhook**.
2. Click **Add a new webhook**.
3. **URL**: the Function URL from step 4 above, with the token as a query param:
   ```
   https://<function-url>.lambda-url.us-east-2.on.aws/?token=<the WEBHOOK_TOKEN value>
   ```
4. **Events**: tick all of them — `sent`/`request`, `delivered`, `opened`, `uniqueOpened`, `click`, `hardBounce`, `softBounce`, `blocked`, `spam`, `unsubscribed`, `invalid`, `deferred`. Everything gets captured unfiltered; which events matter for a given analysis is decided later, at query time, not at capture time.
5. Save.
6. **Verify end-to-end**: trigger one real welcome-email send (a real lead through `stay-updated.html`), then check CloudWatch logs for `myfirstbank-email-events-handler` and query `myfirstbank-email-events` by that lead's `lead_id` — a `delivered` row should appear, then `opened` once the email is actually opened.

## What it does, end to end

1. Brevo POSTs one event JSON object per webhook call (per Brevo's docs — handled defensively as `Array.isArray(payload) ? payload : [payload]` anyway, in case that's ever wrong for some account/config).
2. Non-`POST` → `405`. Missing/incorrect `?token=` query param → `401`, fail-closed (an unset `WEBHOOK_TOKEN` env var rejects every request rather than defaulting open). This — not CORS, not an Origin check — is the actual security boundary here, since a server-to-server webhook call never carries a browser Origin header.
3. Per event: extract `lead_id` from `tags[0]` (or the singular `tag` field for `unsubscribed`), best-effort `GetItem` the lead from `myfirstbank-leads` to denormalize `state`/`interested_in` onto the event row (non-fatal if the lookup fails), then `PutItem` into `myfirstbank-email-events` with the full raw event also stored under `raw_payload`.
4. Always responds `200 {ok:true}` once processing finishes, even if an individual event failed (logged to CloudWatch, not surfaced in the response) — a non-2xx or slow response makes Brevo retry the whole call and duplicate events that already succeeded. Retries/duplicates are otherwise tolerated on purpose: the sort key's trailing UUID means a retried event lands as a second row rather than overwriting the first.

## Security notes

- No credential is ever committed — `lambda-events/.env` is gitignored, `.env.example` holds placeholders only, and the real `WEBHOOK_TOKEN` lives only as a Lambda environment variable, never in this repo.
- IAM is scoped to exactly `dynamodb:PutItem` on this function's own table ARN, `dynamodb:GetItem` on the leads table ARN only (no `Scan`, `Query`, `UpdateItem`, or `DeleteItem` on either table), and this one function's log group.
- Same `--invoked-via-function-url` requirement as `lambda/` on the `lambda:InvokeFunction` permission statement — without it, `Principal: "*"` would let any AWS account invoke the function directly via the plain `Invoke` API with a fabricated event, bypassing the `WEBHOOK_TOKEN` check entirely (that check only reads a field from the event payload, which a direct caller fully controls).

## Known limitation / open item

Field names extracted from Brevo's raw event (`event`, `email`, `message-id`, `ts_epoch`, `link`, `user_agent`, `tags`/`tag`) are based on Brevo's published webhook documentation, not yet verified against a real captured payload. The first real event received after the webhook is activated should be compared against `raw_payload` in DynamoDB to confirm every field name matches what the code assumes before relying on this data for analysis.
