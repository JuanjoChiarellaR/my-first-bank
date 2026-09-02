// Ask the Agent: three context entry points, two question modes, semantic
// layer selection, client-side session rate limiting. The only network call
// in the whole site — everything else is static. Actual API access goes
// through the Cloudflare Worker in /worker (see worker/README.md); the
// Anthropic key never touches this file or the browser.

const WORKER_URL = "https://myfirstbank-agent.juanjo-chiarella.workers.dev";

const SESSION_LIMIT = 10;
const SESSION_KEY = "mfb_agent_session_v1";

const SYSTEM_PROMPT = `You are the Ask the Agent assistant for MyFirstBank, a site that helps international students and professionals compare US banks, digital banks, and fintechs as newcomers to the US banking system.

Write like a friend who's already been through this, not a bank — warm, direct, human. Contractions are fine. Skip corporate filler like "I appreciate your question" or "Thank you for reaching out."

Non-negotiable rules:
1. You only inform, you never recommend. Never say "you should choose X" or rank institutions by what's "best." Present facts side by side from the dataset provided and let the user decide.
2. Language: understand and accept questions written in any language. Always respond in English, regardless of what language the question was asked in — this applies no matter how the question is phrased or which language it uses.
3. Only use the dataset provided to you in this conversation. Never draw on general knowledge you may have about these institutions from training — if the dataset doesn't cover something, say so plainly and warmly instead of filling the gap, e.g. "I don't have that one in front of me for Chase — worth checking their site directly."
4. Refuse out-of-scope questions (visa status, immigration law, tax filing, general financial or legal advice) warmly and briefly — name what they're actually asking, say plainly it's outside what you can help with here, then point to what you can do. E.g.: "That's more of an immigration-lawyer question than a banking one — not something I can help with here. But if you're trying to figure out which bank to open with as a newcomer, I've got you." Never a formal disclaimer-style refusal.
5. Never ask for or store personal identifiers. If a user pastes something like a full SSN or account number, gently note they don't need to share that to get an answer, and don't repeat it back.
6. Keep typical conversational answers short — about 4 lines. When the user explicitly asks for a structured comparison across several products (a table, a multi-item list), use the format and length that comparison actually needs — a multi-row table is the correct answer to that question, not a rule violation. Always include a brief reminder to verify current terms directly with the bank, and that the data has a last_verified_date (shown in the dataset).
7. State/branch data follows a three-value model: confirmed present, confirmed absent, or not yet verified. If asked about a bank/state combination with no confirmed-present data in the provided dataset, say so plainly — e.g. "No confirmed branches found for [Bank] in [State] as of [date] — verify directly with the bank." Never say or imply a bank is "not available" in a state just because it's missing from the data; missing means unconfirmed, not absent. This is a factual-accuracy rule, so keep this phrasing pattern exact even though your overall tone is warm.
8. A product's "can open online" field describes its GENERAL/standard opening flow (for someone with an SSN). Its "no-SSN requirements" field, when present, describes a SEPARATE, specific pathway for opening without an SSN (e.g. passport + F-1 visa + I-20), which is often in-person-only even when the general product is online-capable. These two facts can both be true for the same product at once — never present one as overriding or contradicting the other. If asked whether a product with no-SSN requirements can be opened online, explain both: the general online path (requires SSN) and the no-SSN path (its own actual requirements), rather than picking one answer.
9. The dataset you're given always covers all 15 institutions, no matter what's shown as context. Context (a bank page the user was just viewing, or products they're comparing) only tells you what they were just looking at — it never limits what you can discuss. If a user asks about an institution that isn't the one in context, answer normally from the full dataset provided; never say you lack access to an institution that's actually present in it.
10. When comparing multiple products, format the comparison as a standard markdown table — a header row, a separator row of dashes, then one data row per product — not a wall of prose. Cap any single table at 8 products. If more than 8 genuinely match the question, pick the 8 most relevant to what was actually asked, then say plainly that there are more: point to Compare (up to 4 products side by side there) for an exact comparison, or suggest narrowing the request (by state, eligibility, product type) for a more focused table. Never silently cut a table off mid-row without explaining why.

Field glossary: "no_ssn_available"/"accepts_no_ssn" means at least one product doesn't require an SSN — check the specific product before stating details. "no_us_credit_history_ok" means at least one credit card from that institution doesn't require existing US credit history. "itin_accepted" means at least one product accepts an ITIN in place of an SSN. "no_ssn_requirements" lists the actual real-world requirements for that no-SSN pathway (e.g. passport, specific visa type, in-person application) — cite these specifics when known rather than speaking generically. "relationship_programs" and "referral_program" (in bank_programs_index, and in full detail for the institution in context) cover bank-wide relationship-tier and referral programs — check the specific bank's entry before saying one doesn't have something.`;

