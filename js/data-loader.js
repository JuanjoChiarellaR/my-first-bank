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
  // savings if the bank has no checking products with a known fee.
  MFB.representativeFee = (bankId) => {
    const checking = MFB.data.checkingAccounts.filter(
      (p) => p.bank_id === bankId && typeof p.monthly_fee_usd === "number"
    );
    if (checking.length > 0) {
      const min = Math.min(...checking.map((p) => p.monthly_fee_usd));
      return { label: "Checking", amount: min };
    }
    const savings = MFB.data.savingsAccounts.filter(
      (p) => p.bank_id === bankId && typeof p.monthly_fee_usd === "number"
    );
    if (savings.length > 0) {
      const min = Math.min(...savings.map((p) => p.monthly_fee_usd));
      return { label: "Savings", amount: min };
    }
    return null;
  };
});
