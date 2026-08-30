// Fetches and caches /data/*.json once per page load, exposes them via window.MFB.data.
// All other scripts (app.js, agent.js) should `await MFB.dataReady` before reading MFB.data.

window.MFB = window.MFB || {};

// Every page but the bank-detail pages (banks/{bank_id}.html) lives at the
// site root, so root-relative asset paths like "data/banks.json" only work
// one directory deep — not a hardcoded "/" prefix either, since a GitHub
// Pages *project* site is served from a subpath, not the domain root.
MFB.basePath = location.pathname.includes("/banks/") ? "../" : "";

const DATA_FILES = {
  banks: `${MFB.basePath}data/banks.json`,
  locations: `${MFB.basePath}data/locations.json`,
  checkingAccounts: `${MFB.basePath}data/checking_accounts.json`,
  savingsAccounts: `${MFB.basePath}data/savings_accounts.json`,
  creditCards: `${MFB.basePath}data/credit_cards.json`,
};

MFB.data = {
  banks: [],
  locations: {},
  checkingAccounts: [],
  savingsAccounts: [],
  creditCards: [],
};

MFB.dataReady = (async () => {
  const entries = Object.entries(DATA_FILES);
  const results = await Promise.all(
    entries.map(([, path]) =>
      fetch(path).then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
        return res.json();
      })
    )
  );
  entries.forEach(([key], i) => {
    MFB.data[key] = results[i];
  });
  return MFB.data;
})();

// Convenience lookups built after data loads.
MFB.dataReady.then(() => {
  MFB.bankById = Object.fromEntries(MFB.data.banks.map((b) => [b.bank_id, b]));

  MFB.productsByBank = (bankId) => ({
    checking: MFB.data.checkingAccounts.filter((p) => p.bank_id === bankId),
    savings: MFB.data.savingsAccounts.filter((p) => p.bank_id === bankId),
    credit_card: MFB.data.creditCards.filter((p) => p.bank_id === bankId),
  });

  MFB.allProductsByType = {
    checking: MFB.data.checkingAccounts,
    savings: MFB.data.savingsAccounts,
    credit_card: MFB.data.creditCards,
  };

  // Representative fee rule (see data/RESEARCH_NOTES.md): lowest monthly_fee_usd
  // among a bank's checking products, "Checking from $X/mo". Falls back to
  // savings if the bank has no checking products with a known fee. Returns the
  // winning product's own last_verified_date so the UI never shows a fee and a
  // date that don't actually belong to the same record.
  MFB.representativeFee = (bankId) => {
    const pick = (list, label) => {
      const withFee = list.filter((p) => p.bank_id === bankId && typeof p.monthly_fee_usd === "number");
      if (withFee.length === 0) return null;
      const winner = withFee.reduce((min, p) => (p.monthly_fee_usd < min.monthly_fee_usd ? p : min));
      return {
        label,
        type: label === "Checking" ? "checking" : "savings",
        amount: winner.monthly_fee_usd,
        name: winner.name,
        last_verified_date: winner.last_verified_date,
        product_id: winner.product_id,
      };
    };
    return pick(MFB.data.checkingAccounts, "Checking") || pick(MFB.data.savingsAccounts, "Savings");
  };

  // Three-value state model (see README.md / RESEARCH_NOTES.md): returns
  // "present" | "absent" | "unverified" — callers must never collapse
  // "absent"/"unverified" into the same UI meaning as "present", but both of
  // those two non-present cases share the same safe copy per the copy rule.
  MFB.stateStatus = (bankId, stateCode) => {
    const bank = MFB.bankById[bankId];
    if (!bank) return "unverified";
    const entry = MFB.data.locations[bankId]?.states?.[stateCode];
    if (entry) return entry.branches > 0 ? "present" : "absent";
    if (bank.state_coverage_completeness === "not_applicable_no_branches") {
      // Digital-first/no-branch institutions are reachable from any state online.
      return bank.coverage === "national" ? "present" : "unverified";
    }
    return "unverified";
  };

  MFB.unconfirmedStateCopy = (bankName, stateCode, asOfDate) =>
    `No confirmed branches found for ${bankName} in ${stateCode} as of ${asOfDate} — verify directly with the bank.`;

  MFB.findProduct = (productId) =>
    MFB.data.checkingAccounts.find((p) => p.product_id === productId) ||
    MFB.data.savingsAccounts.find((p) => p.product_id === productId) ||
    MFB.data.creditCards.find((p) => p.product_id === productId) ||
    null;
});