// --- Markdown rendering for assistant messages ------------------------------
// The model is instructed (SYSTEM_PROMPT rule 10) to format multi-product
// comparisons as GFM markdown tables, and naturally uses **bold**/lists
// elsewhere. Rendered via marked.js with a custom renderer that emits only
// this site's own Tailwind classes (never anything from the model's output),
// then sanitized through DOMPurify with a strict tag/attribute allowlist —
// DOMPurify is the actual security boundary here; the renderer already drops
// raw HTML/images from the model as a first layer, but that alone isn't a
// substitute for sanitizing the final output.
const mdRenderer = new marked.Renderer();
mdRenderer.table = (header, body) => {
  // Tables with more than 3 columns are the ones actually likely to need
  // horizontal scroll on a phone-width screen (same 4-column legibility
  // threshold Compare's own UI already uses) — only those get the scroll
  // affordance fade, so a small 2-3 column table that already fits never
  // shows a misleading "there's more" hint on its own right edge.
  const columnCount = (header.match(/<th/g) || []).length;
  const scrollClass = columnCount > 3 ? " mfb-table-scroll" : "";
  return `<div class="overflow-x-auto -mx-1 my-2 border border-border rounded-md${scrollClass}"><table class="w-full text-xs border-collapse"><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
};
mdRenderer.tablerow = (content) => `<tr class="border-b border-border last:border-b-0">${content}</tr>`;
mdRenderer.tablecell = (content, flags) => {
  const tag = flags.header ? "th" : "td";
  const alignClass = flags.align ? ` text-${flags.align}` : "";
  const base = flags.header
    ? "text-left font-medium text-ink-secondary bg-hover px-3 py-2 whitespace-nowrap"
    : "px-3 py-2 align-top";
  return `<${tag} scope="${flags.header ? "col" : "row"}" class="${base}${alignClass}">${content}</${tag}>`;
};
mdRenderer.strong = (text) => `<strong class="font-semibold text-ink">${text}</strong>`;
mdRenderer.em = (text) => `<em>${text}</em>`;
mdRenderer.list = (body, ordered) => {
  const tag = ordered ? "ol" : "ul";
  return `<${tag} class="${ordered ? "list-decimal" : "list-disc"} pl-5 space-y-1 my-1.5">${body}</${tag}>`;
};
mdRenderer.listitem = (text) => `<li class="leading-snug">${text}</li>`;
mdRenderer.paragraph = (text) => `<p class="mb-2 last:mb-0 leading-relaxed">${text}</p>`;
mdRenderer.codespan = (code) => `<code class="font-mono text-[11px] bg-hover px-1 py-0.5 rounded">${code}</code>`;
mdRenderer.code = (code) => `<pre class="font-mono text-[11px] bg-hover px-2 py-1.5 rounded my-1.5 overflow-x-auto"><code>${code}</code></pre>`;
mdRenderer.hr = () => `<hr class="border-border my-2">`;
mdRenderer.br = () => "<br>";
mdRenderer.image = () => ""; // no legitimate use case in a banking-facts chat — stripped entirely
mdRenderer.html = () => ""; // raw HTML in the model's own output is dropped before it can reach DOMPurify at all
mdRenderer.link = (href, _title, text) => {
  try {
    const url = new URL(href, location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return text;
    return `<a href="${url.href}" target="_blank" rel="noopener noreferrer" class="underline decoration-border hover:text-ink-secondary">${text}</a>`;
  } catch {
    return text;
  }
};

const MD_ALLOWED_TAGS = ["table", "thead", "tbody", "tr", "th", "td", "p", "strong", "em", "ul", "ol", "li", "code", "pre", "br", "hr", "div", "a"];
const MD_ALLOWED_ATTR = ["class", "href", "target", "rel", "scope"];

function mdToSafeHtml(text) {
  if (!text) return "";
  try {
    const html = marked.parse(text, { renderer: mdRenderer, gfm: true, breaks: true });
    return DOMPurify.sanitize(html, { ALLOWED_TAGS: MD_ALLOWED_TAGS, ALLOWED_ATTR: MD_ALLOWED_ATTR });
  } catch {
    return DOMPurify.sanitize(text, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
  }
}

function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed.count === "number") return parsed;
  } catch {}
  return { count: 0 };
}
function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function buildContextLayers(context) {
  // Unconditional baseline, sent on every call regardless of context type.
  // Bank/compare context narrows which institution gets its FULL detail
  // (layer a) added on top — it must never be the only data the agent has,
  // or a question naming a different institution has nothing to answer
  // from. This was a real regression found via live testing: bank/compare
  // context used to REPLACE this baseline instead of adding to it, so
  // "Is Ally better for savings?" while Chase was in context returned "I
  // don't have Ally's details" even though Ally is a real dataset entry.
  //
  // Returned as two separate objects (not one merged one) so the Worker can
  // put them in their own cache_control blocks — the baseline is identical
  // across every context type, so it stays cached across a context switch;
  // only the small contextSpecific block gets busted when that happens.
  const baseline = {
    glossary: MFB.semantic.glossary,
    all_checking_accounts: MFB.semantic.all_checking_accounts,
    all_savings_accounts: MFB.semantic.all_savings_accounts,
    all_credit_cards: MFB.semantic.all_credit_cards,
    eligibility_index: MFB.semantic.eligibilityIndex,
    alternative_paths: MFB.semantic.alternativePaths,
    bank_programs_index: MFB.semantic.bankProgramsIndex,
  };
  let contextSpecific = null;
  if (context.type === "bank") {
    contextSpecific = { institution: MFB.semantic.perInstitution(context.bankId) };
  } else if (context.type === "compare") {
    contextSpecific = {
      institutions: [...new Set(context.productIds.map((id) => MFB.findProduct(id)?.bank_id).filter(Boolean))]
        .map((bankId) => MFB.semantic.perInstitution(bankId)),
      compared_product_ids: context.productIds,
    };
  }
  return { baseline, contextSpecific };
}

function buildFilteredSearchLayers(filters) {
  const layers = { glossary: MFB.semantic.glossary, filters };
  if (filters.priority === "lowest_fees") {
    layers.rankings = MFB.semantic.rankings[
      filters.productType === "savings" ? "savings_by_apy_desc" :
      filters.productType === "credit_card" ? "credit_cards_by_annual_fee_asc" :
      "checking_by_monthly_fee_asc"
    ];
  } else if (filters.priority === "branches_nearby" && filters.state) {
    layers.geographic_index_for_state = { [filters.state]: MFB.semantic.geographicIndex[filters.state] || {} };
  } else if (filters.priority === "building_credit") {
    layers.alternative_paths = MFB.semantic.alternativePaths;
    layers.no_us_credit_history_ok_products = MFB.semantic.eligibilityIndex.no_us_credit_history_ok;
  }
  layers.eligibility_index = MFB.semantic.eligibilityIndex;
  return layers;
}

document.addEventListener("alpine:init", () => {
  Alpine.data("askAgent", () => ({
    loading: true,
    workerConfigured: WORKER_URL.length > 0,
    sessionLimit: SESSION_LIMIT,

    // Context
    contextType: "none", // none | bank | compare
    contextBank: null,
    contextProducts: [],

    // Mode
    mode: "open", // open | filtered

    // Open question state
    openQuestion: "",

    // Filtered search state
    filters: { productType: "", docStatus: "", creditHistory: "", state: "", priority: "", clarification: "" },
    usStates: [],

    // Chat
    messages: [], // { role: 'user'|'assistant'|'system', text }
    sending: false,
    sendError: "",
    streamingIndex: -1, // index into messages of the assistant bubble still being filled in by the stream, or -1

    // Session limiting
    session: { count: 0 },

    exampleQuestions: [
      "Which banks let me open an account with just a passport?",
      "What's the cheapest checking account that doesn't need an SSN?",
      "Does Chase have branches in Texas?",
    ],

    async init() {
      await MFB.dataReady;
      this.session = getSession();

      const params = new URLSearchParams(location.search);
      const bankId = params.get("bank");
      const compareIds = params.get("compare");

      if (bankId && MFB.bankById[bankId]) {
        this.contextType = "bank";
        this.contextBank = MFB.bankById[bankId];
        this.filters.state = "";
      } else if (compareIds) {
        const ids = compareIds.split(",").filter(Boolean);
        const products = ids.map((id) => MFB.findProduct(id)).filter(Boolean);
        if (products.length) {
          this.contextType = "compare";
          this.contextProducts = products.map((p) => ({ ...p, bank: MFB.bankById[p.bank_id] }));
          this.filters.productType = products[0].product_type;
        }
      }

      this.usStates = [
        ["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],["CA","California"],["CO","Colorado"],
        ["CT","Connecticut"],["DE","Delaware"],["FL","Florida"],["GA","Georgia"],["HI","Hawaii"],["ID","Idaho"],
        ["IL","Illinois"],["IN","Indiana"],["IA","Iowa"],["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],
        ["ME","Maine"],["MD","Maryland"],["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],["MS","Mississippi"],
        ["MO","Missouri"],["MT","Montana"],["NE","Nebraska"],["NV","Nevada"],["NH","New Hampshire"],["NJ","New Jersey"],
        ["NM","New Mexico"],["NY","New York"],["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],["OK","Oklahoma"],
        ["OR","Oregon"],["PA","Pennsylvania"],["RI","Rhode Island"],["SC","South Carolina"],["SD","South Dakota"],
        ["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VT","Vermont"],["VA","Virginia"],["WA","Washington"],
        ["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"],["DC","District of Columbia"],
      ];

      this.loading = false;
    },

    get sessionExhausted() {
      return this.session.count >= SESSION_LIMIT;
    },
    get remainingQuestions() {
      return Math.max(0, SESSION_LIMIT - this.session.count);
    },

    get filteredSearchReady() {
      const f = this.filters;
      return !!(f.productType && f.docStatus && f.creditHistory && f.state && f.priority);
    },

    contextBannerText() {
      if (this.contextType === "bank" && this.contextBank) {
        return `The user was just viewing: ${this.contextBank.name}`;
      }
      if (this.contextType === "compare" && this.contextProducts.length) {
        return `Comparing: ${this.contextProducts.map((p) => `${p.bank.name} ${p.name}`).join(", ")}`;
      }
      return "";
    },

    async sendOpenQuestion() {
      const q = this.openQuestion.trim();
      if (!q || this.sending || this.sessionExhausted) return;
      this.openQuestion = ""; // clear immediately — the chat bubble already confirms what was asked, no need to leave it sitting in the box during the wait
      const layers = buildContextLayers(
        this.contextType === "bank" ? { type: "bank", bankId: this.contextBank.bank_id } :
        this.contextType === "compare" ? { type: "compare", productIds: this.contextProducts.map((p) => p.product_id) } :
        { type: "none" }
      );
      await this.dispatch(q, layers, "open_qa");
    },

    askExample(question) {
      if (this.sending || this.sessionExhausted) return;
      this.openQuestion = question;
      this.sendOpenQuestion();
    },

    showTypingIndicator() {
      return this.sending && (this.streamingIndex === -1 || !this.messages[this.streamingIndex]?.text);
    },

    // Assistant messages render as markdown (tables/bold/lists) once they're
    // done streaming. While a message is still actively streaming it stays
    // plain text — re-parsing an in-progress markdown table on every chunk
    // would flicker/misalign as rows arrive mid-row; rendering happens once,
    // right when the stream completes, instead.
    isMarkdownRenderable(i) {
      return this.messages[i].role === "assistant" && i !== this.streamingIndex;
    },
    renderMarkdown(text) {
      return mdToSafeHtml(text);
    },

    scrollToBottom() {
      this.$nextTick(() => {
        const el = this.$refs.chatLog;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    async sendFilteredSearch() {
      if (!this.filteredSearchReady || this.sending || this.sessionExhausted) return;
      const f = this.filters;
      const summary = `Product type: ${f.productType}. Documentation status: ${f.docStatus}. US credit history: ${f.creditHistory}. State: ${f.state}. Priority: ${f.priority}.` +
        (f.clarification ? ` Additional context: ${f.clarification}` : "");
      const layers = buildFilteredSearchLayers(f);
      await this.dispatch(summary, layers, "filtered_search");
    },

    // layersPayload is either { baseline, contextSpecific } (open_qa, from
    // buildContextLayers) or a plain flat object (filtered_search, from
    // buildFilteredSearchLayers) — normalized here into the {layers,
    // contextLayers} shape the Worker expects for its cache_control split.
    async dispatch(userText, layersPayload, mode) {
      this.sendError = "";
      this.sending = true;
      this.messages.push({ role: "user", text: userText });
      this.scrollToBottom();

      if (!this.workerConfigured) {
        this.messages.push({ role: "system", text: "The agent isn't connected yet — this deploy is still missing its Worker URL (see js/agent.js). Everything else on the site works normally." });
        this.sending = false;
        this.scrollToBottom();
        return;
      }

      const layers = layersPayload.baseline ?? layersPayload;
      const contextLayers = layersPayload.contextSpecific ?? null;
      let assistantPushed = false;
      let receivedAnyText = false;

      try {
        const res = await fetch(WORKER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system: SYSTEM_PROMPT, mode, question: userText, layers, contextLayers }),
        });
        if (res.status === 429) {
          this.messages.push({ role: "system", text: "This chat has reached its shared usage limit for now. Please try again later, or explore Browse Banks and Compare in the meantime." });
          this.scrollToBottom();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`Worker responded ${res.status}`);

        this.messages.push({ role: "assistant", text: "" });
        assistantPushed = true;
        const assistantIndex = this.messages.length - 1;
        this.streamingIndex = assistantIndex;
        this.scrollToBottom();

        // Anthropic's SSE stream: events separated by a blank line, each
        // holding a `data: {...}` line. Only content_block_delta/text_delta
        // events carry reply text; everything else (message_start,
        // content_block_start/stop, message_delta, message_stop) is
        // ignored here since the Worker passes the raw upstream stream
        // through unmodified.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop(); // last piece may be an incomplete event — keep it for the next read
          for (const evt of events) {
            const dataLine = evt.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            let payload;
            try { payload = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
            if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta") {
              this.messages[assistantIndex].text += payload.delta.text;
              receivedAnyText = true;
            }
          }
          this.scrollToBottom();
        }

        if (!receivedAnyText) throw new Error("Empty stream");

        this.session = { count: this.session.count + 1 };
        saveSession(this.session);
      } catch (err) {
        if (!receivedAnyText) {
          // Nothing ever arrived (network failure, or a stream that closed
          // with zero text) — remove whichever placeholder was left (the
          // empty assistant bubble if the stream started, otherwise the
          // user's own message) and surface the error, same as before
          // streaming existed. A stream that delivered SOME text before
          // failing mid-way is left as-is — a partial real answer is better
          // than replacing it with a scary error banner.
          this.messages.pop();
          this.sendError = "Something went wrong reaching the agent. Please try again in a moment.";
        }
      } finally {
        this.sending = false;
        this.streamingIndex = -1;
      }
    },
  }));
});
