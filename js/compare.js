// Compare page. Entirely static/deterministic — no agent call happens here,
// per README.md. Field defs below define what CAN be shown; last_verified_date
// is always rendered and is not part of the optional selector.
//
// Structure: 4 fixed column slots, always rendered, filled strictly left to
// right. MFB.compare (data-loader.js) stays the single persisted source of
// truth — {productType, productIds}, an ordered append-only array — and is
// untouched by this page's manual bank/product pickers, which only ever call
// its existing add()/remove()/clear().
//
// This page keeps its own `displayOrder` array (index -> product_id | null)
// as the thing that actually drives which visual column a product sits in.
// It's reconciled by VALUE against MFB.compare's stored productIds on every
// change (see syncFromStorage), not treated as index-identical to it — that
// split is what makes "remove just this column's product, keep its bank
// selected, don't disturb the other columns" possible: MFB.compare.remove()
// always compacts its own array, but a compaction there no longer forces a
// visual shift here unless this page explicitly performs one (see
// removeSlotEntirely, which does shift, vs. removeProductOnly, which
// deliberately doesn't).

const FIELD_DEFS = {
  checking: {
    groups: [
      { label: "Fees & Costs", fields: [
        { key: "monthly_fee_usd", label: "Monthly fee", fmt: "money", default: true },
        { key: "monthly_fee_waiver_conditions", label: "Fee waived if", fmt: "list", default: false },
        { key: "min_opening_deposit_usd", label: "Min. opening deposit", fmt: "money", default: false },
        { key: "min_balance_required_usd", label: "Min. balance required", fmt: "money", default: false },
        { key: "overdraft_fee_usd", label: "Overdraft fee", fmt: "money", default: true },
        { key: "overdraft_protection_available", label: "Overdraft protection", fmt: "bool", default: false },
        { key: "atm_fee_out_of_network_usd", label: "Out-of-network ATM fee", fmt: "money", default: false },
        { key: "atm_fee_reimbursement", label: "ATM fee reimbursed", fmt: "bool", default: false },
      ]},
      { label: "Account Features", fields: [
        { key: "interest_bearing", label: "Interest-bearing", fmt: "bool", default: false },
        { key: "apy", label: "APY", fmt: "pct", default: false },
        { key: "debit_card_included", label: "Debit card included", fmt: "bool", default: false },
        { key: "zelle_available", label: "Zelle available", fmt: "bool", default: false },
        { key: "can_open_online", label: "Can open online", fmt: "bool", default: true },
        { key: "requires_branch_visit", label: "Requires branch visit", fmt: "bool", default: false },
      ]},
      { label: "Eligibility", fields: [
        { key: "accepts_no_ssn", label: "Accepts no SSN", fmt: "bool", default: true },
        { key: "accepts_itin", label: "Accepts ITIN", fmt: "bool", default: true },
      ]},
      { label: "Benefits", fields: [
        { key: "welcome_bonus_description", label: "Welcome bonus", fmt: "text", default: false },
        { key: "programs", label: "Relationship / referral programs", fmt: "programs", default: false },
      ]},
    ],
  },
  savings: {
    groups: [
      { label: "Fees & Costs", fields: [
        { key: "monthly_fee_usd", label: "Monthly fee", fmt: "money", default: true },
        { key: "monthly_fee_waiver_conditions", label: "Fee waived if", fmt: "list", default: false },
        { key: "min_opening_deposit_usd", label: "Min. opening deposit", fmt: "money", default: false },
        { key: "min_balance_required_usd", label: "Min. balance required", fmt: "money", default: false },
      ]},
      { label: "Account Features", fields: [
        { key: "apy_current", label: "APY", fmt: "pct", default: true },
        { key: "fdic_insured", label: "FDIC insured", fmt: "bool", default: false },
        { key: "can_open_online", label: "Can open online", fmt: "bool", default: true },
        { key: "requires_branch_visit", label: "Requires branch visit", fmt: "bool", default: false },
      ]},
      { label: "Eligibility", fields: [
        { key: "accepts_no_ssn", label: "Accepts no SSN", fmt: "bool", default: true },
        { key: "accepts_itin", label: "Accepts ITIN", fmt: "bool", default: true },
      ]},
      { label: "Benefits", fields: [
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

// Field-selection persistence — keyed by product type, since checking's
// field vocabulary doesn't apply to savings/credit_card and vice versa.
// Without the per-type key, restoring a flat list after switching types
// would silently match nothing (filtered out in visibleFields()) and the
// table would look empty for no visible reason.
const FIELD_KEYS_STORAGE_KEY = "mfb_compare_fields_v1";
function loadFieldKeysByType() {
  try {
    const raw = localStorage.getItem(FIELD_KEYS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}
function saveFieldKeysForType(type, keys) {
  const all = loadFieldKeysByType();
  all[type] = keys;
  localStorage.setItem(FIELD_KEYS_STORAGE_KEY, JSON.stringify(all));
}

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
    displayOrder: [null, null, null, null], // index -> product_id | null; see file-level comment
    slotBankPending: [null, null, null, null], // index -> bank_id | null, only meaningful when displayOrder[index] is null
    pickError: "",
    selectedFieldKeys: [],
    slotIndices: [0, 1, 2, 3],

    async init() {
      await MFB.dataReady;
      this.syncFromStorage();
      // Applied explicitly here (not left to $watch) because syncFromStorage()
      // above may have just hydrated selectedType from MFB.compare's own
      // stored productType — a change that happens BEFORE $watch is
      // registered below, so $watch alone would never fire for it and a
      // returning user would see zero fields checked instead of their saved
      // ones (or defaults).
      this.applyFieldKeysForType();
      MFB.compare.onChange(() => this.syncFromStorage());
      this.$watch("selectedType", () => this.applyFieldKeysForType());
      // Persists on every toggle, keyed by the type active at the time —
      // this is the actual fix for selection not surviving navigation.
      this.$watch("selectedFieldKeys", (keys) => {
        if (this.selectedType) saveFieldKeysForType(this.selectedType, keys);
      });
      this.loading = false;
    },

    // Restores this type's saved field selection, or falls back to its
    // defaults if nothing was ever saved for it.
    applyFieldKeysForType() {
      if (!this.selectedType) { this.selectedFieldKeys = []; return; }
      const saved = loadFieldKeysByType()[this.selectedType];
      this.selectedFieldKeys = (saved && saved.length) ? saved : this.defaultFieldKeys();
    },

    syncFromStorage() {
      const state = MFB.compare.get();
      const stillPresent = new Set(state.productIds);
      // Drop any displayOrder entry whose product no longer exists in storage.
      this.displayOrder = this.displayOrder.map((id) => (id && stillPresent.has(id) ? id : null));
      // Add any stored product not yet represented, into the first free slot —
      // this is what makes Bank Detail's "+ Compare" button fill "the next
      // open slot" regardless of which slot the user was manually mid-picking.
      for (const id of state.productIds) {
        if (!this.displayOrder.includes(id)) {
          const emptyIndex = this.displayOrder.indexOf(null);
          if (emptyIndex !== -1) {
            this.displayOrder[emptyIndex] = id;
            this.slotBankPending[emptyIndex] = null;
          }
        }
      }
      if (!this.selectedType) this.selectedType = state.productType || "";
    },

    // --- 4-slot model ---------------------------------------------------
    get activeSlotIndex() {
      for (let i = 0; i < 4; i++) if (!this.displayOrder[i]) return i;
      return -1;
    },
    slotAt(index) {
      const id = this.displayOrder[index];
      if (!id) return { filled: false, product: null, mismatched: false };
      const raw = MFB.findProduct(id);
      if (!raw) return { filled: false, product: null, mismatched: false };
      const product = { ...raw, bank: MFB.bankById[raw.bank_id] };
      return { filled: true, product, mismatched: !!this.selectedType && product.product_type !== this.selectedType };
    },
    anyFilled() {
      return this.displayOrder.some(Boolean);
    },
    pendingBankName(index) {
      const bankId = this.slotBankPending[index];
      return bankId ? (MFB.bankById[bankId]?.name || bankId) : "";
    },

    // --- Manual picker (always targets the current active slot) ---------
    bankOptionsForPicker() {
      if (!this.selectedType) return [];
      return MFB.data.banks
        .filter((b) => (MFB.productsByBank(b.bank_id)[this.selectedType] || []).length > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    productOptionsForSlot(index) {
      const bankId = this.slotBankPending[index];
      if (!this.selectedType || !bankId) return [];
      return MFB.productsByBank(bankId)[this.selectedType] || [];
    },
    pickProduct(index, productId) {
      this.pickError = "";
      if (!productId) return;
      const result = MFB.compare.add(this.selectedType, productId);
      if (result.ok) {
        this.slotBankPending[index] = null; // slot is filled now — no longer "pending"
      } else {
        this.pickError = result.reason;
      }
    },
    // Clears the bank choice on a not-yet-filled slot, before any product
    // has been picked for it — reverts the active slot to the fully-empty
    // "choose a bank" state.
    clearPendingBank(index) {
      this.slotBankPending[index] = null;
    },
    // Clears just this slot's product, keeping its bank — the slot reverts
    // to "bank chosen, product picker open" rather than emptying entirely.
    // Deliberately does NOT shift other columns (contrast removeSlotEntirely).
    removeProductOnly(index) {
      const id = this.displayOrder[index];
      if (!id) return;
      const raw = MFB.findProduct(id);
      const bankId = raw ? raw.bank_id : null;
      MFB.compare.remove(id); // synchronously nulls displayOrder[index] via syncFromStorage
      this.slotBankPending[index] = bankId;
    },
    // Clears both bank and product for this slot, then shifts every later
    // filled slot left to close the gap — matches the site's existing
    // "column 3 shifts into column 2" removal behavior.
    removeSlotEntirely(index) {
      const id = this.displayOrder[index];
      if (id) MFB.compare.remove(id);
      this.slotBankPending[index] = null;
      for (let i = index; i < 3; i++) {
        this.displayOrder[i] = this.displayOrder[i + 1];
        this.slotBankPending[i] = this.slotBankPending[i + 1];
      }
      this.displayOrder[3] = null;
      this.slotBankPending[3] = null;
    },
    clearAll() {
      MFB.compare.clear();
      this.displayOrder = [null, null, null, null];
      this.slotBankPending = [null, null, null, null];
      // selectedFieldKeys is deliberately left as-is — clearing the product
      // selection isn't a reason to also forget the user's field
      // preferences for this type, which are persisted independently.
    },

    // --- Field selector (grouped, keyed by selectedType) -----------------
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
    // Table rows stay in FIELD_DEFS' fixed order (never insertion order),
    // grouped under the same labeled sections as the field selector — this
    // is what lets someone browse what categories of data exist, not just
    // find a field they already knew to look for.
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
