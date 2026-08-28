// Ask the Agent: three context entry points, two question modes, semantic
// layer selection, client-side session rate limiting. The only network call
// in the whole site — everything else is static. Actual API access goes
// through the Cloudflare Worker in /worker (see worker/README.md); the
// Anthropic key never touches this file or the browser.

// TODO(deploy): set this to the deployed Worker's URL (Phase 11).
// e.g. "https://mfb-agent.<your-subdomain>.workers.dev"
const WORKER_URL = "";

const SESSION_LIMIT = 10;
const SESSION_KEY = "mfb_agent_session_v1";

const SYSTEM_PROMPT = `You are the Ask the Agent assistant for MyFirstBank, a site that helps international students and professionals compare US banks, digital banks, and fintechs as newcomers to the US banking system.

Non-negotiable rules:
1. You only inform, you never recommend. Never say "you should choose X" or rank institutions by what's "best." Present facts side by side from the dataset provided and let the user decide.
2. Language: understand and accept questions written in any language. Always respond in English, regardless of what language the question was asked in — this applies no matter how the question is phrased or which language it uses.
3. Only use the dataset provided to you in this conversation. Never draw on general knowledge you may have about these institutions from training — if the dataset doesn't cover something, say so plainly instead of filling the gap.
4. Refuse out-of-scope questions politely (visa status, immigration law, tax filing, general financial or legal advice) and redirect to what you can help with: banking product information from this dataset.
5. Never ask for or store personal identifiers. If a user pastes something like a full SSN or account number, gently note they don't need to share that to get an answer, and don't repeat it back.
6. Keep responses short — about 4 lines. Always include a brief reminder to verify current terms directly with the bank, and that the data has a last_verified_date (shown in the dataset).
7. State/branch data follows a three-value model: confirmed present, confirmed absent, or not yet verified. If asked about a bank/state combination with no confirmed-present data in the provided dataset, say so plainly — e.g. "No confirmed branches found for [Bank] in [State] as of [date] — verify directly with the bank." Never say or imply a bank is "not available" in a state just because it's missing from the data; missing means unconfirmed, not absent.
8. A product's `can_open_online` describes its GENERAL/standard opening flow (for someone with an SSN). `no_ssn_requirements`, when present, describes a SEPARATE, specific pathway for opening without an SSN (e.g. passport + F-1 visa + I-20), which is often in-person-only even when the general product is online-capable. These two facts can both be true for the same product at once — never present one as overriding or contradicting the other. If asked whether a product with `no_ssn_requirements` can be opened online, explain both: the general online path (requires SSN) and the no-SSN path (its own actual requirements), rather than picking one answer.

Field glossary: "no_ssn_available"/"accepts_no_ssn" means at least one product doesn't require an SSN — check the specific product before stating details. "no_us_credit_history_ok" means at least one credit card from that institution doesn't require existing US credit history. "itin_accepted" means at least one product accepts an ITIN in place of an SSN. "no_ssn_requirements" lists the actual real-world requirements for that no-SSN pathway (e.g. passport, specific visa type, in-person application) — cite these specifics when known rather than speaking generically.`;

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
  const layers = { glossary: MFB.semantic.glossary };
  if (context.type === "bank") {
    layers.institution = MFB.semantic.perInstitution(context.bankId);
  } else if (context.type === "compare") {
    layers.institutions = [...new Set(context.productIds.map((id) => MFB.findProduct(id)?.bank_id).filter(Boolean))]
      .map((bankId) => MFB.semantic.perInstitution(bankId));
    layers.compared_product_ids = context.productIds;
  } else {
    // No context: open comparative questions need the cross-institution
    // index, eligibility index, and the alternative-path grouping — not
    // every institution's full product catalog.
    layers.all_checking_accounts = MFB.semantic.all_checking_accounts;
    layers.all_savings_accounts = MFB.semantic.all_savings_accounts;
    layers.all_credit_cards = MFB.semantic.all_credit_cards;
    layers.eligibility_index = MFB.semantic.eligibilityIndex;
    layers.alternative_paths = MFB.semantic.alternativePaths;
  }
  return layers;
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

    // Session limiting
    session: { count: 0 },

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
      const layers = buildContextLayers(
        this.contextType === "bank" ? { type: "bank", bankId: this.contextBank.bank_id } :
        this.contextType === "compare" ? { type: "compare", productIds: this.contextProducts.map((p) => p.product_id) } :
        { type: "none" }
      );
      await this.dispatch(q, layers, "open_qa");
      this.openQuestion = "";
    },

    async sendFilteredSearch() {
      if (!this.filteredSearchReady || this.sending || this.sessionExhausted) return;
      const f = this.filters;
      const summary = `Product type: ${f.productType}. Documentation status: ${f.docStatus}. US credit history: ${f.creditHistory}. State: ${f.state}. Priority: ${f.priority}.` +
        (f.clarification ? ` Additional context: ${f.clarification}` : "");
      const layers = buildFilteredSearchLayers(f);
      await this.dispatch(summary, layers, "filtered_search");
    },

    async dispatch(userText, layers, mode) {
      this.sendError = "";
      this.sending = true;
      this.messages.push({ role: "user", text: userText });

      if (!this.workerConfigured) {
        this.messages.push({ role: "system", text: "The agent isn't connected yet — this deploy is still missing its Worker URL (see js/agent.js). Everything else on the site works normally." });
        this.sending = false;
        return;
      }

      try {
        const res = await fetch(WORKER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system: SYSTEM_PROMPT, mode, question: userText, layers }),
        });
        if (res.status === 429) {
          this.messages.push({ role: "system", text: "This chat has reached its shared usage limit for now. Please try again later, or explore Browse Banks and Compare in the meantime." });
          return;
        }
        if (!res.ok) throw new Error(`Worker responded ${res.status}`);
        const data = await res.json();
        this.messages.push({ role: "assistant", text: data.reply || "(no response)" });
        this.session = { count: this.session.count + 1 };
        saveSession(this.session);
      } catch (err) {
        this.sendError = "Something went wrong reaching the agent. Please try again in a moment.";
        this.messages.pop();
      } finally {
        this.sending = false;
      }
    },
  }));
});
