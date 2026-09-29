# Lead-capture Lambda

The only server-side code behind `stay-updated.html`'s lead-capture form. Writes each valid submission to DynamoDB (`myfirstbank-leads`, region `us-east-2`), then best-effort fires a Brevo welcome email + SMS directly from Lambda code — no Brevo dashboard automation workflow involved, no API Gateway (a Lambda Function URL is the public endpoint, same "no full API Gateway needed" pattern as the Cloudflare Worker behind Ask the Agent). Not served by GitHub Pages — deployed separately, same as `worker/`.

AWS account: `797781631822` (not a secret, just an account ID — appears in the IAM ARNs below the same way `worker/wrangler.toml` commits its `ALLOWED_ORIGIN`). Region: `us-east-2` throughout.

## One-time setup

1. **AWS CLI + profile** — already done: `aws configure --profile myfirstbank`, verified with `aws sts get-caller-identity --profile myfirstbank`. Every command below assumes `--profile myfirstbank`.
2. **DynamoDB table**:
   ```
   aws dynamodb create-table --profile myfirstbank --region us-east-2 \
     --table-name myfirstbank-leads \
     --attribute-definitions AttributeName=lead_id,AttributeType=S \
     --key-schema AttributeName=lead_id,KeyType=HASH \
     --billing-mode PAY_PER_REQUEST
   ```
   On-demand billing — no idle/provisioned cost, appropriate for unpredictable low-volume lead traffic.
3. **`email-index` GSI** (partition key `email`, `KEYS_ONLY` projection — used only to check "does a row with this email already exist," never to read other fields back):
   ```
   aws dynamodb update-table --profile myfirstbank --region us-east-2 \
     --table-name myfirstbank-leads \
     --attribute-definitions AttributeName=email,AttributeType=S \
     --global-secondary-index-updates '[{"Create":{"IndexName":"email-index","KeySchema":[{"AttributeName":"email","KeyType":"HASH"}],"Projection":{"ProjectionType":"KEYS_ONLY"}}}]'
   ```
   Wait for it to go `ACTIVE` (`aws dynamodb describe-table ... --query 'Table.GlobalSecondaryIndexes[0].IndexStatus'`) before deploying code that queries it — a `Query` against a `CREATING` index fails.
