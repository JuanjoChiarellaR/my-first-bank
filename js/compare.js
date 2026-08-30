// Compare page. Entirely static/deterministic — no agent call happens here,
// per README.md. Field defs below define what CAN be shown; last_verified_date
// is always rendered and is not part of the optional selector.
//
// Structure: 4 fixed column slots, always rendered, filled strictly left to
// right. MFB.compare (data-loader.js) stays the single persisted source of
// truth — {productType, productIds}, an ordered append-only array — and is
// untouched by this page's manual bank/product pickers, which only ever call
// its existing add()/remove()/clear(). The "which bank/product am I picking
// for this still-empty slot" state is page-local and ephemeral on purpose:
// it never needs to survive a navigation away from this page.

const FIELD_DEFS = {
  checking: {
    groups: [
      { label: null, fields: [
        { key: "monthly_fee_usd", label: "Monthly fee", fmt: "money", default: true },
        { key: "monthly_fee_waiver_conditions", label: "Fee waived if", fmt: "list", default: false },
        { key: "min_opening_deposit_usd", label: "Min. opening deposit", fmt: "money", default: false },
        { key: "min_balance_required_usd", label: "Min. balance required", fmt: "money", default: false },
        { key: "interest_bearing", label: "Interest-bearing", fmt: "bool", default: false },
        { key: "apy", label: "APY", fmt: "pct", default: false },
        { key: "overdraft_fee_usd", label: "Overdraft fee", fmt: "money", default: true },
        { key: "overdraft_protection_available", label: "Overdraft protection", fmt: "bool", default: false },
        { key: "atm_fee_out_of_network_usd", label: "Out-of-network ATM fee", fmt: "money", default: false },
        { key: "atm_fee_reimbursement", label: "ATM fee reimbursed", fmt: "bool", default: false },
        { key: "debit_card_included", label: "Debit card included", fmt: "bool", default: false },
        { key: "zelle_available", label: "Zelle available", fmt: "bool", default: false },
        { key: "accepts_no_ssn", label: "Accepts no SSN", fmt: "bool", default: true },
        { key: "accepts_itin", label: "Accepts ITIN", fmt: "bool", default: true },
        { key: "can_open_online", label: "Can open online", fmt: "bool", default: true },
        { key: "requires_branch_visit", label: "Requires branch visit", fmt: "bool", default: false },
        { key: "welcome_bonus_description", label: "Welcome bonus", fmt: "text", default: false },
        { key: "programs", label: "Relationship / referral programs", fmt: "programs", default: false },
      ]},
    ],
  },
  savings: {
    groups: [
      { label: null, fields: [
        { key: "apy_current", label: "APY", fmt: "pct", default: true },
        { key: "fdic_insured", label: "FDIC insured", fmt: "bool", default: false },
        { key: "monthly_fee_usd", label: "Monthly fee", fmt: "money", default: true },
        { key: "monthly_fee_waiver_conditions", label: "Fee waived if", fmt: "list", default: false },
        { key: "min_opening_deposit_usd", label: "Min. opening deposit", fmt: "money", default: false },
        { key: "min_balance_required_usd", label: "Min. balance required", fmt: "money", default: false },
        { key: "accepts_no_ssn", label: "Accepts no SSN", fmt: "bool", default: true },
        { key: "accepts_itin", label: "Accepts ITIN", fmt: "bool", default: true },
        { key: "can_open_online", label: "Can open online", fmt: "bool", default: true },
        { key: "requires_branch_visit", label: "Requires branch visit", fmt: "bool", default: false },
        { key: "welcome_bonus_description", label: "Welcome bonus", fmt: "text", default: false },
        { key: "programs", label: "Relationship / referral programs", fmt: "programs", default: false },
      ]},
    ],
  },
  credit_card: {
    groups: [
      { label: "Eligibility", fields: [
        { key: "annual_fee_usd", label: "Annual fee", fmt: "money", default: true },
        { key: "apr_range", label: "APR range", fmt: "apr_range", default: true },
        { key: "foreign_transaction_fee_pct", label: "Foreign transaction fee", fmt: "pct", default: false },
        { key: "eligibility_requirements", label: "Eligibility requirements", fmt: "list", default: true },
        { key: "requires_ssn", label: "Requires SSN", fmt: "bool", default: true },
        { key: "accepts_itin", label: "Accepts ITIN", fmt: "bool", default: false },
        { key: "accepts_no_us_credit_history", label: "No US credit history OK", fmt: "bool", default: true },
        { key: "bureaus", label: "Reports to bureaus", fmt: "bureaus", default: false },
      ]},
      { label: "Benefits", fields: [
        { key: "rewards_type", label: "Rewards type", fmt: "text", default: true },
        { key: "rewards_rate_description", label: "Rewards rate", fmt: "text", default: false },
        { key: "points_or_miles_per_dollar", label: "Points/miles per $", fmt: "raw", default: false },
        { key: "redemption_options", label: "Redemption options", fmt: "list", default: false },
        { key: "annual_rewards_cap_usd", label: "Annual rewards cap", fmt: "money", default: false },
        { key: "card_benefits", label: "Card benefits", fmt: "list", default: false },
        { key: "welcome_bonus_description", label: "Welcome bonus", fmt: "text", default: false },
        { key: "programs", label: "Relationship / referral programs", fmt: "programs", default: false },
      ]},
    ],
  },
};

