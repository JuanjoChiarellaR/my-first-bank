// Fetches and caches /data/*.json once per page load, exposes them via window.MFB.data.
// All other scripts (app.js, agent.js) should `await MFB.dataReady` before reading MFB.data.

window.MFB = window.MFB || {};

const DATA_FILES = {
  banks: "data/banks.json",
  locations: "data/locations.json",
  checkingAccounts: "data/checking_accounts.json",
  savingsAccounts: "data/savings_accounts.json",
  creditCards: "data/credit_cards.json",
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
      return { label, amount: winner.monthly_fee_usd, last_verified_date: winner.last_verified_date, product_id: winner.product_id };
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
});
