# Agent proxy Worker

Cloudflare Worker that proxies Ask the Agent's calls to the Anthropic API. Holds the Anthropic API key as a `wrangler secret` (never in this repo), restricts CORS to the live GitHub Pages origin, and enforces a per-IP rate limit independent of the client-side session cap. Built in Phase 8, deployed separately via `wrangler deploy` — not served by GitHub Pages.
