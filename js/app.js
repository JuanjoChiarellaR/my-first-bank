// Browse Banks page (index.html). Bank Detail and Compare get their own
// Alpine components added in later phases; this file currently only needs
// to run on index.html but is safe to include anywhere data-loader.js runs.

const US_STATES = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"],
  ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"],
  ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"],
  ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
  ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"],
  ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
  ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"],
  ["WI", "Wisconsin"], ["WY", "Wyoming"], ["DC", "District of Columbia"],
];

const TYPE_LABELS = {
  traditional_bank: "Traditional bank",
  digital_bank: "Digital bank",
  fintech: "Fintech",
  credit_history_bridge: "Credit history service",
};

document.addEventListener("alpine:init", () => {
  Alpine.data("browseBanks", () => ({
    loading: true,
    banks: [],
    usStates: US_STATES,
    mobileFiltersOpen: false,

    filters: {
      productType: "any", // any | checking | savings | credit_card
      docStatus: "any", // any | no_ssn | itin | no_credit_history
      state: "any",
    },

    async init() {
      await MFB.dataReady;
      this.banks = MFB.data.banks;
      this.loading = false;
    },

    typeLabel(type) {
      return TYPE_LABELS[type] || type;
    },

    badgesFor(bank) {
      const badges = [];
      if (bank.has_product_without_ssn) badges.push("No SSN needed");
      if (bank.has_product_with_itin) badges.push("ITIN accepted");
      if (bank.has_product_no_us_credit_history_required) badges.push("Building credit OK");
      return badges;
    },

    representativeFee(bankId) {
      return MFB.representativeFee(bankId);
    },

    matchesFilters(bank) {
      if (bank.type === "credit_history_bridge") {
        // Nova Credit has no products/branches — only ever shown when filters are untouched.
        return this.filters.productType === "any" && this.filters.docStatus === "any" && this.filters.state === "any";
      }

      if (this.filters.productType !== "any") {
        const products = MFB.productsByBank(bank.bank_id)[this.filters.productType];
        if (!products || products.length === 0) return false;
      }

      if (this.filters.docStatus === "no_ssn" && !bank.has_product_without_ssn) return false;
      if (this.filters.docStatus === "itin" && !bank.has_product_with_itin) return false;
      if (this.filters.docStatus === "no_credit_history" && !bank.has_product_no_us_credit_history_required) return false;

      if (this.filters.state !== "any") {
        const status = MFB.stateStatus(bank.bank_id, this.filters.state);
        if (status !== "present") return false;
      }

      return true;
    },

    get filteredBanks() {
      return this.banks.filter((b) => this.matchesFilters(b));
    },

    resetFilters() {
      this.filters = { productType: "any", docStatus: "any", state: "any" };
    },
  }));
});
