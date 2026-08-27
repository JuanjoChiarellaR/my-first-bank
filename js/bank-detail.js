// Bank Detail pages (banks/{bank_id}.html). Every bank detail page loads this
// same script; the bank_id is read from the current file name so all 15 pages
// share one implementation instead of 15 hand-duplicated copies.

const TYPE_LABELS = {
  traditional_bank: "Traditional bank",
  digital_bank: "Digital bank",
  fintech: "Fintech",
  credit_history_bridge: "Credit history service",
};

const PRODUCT_TYPE_LABELS = {
  checking: "Checking accounts",
  savings: "Savings accounts",
  credit_card: "Credit cards",
};

document.addEventListener("alpine:init", () => {
  Alpine.data("bankDetail", () => ({
    bankId: "",
    bank: null,
    notFound: false,
    products: { checking: [], savings: [], credit_card: [] },
    loading: true,
    flipped: {},

    async init() {
      this.bankId = location.pathname.split("/").pop().replace(".html", "");
      await MFB.dataReady;
      this.bank = MFB.bankById[this.bankId] || null;
      if (this.bank) {
        this.products = MFB.productsByBank(this.bankId);
        document.title = `${this.bank.name} — MyFirstBank`;
      } else {
        this.notFound = true;
      }
      this.loading = false;
    },

    typeLabel(type) {
      return TYPE_LABELS[type] || type;
    },
    productTypeLabel(type) {
      return PRODUCT_TYPE_LABELS[type] || type;
    },

    toggleFlip(productId) {
      this.flipped[productId] = !this.flipped[productId];
    },
    isFlipped(productId) {
      return !!this.flipped[productId];
    },

    // Top states by confirmed branch count, respecting the three-value model —
    // only ever lists confirmed-present entries, never a confirmed-absent or
    // not-yet-verified one.
    topStates(limit = 8) {
      const states = MFB.data.locations[this.bankId]?.states || {};
      return Object.entries(states)
        .filter(([, v]) => v.branches > 0)
        .sort((a, b) => b[1].branches - a[1].branches)
        .slice(0, limit);
    },

    eligibilityBadges() {
      if (!this.bank) return [];
      const badges = [];
      if (this.bank.has_product_without_ssn) badges.push("No SSN needed");
      if (this.bank.has_product_with_itin) badges.push("ITIN accepted");
      if (this.bank.has_product_no_us_credit_history_required) badges.push("Building credit OK");
      return badges;
    },

    fmtMoney(n) {
      if (n === null || n === undefined) return "Not published";
      return n === 0 ? "$0" : `$${n}`;
    },
    fmtPct(n) {
      if (n === null || n === undefined) return "Not published";
      return `${n}%`;
    },
    fmtBool(b) {
      if (b === null || b === undefined) return "Not published";
      return b ? "Yes" : "No";
    },
    fmtList(arr) {
      if (!arr || arr.length === 0) return "None listed";
      return arr.join(", ");
    },
  }));
});