// Compare selection — persisted to localStorage so an accidental reload
// doesn't lose it. Comparisons only ever hold one product type at a time and
// max 4 products, per the Compare page spec.
(function () {
  const STORAGE_KEY = "mfb_compare_v1";
  const MAX_ITEMS = 4;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { productType: null, productIds: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.productIds)) return { productType: null, productIds: [] };
      return parsed;
    } catch {
      return { productType: null, productIds: [] };
    }
  }

  function save(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  let state = load();
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn(state));

  MFB.compare = {
    get: () => state,
    count: () => state.productIds.length,
    isSelected: (productId) => state.productIds.includes(productId),
    onChange: (fn) => listeners.add(fn),

    // Returns { ok: true } or { ok: false, reason } — callers should surface
    // `reason` to the user rather than failing silently.
    add(productType, productId) {
      if (state.productIds.length >= MAX_ITEMS) {
        return { ok: false, reason: `You can compare up to ${MAX_ITEMS} products at a time.` };
      }
      if (state.productType && state.productType !== productType && state.productIds.length > 0) {
        return { ok: false, reason: "Comparisons only work within one product type at a time. Clear your current comparison first." };
      }
      if (state.productIds.includes(productId)) {
        return { ok: true };
      }
      state = { productType, productIds: [...state.productIds, productId] };
      save(state);
      notify();
      return { ok: true };
    },

    remove(productId) {
      const productIds = state.productIds.filter((id) => id !== productId);
      state = { productType: productIds.length ? state.productType : null, productIds };
      save(state);
      notify();
    },

    clear() {
      state = { productType: null, productIds: [] };
      save(state);
      notify();
    },
  };
})();