4. **IAM role** (`iam/trust-policy.json` + `iam/permissions-policy.json` in this directory — least privilege, no wildcard resource: `PutItem`/`UpdateItem` on the base table, `Query` scoped to the `email-index` GSI's own ARN only, nothing broader — no `Scan`, no `DeleteItem`, no `Query`/`GetItem` on the base table itself):
   ```
   aws iam create-role --profile myfirstbank \
     --role-name myfirstbank-leads-lambda-role \
     --assume-role-policy-document file://lambda/iam/trust-policy.json

   aws iam put-role-policy --profile myfirstbank \
     --role-name myfirstbank-leads-lambda-role \
     --policy-name myfirstbank-leads-permissions \
     --policy-document file://lambda/iam/permissions-policy.json
   ```
5. **Package and create the function** (Node 20.x runtime — AWS's managed Node 18.x/20.x runtimes bundle AWS SDK v3, including `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb`, so no `node_modules`/`package.json` should be needed; **verify this at deploy time** — if `require`/`import` of those packages fails in CloudWatch logs, add a minimal `lambda/package.json` with just those two packages and zip with `node_modules` instead):
   ```
   cd lambda/src && zip -r ../function.zip . && cd ../..
   aws lambda create-function --profile myfirstbank --region us-east-2 \
     --function-name myfirstbank-leads-handler \
     --runtime nodejs20.x \
     --handler index.handler \
     --role arn:aws:iam::797781631822:role/myfirstbank-leads-lambda-role \
     --zip-file fileb://lambda/function.zip \
     --timeout 10 \
     --environment "Variables={TABLE_NAME=myfirstbank-leads,ALLOWED_ORIGIN=https://juanjochiarellar.github.io}"
   ```
   `BREVO_API_KEY` is deliberately left out of this first deploy — the handler skips all Brevo calls (and still writes every lead to DynamoDB normally) whenever it's unset. See "Brevo integration" below for adding it later.
6. **Function URL** (public endpoint, CORS locked to the real GitHub Pages origin, never `*`):
   ```
   aws lambda create-function-url-config --profile myfirstbank \
     --function-name myfirstbank-leads-handler \
     --auth-type NONE \
     --cors '{"AllowOrigins":["https://juanjochiarellar.github.io"],"AllowMethods":["POST"],"AllowHeaders":["Content-Type"]}'
   ```
   **`AuthType NONE` alone does not make the URL callable** — AWS also requires an explicit resource-based policy granting public invoke, as **two separate statements** (easy to miss; the console's own "Configuration → Function URL" tab surfaces a warning naming both if either is missing):
   ```
   aws lambda add-permission --profile myfirstbank --function-name myfirstbank-leads-handler \
     --action lambda:InvokeFunctionUrl --statement-id FunctionURLAllowPublicAccess \
     --principal "*" --function-url-auth-type NONE

   aws lambda add-permission --profile myfirstbank --function-name myfirstbank-leads-handler \
     --action lambda:InvokeFunction --statement-id FunctionURLAllowPublicInvoke \
     --principal "*" --invoked-via-function-url
   ```
   (`lambda:InvokeFunction`'s statement can't carry the `--function-url-auth-type` condition — that flag is only valid on the `InvokeFunctionUrl` action. Without both statements, every request — even from the right origin with a correct payload — gets AWS's own `403 {"Message":"Forbidden..."}` before your code ever runs, which looks identical to a code-level CORS rejection unless you know to check for it.)

   **`--invoked-via-function-url` is required, not optional** (AWS requirement as of October 2025): it adds `"Condition": {"Bool": {"lambda:InvokedViaFunctionUrl": "true"}}` to the statement, which restricts this `Principal: "*"` grant to invocations actually routed through the Function URL. Without it, `Principal: "*"` on `lambda:InvokeFunction` would let literally any AWS account call this function directly via the plain `Invoke` API with a hand-crafted event object — e.g. `{"headers":{"origin":"https://juanjochiarellar.github.io"}, "body": "..."}` — which would sail straight past the origin check in `src/index.mjs` (that check only reads a field from the event payload, which a direct caller fully controls) and past CORS entirely (CORS is a browser-only mechanism; a direct API call isn't a browser request). This was caught and fixed after initial deploy — if you ever have to recreate this statement, don't drop the flag.

   Prints the live Function URL. Paste that into `LAMBDA_URL` at the top of `js/stay-updated.js` back in the repo root, commit, and push — `stay-updated.html`'s form won't call the Lambda until that constant is filled in (it ships empty on purpose, with a visible "not connected yet" banner instead of a broken fetch — same precedent as `WORKER_URL` in `js/agent.js` before the Worker existed).

## Brevo integration (once the user supplies the API key)

```
aws lambda update-function-configuration --profile myfirstbank \
  --function-name myfirstbank-leads-handler \
  --environment "Variables={TABLE_NAME=myfirstbank-leads,ALLOWED_ORIGIN=https://juanjochiarellar.github.io,BREVO_API_KEY=<key>,BREVO_SENDER_EMAIL=<verified-sender@domain>,BREVO_SENDER_NAME=MyFirstBank,BREVO_SMS_SENDER=MyFirstBank}"
```
No code redeploy needed — `src/index.mjs` already contains the three Brevo calls, gated behind `BREVO_API_KEY` being non-empty. `BREVO_SENDER_EMAIL` must be a sender verified in the Brevo account, and `BREVO_SMS_SENDER` is capped at 11 alphanumeric characters by Brevo.

**Why a plain Lambda environment variable, not Secrets Manager**: acceptable here because the IAM boundary is already scoped to `myfirstbank-leads*` resources only (the `myfirstbank-leads` IAM user's policy), keeping the exposure surface minimal, and because this key doesn't need rotation-without-redeploy at this project's scale. Recommendation, not a hard rule: revisit Secrets Manager ($0.40/secret/month + API call cost) only if the key ever needs to rotate independently of a config update, or if the IAM boundary is ever widened beyond this one scoped user.

## What it does, end to end

1. Browser POSTs the 9 form fields (plus the honeypot field) as JSON to the Function URL (see `js/stay-updated.js`'s `submit()`).
2. `OPTIONS`/non-`POST` handled first (though in practice the Function URL's native CORS config answers real browser preflight before the function is ever invoked); then an **independent, fail-closed origin check**: a `403` if the real `Origin` header doesn't equal `ALLOWED_ORIGIN`. Unlike `worker/src/index.js`, this handler does **not** also set `Access-Control-Allow-Origin`/etc. itself — the Function URL's own CORS config already adds those to every response whose Origin matches, and adding them again from code produced a duplicate `Access-Control-Allow-Origin` header that real browsers (not `curl`) silently reject the whole response over. One source of truth for the CORS headers (the platform config), one independent source for the actual security check (the code) — see the comment above `baseHeaders()` in `src/index.mjs`.
3. **Honeypot check**: a filled `website` field means a bot bypassed the client-side skip in `js/stay-updated.js` entirely — the Lambda fake-succeeds (`200`, fresh throwaway `lead_id`) with no DynamoDB write and no Brevo calls, so a scripted bot gets no signal it was caught. This is deliberately distinct from a real validation failure (missing/invalid field, unchecked consent), which always returns a genuine `400` — the honeypot's silent-success treatment is reserved only for honeypot detection.
4. Real field validation (required fields, email format, state against the 51-entry list, `interested_in` non-empty and from the known 3 values, `consent_email_sms === true`) — genuine `400` on failure.
5. **Duplicate-email check**: `Query` against the `email-index` GSI. If a row already exists for this email, the handler stops here — no new `PutItem`, no Brevo calls — and returns `200 {ok:true, duplicate:true}`. This is deliberately the **same status code and shape-of-success** as a normal signup (never `409`), so a bot can't enumerate which emails are already registered by probing the endpoint and watching for a different status — `duplicate: true` is the only tell, and `js/stay-updated.js` shows it as an inline notice while keeping the form in place — deliberately not the full success screen, since nothing was actually created and the person may just have a typo in the email. If the `Query` itself fails (e.g. a transient DynamoDB issue), the handler logs it and falls through to treat this as a new signup rather than blocking a real user over an infrastructure hiccup.
6. `PutItem` the full record with `sent_communications: []`. This is the one write that has to succeed for the response to be a success — failure here returns `502` and nothing further is attempted.
7. Three Brevo calls, each independently wrapped in try/catch so one failure never blocks the next, each logged to CloudWatch on failure without aborting the rest: Contacts API upsert (create-or-update by email), transactional welcome email, transactional welcome SMS. `sent_communications` only gets `"welcome_email"` / `"welcome_sms"` appended when Brevo actually confirmed success for that specific call — not just attempted. This is what lets a future reminder-trigger Lambda (separate scope, not part of this build) check "has this been sent already?" reliably, and lets failures be audited directly in DynamoDB: a lead with `["welcome_email"]` but no `"welcome_sms"` means the SMS specifically failed, independent of whether the email succeeded.
8. Returns `200 {ok:true, lead_id}` as long as step 6 succeeded — Brevo failures never change the HTTP result the browser sees; they're only visible via `sent_communications` in DynamoDB.

## Security notes

- No credential (AWS keys, Brevo key) is ever committed — `lambda/.env` is gitignored (see repo root `.gitignore`), `lambda/.env.example` holds placeholders only, and the real `BREVO_API_KEY`/AWS credentials live only as a Lambda environment variable and in `~/.aws/credentials` respectively, never in this repo.
- CORS is locked to `https://juanjochiarellar.github.io` exactly via the Function URL's own CORS config, with an independent code-level origin check as the actual security boundary (see above). Verify with **both** `curl` (confirms the code-level check and the DynamoDB/Brevo flow) **and** a real browser (confirms the CORS headers themselves are valid — `curl` doesn't enforce or even notice a malformed/duplicated `Access-Control-Allow-Origin` header the way a real browser does).
- IAM permissions are scoped to exactly `dynamodb:PutItem`/`UpdateItem` on the base table's ARN, `dynamodb:Query` on the `email-index` GSI's own ARN only (not the base table — the handler never queries the table directly, only the index), and this one function's log group — verify the *effective* permissions actually match (e.g. `aws iam simulate-principal-policy` expecting `Scan`/`DeleteItem`/`GetItem` to come back `implicitDeny`), don't just trust that the policy JSON was applied correctly.
- The public Function URL's resource-based policy grants `Principal: "*"` on both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`, each scoped with a `Bool` condition on `lambda:InvokedViaFunctionUrl`/`lambda:FunctionUrlAuthType` — never grant `lambda:InvokeFunction` to `Principal: "*"` without that condition (see step 6 above); doing so would let any AWS account invoke the function directly via the plain `Invoke` API with a fabricated event, bypassing CORS and the origin check entirely (neither applies outside an actual Function-URL-routed browser request).

## Known limitation

`interest_note` is stored as a plain string, length-capped at 200 characters server-side, with no HTML sanitization at write time — there's no admin UI today that renders it. If a future admin dashboard displays this field, it must be escaped there (the same DOMPurify-style boundary `js/agent.js`'s markdown rendering already uses for model output), not assumed safe purely because it was length-capped at write time.
