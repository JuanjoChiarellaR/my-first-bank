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
    // See js/app.js's identical compareVersion comment — MFB.compare isn't
    // Alpine-reactive, so this bridges its onChange callback into a tracked
    // property that isInCompare() reads, making the "+ Compare" button's own
    // text update in place instead of only being correct after a reload.
    compareVersion: 0,

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
      MFB.compare.onChange(() => { this.compareVersion++; });
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

    compareError: "",
    isInCompare(productId) {
      void this.compareVersion; // establish an Alpine-tracked dependency
      return MFB.compare.isSelected(productId);
    },
    toggleCompare(productType, productId) {
      this.compareError = "";
      if (MFB.compare.isSelected(productId)) {
        MFB.compare.remove(productId);
        return;
      }
      const result = MFB.compare.add(productType, productId);
      if (!result.ok) this.compareError = result.reason;
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

    // Front-face fee label + value — every real bank product page labels its
    // headline number (see Phase 8c UX audit); a bare "$5/mo" with no caption
    // assumes the reader already knows what that number means.
    feeLabel(type) {
      if (type === "checking") return "Monthly maintenance fee";
      if (type === "savings") return "APY";
      if (type === "credit_card") return "Annual fee";
      return "";
    },
    feeValue(type, p) {
      if (type === "checking") {
        const base = this.fmtMoney(p.monthly_fee_usd);
        if (typeof p.monthly_fee_usd === "number" && p.monthly_fee_usd > 0 &&
            p.monthly_fee_waiver_conditions && p.monthly_fee_waiver_conditions.length) {
          return `${base} or $0`;
        }
        return p.monthly_fee_usd === 0 ? base : `${base}/mo`;
      }
      if (type === "savings") {
        return p.apy_current !== null && p.apy_current !== undefined ? `${p.apy_current}%` : "Not published";
      }
      if (type === "credit_card") {
        return this.fmtMoney(p.annual_fee_usd);
      }
      return "";
    },
    // 1-2 short, real highlight lines per product — pulled from data that
    // already exists (no new research needed), surfaced on the card front so
    // a user doesn't have to flip every card to see anything beyond the fee.
    cardHighlights(type, p) {
      const lines = [];
      if (type === "checking") {
        if (typeof p.monthly_fee_usd === "number" && p.monthly_fee_usd > 0 &&
            p.monthly_fee_waiver_conditions && p.monthly_fee_waiver_conditions.length) {
          lines.push(`Fee waived: ${MFB.humanizeTag(p.monthly_fee_waiver_conditions[0])}`);
        }
        if (p.overdraft_fee_usd === 0) lines.push("No overdraft fee");
        if (p.zelle_available) lines.push("Zelle included");
      } else if (type === "savings") {
        if (typeof p.monthly_fee_usd === "number" && p.monthly_fee_usd > 0 &&
            p.monthly_fee_waiver_conditions && p.monthly_fee_waiver_conditions.length) {
          lines.push(`Fee waived: ${MFB.humanizeTag(p.monthly_fee_waiver_conditions[0])}`);
        }
        if (p.monthly_fee_usd === 0) lines.push("No monthly fee");
        if (p.min_balance_required_usd === 0) lines.push("No minimum balance");
      } else if (type === "credit_card") {
        if (p.welcome_bonus_description) lines.push(p.welcome_bonus_description);
        if (p.rewards_rate_description) lines.push(p.rewards_rate_description);
        if (lines.length < 2 && p.card_benefits && p.card_benefits.length) lines.push(p.card_benefits[0]);
      }
      return lines.slice(0, 2);
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
    // Returns an array (not a joined string) so the template can render a
    // proper wrapped chip/bullet list instead of squeezing a comma-string
    // into a narrow right-aligned column. Values that are known tags
    // (monthly_fee_waiver_conditions, no_ssn_requirements) are humanized;
    // values that are already natural language (eligibility_requirements,
    // card_benefits, country names, etc.) pass through unchanged since
    // humanizeTag only rewrites known snake_case tags.
    fmtList(arr) {
      if (!arr || arr.length === 0) return [];
      return MFB.humanizeList(arr);
    },
  }));
});