// Tag humanizer — data/*.json stores monthly_fee_waiver_conditions and
// no_ssn_requirements as machine-friendly snake_case tags (so the eligibility
// index and rankings can check them programmatically), but they must never
// render raw to a user or reach the agent's context unhumanized. Every page
// AND the agent's semantic layer (js/semantic-layer.js) route through this.
(function () {
  // Every tag currently in data/*.json (checking_accounts.json,
  // savings_accounts.json). Verified complete against the dataset as of the
  // 2026-08 Phase 8b pass — if a future data refresh adds a new tag, it
  // won't be here yet and will fall through to the generic formatter below,
  // which is why that fallback exists rather than assuming this list stays
  // exhaustive forever.
  const TAG_DICTIONARY = {
    "$250_or_more_in_enhanced_direct_deposits_per_month": "Enhanced direct deposits of $250+/month",
    "10_plus_transactions_per_cycle": "10+ debit card transactions per cycle",
    "account_owner_age_17_to_24": "Account owner ages 17–24",
    "account_owner_under_age_25": "Account owner under age 25",
    "age_13_24_or_65_plus": "Ages 13–24, or 65+",
    "age_17_to_24": "Ages 17–24",
    "age_24_or_under": "Age 24 or under",
    "age_62_plus": "Age 62+",
    "age_under_18": "Under age 18",
    "age_under_24": "Under age 24",
    "age_under_25": "Under age 25",
    "age_under_25_or_62_plus": "Under age 25, or 62+",
    "auto_savings_transfer_25_plus_monthly": "Automatic savings transfer of $25+/month",
    "auto_transfer_25_monthly_or_1_daily": "Automatic transfer of $25/month or $1/day",
    "auto_transfer_25_plus_monthly": "Automatic transfer of $25+/month",
    "average_beginning_day_balance_15000_plus": "Average beginning-of-day balance of $15,000+",
    "average_daily_balance_10000_plus": "Average daily balance of $10,000+",
    "average_daily_balance_2500_plus": "Average daily balance of $2,500+",
    "average_daily_balance_7500_plus": "Average daily balance of $7,500+",
    "balance_15000_plus": "Balance of $15,000+",
    "balance_1500_daily": "Daily balance of $1,500+",
    "balance_300": "Balance of $300+",
    "balance_300_daily": "Daily balance of $300+",
    "balance_300_daily_ledger": "Daily ledger balance of $300+",
    "balance_500_average_monthly": "Average monthly balance of $500+",
    "balance_500_daily": "Daily balance of $500+",
    "balance_500_plus": "Balance of $500+",
    "bank_of_america_preferred_rewards_member": "Bank of America Preferred Rewards member",
    "beginning_day_balance_15000_plus": "Beginning-of-day balance of $15,000+",
    "combined_average_monthly_balance_200000_plus": "Combined average monthly balance of $200,000+",
    "combined_balance_10000_plus_linked_pnc_accounts": "Combined balance of $10,000+ across linked PNC accounts",
    "combined_balance_150000_plus_in_linked_deposits_or_investments": "Combined balance of $150,000+ in linked deposits or investments",
    "combined_balance_20000_plus": "Combined balance of $20,000+",
    "combined_balance_25000_plus": "Combined balance of $25,000+",
    "combined_balance_2000_plus_spend_reserve": "Combined balance of $2,000+ in Spend + Reserve",
    "combined_balance_25000_plus_all_consumer_investment_accounts": "Combined balance of $25,000+ across all consumer & investment accounts",
    "combined_balance_25000_plus_personal_deposit_investment_or_credit_balances": "Combined balance of $25,000+ in personal deposit, investment, or credit balances",
    "combined_balance_30000_plus": "Combined balance of $30,000+",
    "combined_balance_500": "Combined balance of $500+",
    "combined_balance_5000_plus": "Combined balance of $5,000+",
    "combined_balance_5000_plus_spend_reserve": "Combined balance of $5,000+ in Spend + Reserve",
    "combined_balance_500_spend_reserve": "Combined balance of $500+ in Spend + Reserve",
    "combined_qualifying_balances_20000_plus": "Combined qualifying balances of $20,000+",
    "combined_qualifying_balances_250000_plus": "Combined qualifying balances of $250,000+",
    "deposits_500_plus_per_cycle": "Deposits of $500+ per cycle",
    "deposits_investments_100000": "Deposits & investments of $100,000+",
    "direct_deposit_1500_plus": "Direct deposit of $1,500+/month",
    "direct_deposit_2000_plus": "Direct deposit of $2,000+/month",
    "direct_deposit_250_plus": "Direct deposit of $250+/month",
    "direct_deposit_250_plus_or_qualifying_transactions": "Direct deposit of $250+/month, or qualifying transactions",
    "direct_deposit_5000_plus": "Direct deposit of $5,000+/month",
    "direct_deposit_500_plus": "Direct deposit of $500+/month",
    "direct_deposit_any_amount": "Any direct deposit",
    "electronic_deposits_250_plus_per_fee_period": "Electronic deposits of $250+ per fee period",
    "electronic_deposits_250_plus_per_statement_period": "Electronic deposits of $250+ per statement period",
    "first_3_months_new_customers": "Waived for new customers' first 3 months",
    "first_6_months_new_customers": "Waived for new customers' first 6 months",
    "hsbc_us_mortgage_500000_plus": "HSBC US mortgage of $500,000+",
    "link_citibank_checking": "Linked Citibank checking account",
    "link_qualifying_checking_account": "Linked qualifying checking account",
    "linked_chase_first_mortgage_with_autopay": "Linked Chase first mortgage with autopay",
    "linked_chase_premier_plus_sapphire_or_private_client_checking": "Linked Chase Premier Plus, Sapphire, or Private Client Checking",
    "linked_eligible_td_checking_account": "Linked eligible TD checking account",
    "linked_eligible_wells_fargo_checking_account": "Linked eligible Wells Fargo checking account",
    "linked_mt_checking_account": "Linked M&T checking account",
    "linked_premium_checking": "Linked premium checking account",
    "linked_qualifying_chase_checking_or_savings_account": "Linked qualifying Chase checking or savings account",
    "linked_smartly_checking_or_safe_debit_or_smartly_visa_signature_card": "Linked Smartly Checking, Safe Debit, or Smartly Visa Signature card",
    "linked_td_checking_recurring_transfer_25_first_12_months": "Linked TD checking with a $25+ recurring transfer (first 12 months)",
    "linked_truist_checking": "Linked Truist checking account",
    "min_daily_balance_100": "Minimum daily balance of $100",
    "min_daily_balance_10000": "Minimum daily balance of $10,000",
    "min_daily_balance_300": "Minimum daily balance of $300",
    "min_daily_balance_500": "Minimum daily balance of $500",
    "min_daily_balance_2500": "Minimum daily balance of $2,500",
    "minimum_daily_balance_10000_plus": "Minimum daily balance of $10,000+",
    "minimum_daily_balance_3500": "Minimum daily balance of $3,500",
    "minimum_daily_balance_500": "Minimum daily balance of $500",
    "monthly_direct_deposit_5000": "Monthly direct deposit of $5,000+",
    "one_deposit_per_cycle": "At least one deposit per cycle",
    "one_or_more_transactions_per_cycle": "One or more transactions per cycle",
    "preferred_rewards_enrollment": "Enrolled in Preferred Rewards",
    "primary_account_holder_age_13_to_17": "Primary account holder ages 13–17",
    "primary_account_holder_age_17_to_23": "Primary account holder ages 17–23",
    "primary_holder_18_or_under": "Primary holder age 18 or under",
    "primary_holder_62_or_older": "Primary holder age 62 or older",
    "primary_holder_age_17_to_23": "Primary holder ages 17–23",
    "primary_owner_age_13_to_24": "Primary owner ages 13–24",
    "private_banking_status": "Private Banking client status",
    "qualifying_military_deposits": "Qualifying military deposits",
    "qualifying_military_direct_deposit": "Qualifying military direct deposit",
    "qualifying_mt_checking_account": "Linked qualifying M&T checking account",
    "recurring_transfer_25_plus_monthly": "Recurring transfer of $25+/month",
    "relationship_tier_qualification": "Qualifying relationship tier",
    "save_as_you_go": "Enrolled in Save As You Go",
    "servicemember_or_veteran_with_military_id": "Servicemember or veteran with military ID",
    "smart_rewards_gold_platinum_tier": "Smart Rewards Gold or Platinum tier",
    "smartly_checking_gold_tier_or_higher": "Smartly Checking Gold tier or higher",
    "smartly_visa_signature_card_owner": "Have a Smartly Visa Signature card",
    "student_status": "Verified student status",
    "student_under_25": "Student under age 25",
    "truist_credit_card_loan_or_business_checking": "Have a Truist credit card, loan, or business checking account",
    "under_18": "Under age 18",
    "us_bank_trust_services_relationship": "U.S. Bank Trust Services relationship",
    "waived_first_2_statement_periods": "Waived automatically for the first 2 statement periods",

    // no_ssn_requirements tags
    "passport": "Passport",
    "visa": "Valid visa",
    "F-1 or J-1 visa": "F-1 or J-1 visa",
    "I-20": "I-20",
    "I-20 or DS-2019": "I-20 or DS-2019",
    "in_person_application_required": "In-person application required",
    "hsbc_premier_bank_before_you_land_program": "Part of HSBC Premier's \"bank before you land\" program",
    "requires_existing_hsbc_premier_checking_relationship": "Requires an existing HSBC Premier checking relationship",
  };

  const MINOR_WORDS = new Set(["a", "an", "the", "of", "or", "and", "to", "in", "with", "per"]);

  // Safety net for any tag not yet in the dictionary above (e.g. a future
  // data refresh) — never lets a raw snake_case tag reach the screen or the
  // agent, even if nobody remembered to add it to TAG_DICTIONARY yet.
  function fallbackHumanize(tag) {
    let s = String(tag).replace(/_/g, " ").trim();
    s = s.replace(/(\d[\d,]*)\s*plus\b/gi, "$$$1+");
    s = s
      .split(" ")
      .map((w, i) => (i > 0 && MINOR_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(" ");
    return s;
  }

  // humanizeTag is safe to call on ANY string, not just known tags —
  // eligibility_requirements, card_benefits, redemption_options, and Nova
  // Credit's country lists are already natural language and must pass
  // through unchanged. Real tags never contain a space (they use
  // underscores) or a raw string already used as an exact dictionary key
  // (e.g. "F-1 or J-1 visa"), so anything that already reads like a
  // sentence — or is already in the dictionary verbatim — is left alone;
  // the space-free-snake_case fallback only fires on genuine tag shapes.
  MFB.humanizeTag = (tag) => {
    if (Object.prototype.hasOwnProperty.call(TAG_DICTIONARY, tag)) return TAG_DICTIONARY[tag];
    if (typeof tag === "string" && tag.includes(" ")) return tag; // already natural language
    return fallbackHumanize(tag);
  };
  MFB.humanizeList = (arr) => (Array.isArray(arr) ? arr.map(MFB.humanizeTag) : []);
})();