const TYPE_LABELS = { checking: "Checking accounts", savings: "Savings accounts", credit_card: "Credit cards" };

function formatValue(fmt, value, product) {
  if (fmt === "apr_range") {
    const min = product.apr_regular_min, max = product.apr_regular_max;
    if (min === null && max === null) return "Not published";
    return `${min ?? "?"}–${max ?? "?"}%`;
  }
  if (fmt === "bureaus") {
    const list = [
      product.reports_to_equifax && "Equifax",
      product.reports_to_experian && "Experian",
      product.reports_to_transunion && "TransUnion",
    ].filter(Boolean);
    return list.length ? list.join(", ") : "Not published";
  }
  if (value === null || value === undefined) return "Not published";
  switch (fmt) {
    case "money": return value === 0 ? "$0" : `$${value}`;
    case "pct": return `${value}%`;
    case "bool": return value ? "Yes" : "No";
    // Humanized (not raw .join) — same tag dictionary the static pages and
    // the agent's semantic layer use, so "Fee waived if" never regresses to
    // snake_case tags here even though the other list fields (eligibility
    // requirements, benefits) are already natural language and pass through
    // MFB.humanizeTag unchanged.
    case "list": {
      const list = MFB.humanizeList(value);
      return list.length ? list.join(", ") : "None listed";
    }
    case "text": return value || "Not published";
    default: return String(value);
  }
}

