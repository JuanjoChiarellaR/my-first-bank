// Compare page. Entirely static/deterministic — no agent call happens here,
// per README.md. Field defs below define what CAN be shown; last_verified_date
// is always rendered and is not part of the optional selector.

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
      ]},
    ],
  },
};

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
    case "list": return Array.isArray(value) && value.length ? value.join(", ") : "None listed";
    case "text": return value || "Not published";
    default: return String(value);
  }
}

document.addEventListener("alpine:init", () => {
  Alpine.data("comparePage", () => ({
    loading: true,
    productType: null,
    products: [],
    selectedFieldKeys: [],

    async init() {
      await MFB.dataReady;
      this.syncFromStorage();
      MFB.compare.onChange(() => this.syncFromStorage());
      this.loading = false;
    },

    syncFromStorage() {
      const state = MFB.compare.get();
      this.productType = state.productType;
      this.products = state.productIds
        .map((id) => MFB.findProduct(id))
        .filter(Boolean)
        .map((p) => ({ ...p, bank: MFB.bankById[p.bank_id] }));
      if (this.productType && this.selectedFieldKeys.length === 0) {
        this.selectedFieldKeys = this.defaultFieldKeys();
      }
    },

    fieldDef() {
      return this.productType ? FIELD_DEFS[this.productType] : null;
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

    removeProduct(productId) {
      MFB.compare.remove(productId);
    },

    clearAll() {
      MFB.compare.clear();
      this.selectedFieldKeys = [];
    },

    productTypeLabel() {
      return { checking: "Checking accounts", savings: "Savings accounts", credit_card: "Credit cards" }[this.productType] || "";
    },

    askAgentHref() {
      const ids = this.products.map((p) => p.product_id).join(",");
      return `agent.html?compare=${encodeURIComponent(ids)}`;
    },
  }));
});