document.addEventListener("alpine:init", () => {
  Alpine.data("comparePage", () => ({
    loading: true,
    selectedType: "", // "" | checking | savings | credit_card — page-local, hydrated once from storage then never overwritten by it
    productIds: [], // reactive mirror of MFB.compare.get().productIds — MFB.compare itself lives outside Alpine's reactivity, so templates must read this copy, not the store directly (see js/app.js / js/bank-detail.js for the same pattern)
    pickerBankId: "", // ephemeral: bank chosen for whichever slot is currently the first empty one
    pickError: "",
    selectedFieldKeys: [],
    slotIndices: [0, 1, 2, 3],

    async init() {
      await MFB.dataReady;
      this.syncFromStorage();
      MFB.compare.onChange(() => this.syncFromStorage());
      this.$watch("selectedType", (value, oldValue) => {
        if (!value) return;
        if (oldValue) this.selectedFieldKeys = this.defaultFieldKeys(); // real type switch — old field keys don't apply
        else if (this.selectedFieldKeys.length === 0) this.selectedFieldKeys = this.defaultFieldKeys(); // first-ever selection
      });
      this.loading = false;
    },

    syncFromStorage() {
      const state = MFB.compare.get();
      this.productIds = state.productIds;
      if (!this.selectedType) this.selectedType = state.productType || "";
    },

    // --- 4-slot model ---------------------------------------------------
    get firstEmptySlotIndex() {
      for (let i = 0; i < 4; i++) if (!this.productIds[i]) return i;
      return -1;
    },
    slotAt(index) {
      const id = this.productIds[index];
      if (!id) return { filled: false, product: null, mismatched: false };
      const raw = MFB.findProduct(id);
      if (!raw) return { filled: false, product: null, mismatched: false };
      const product = { ...raw, bank: MFB.bankById[raw.bank_id] };
      return { filled: true, product, mismatched: !!this.selectedType && product.product_type !== this.selectedType };
    },
    anyFilled() {
      return this.productIds.length > 0;
    },

    // --- Manual picker (always targets the current first-empty slot) ----
    bankOptionsForPicker() {
      if (!this.selectedType) return [];
      return MFB.data.banks
        .filter((b) => (MFB.productsByBank(b.bank_id)[this.selectedType] || []).length > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    productOptionsForPicker() {
      if (!this.selectedType || !this.pickerBankId) return [];
      return MFB.productsByBank(this.pickerBankId)[this.selectedType] || [];
    },
    pickProduct(productId) {
      this.pickError = "";
      if (!productId) return;
      const result = MFB.compare.add(this.selectedType, productId);
      if (result.ok) {
        this.pickerBankId = "";
      } else {
        // Shouldn't normally happen — the dropdowns are pre-scoped to
        // selectedType — but MFB.compare.add() is the real source of truth
        // for the max-4 rule, so surface its reason rather than assuming.
        this.pickError = result.reason;
      }
    },
    removeProduct(productId) {
      MFB.compare.remove(productId);
      this.pickerBankId = "";
    },
    clearAll() {
      MFB.compare.clear();
      this.pickerBankId = "";
      this.selectedFieldKeys = [];
    },

    // --- Field selector (unchanged logic, keyed by selectedType) --------
    fieldDef() {
      return this.selectedType ? FIELD_DEFS[this.selectedType] : null;
    },
    defaultFieldKeys() {
      const def = this.fieldDef();
      if (!def) return [];
      return def.groups.flatMap((g) => g.fields.filter((f) => f.default).map((f) => f.key));
    },
    isFieldSelected(key) {
      return this.selectedFieldKeys.includes(key);
    },
    toggleField(key) {
      if (this.selectedFieldKeys.includes(key)) {
        this.selectedFieldKeys = this.selectedFieldKeys.filter((k) => k !== key);
      } else {
        this.selectedFieldKeys = [...this.selectedFieldKeys, key];
      }
    },
    visibleFields() {
      const def = this.fieldDef();
      if (!def) return [];
      return def.groups
        .map((g) => ({ label: g.label, fields: g.fields.filter((f) => this.selectedFieldKeys.includes(f.key)) }))
        .filter((g) => g.fields.length > 0);
    },

    cellValue(field, product) {
      return formatValue(field.fmt, product[field.key], product);
    },
    // For "list"/"programs" fields, the table renders wrapped chips instead
    // of a comma-joined string — same humanizer as Bank Detail, so a "Fee
    // waived if" cell reads as real phrases, not tags.
    cellList(field, product) {
      if (field.fmt === "programs") return this.programsForProduct(product);
      return MFB.humanizeList(product[field.key]);
    },
    // Same relationship_programs/referral_program matching logic as
    // js/bank-detail.js's programBadgesFor — bank-level data (product.bank),
    // not a plain product[field.key] lookup like every other Compare field.
    programsForProduct(product) {
      const bank = product.bank;
      if (!bank) return [];
      const badges = [];
      (bank.relationship_programs || []).forEach((rp) => {
        const matches = rp.applies_to_product_ids
          ? rp.applies_to_product_ids.includes(product.product_id)
          : (rp.applies_to_product_types || []).includes(product.product_type);
        if (matches) badges.push(`Part of: ${rp.name}`);
      });
      const referralPrograms = Array.isArray(bank.referral_program) ? bank.referral_program : (bank.referral_program ? [bank.referral_program] : []);
      const hasReferral = referralPrograms.some((rp) => (rp.terms || []).some((t) => (t.applies_to || []).includes(product.product_type)));
      if (hasReferral) badges.push("Referral bonus available");
      return badges;
    },

    productTypeLabel() {
      return TYPE_LABELS[this.selectedType] || "";
    },

    askAgentHref() {
      const ids = this.slotIndices
        .map((i) => this.slotAt(i))
        .filter((s) => s.filled && !s.mismatched)
        .map((s) => s.product.product_id);
      return `agent.html?compare=${encodeURIComponent(ids.join(","))}`;
    },
  }));
});
