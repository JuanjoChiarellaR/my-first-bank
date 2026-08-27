// Builds the 8-layer semantic view of the dataset for Ask the Agent, all
// derived client-side from data/*.json (no separate hand-maintained copies,
// except the static glossary). See README.md "Semantic layer" for the design
// rationale — this keeps the agent reading pre-resolved facts instead of
// cross-referencing raw JSON or doing its own math at question time.
//
// Every layer preserves the null-vs-false discipline from the source data:
// an unverified state or field never collapses into "not eligible" or
// "not present" just to make an index cleaner.

MFB.dataReady.then(() => {
  const { banks, locations, checkingAccounts, savingsAccounts, creditCards } = MFB.data;

  function bankName(bankId) {
    return MFB.bankById[bankId]?.name || bankId;
  }

  // --- (a) Per-institution view -------------------------------------------
  function perInstitution(bankId) {
    const bank = MFB.bankById[bankId];
    if (!bank) return null;
    if (bank.type === "credit_history_bridge") {
      return {
        bank_id: bank.bank_id,
        name: bank.name,
        type: bank.type,
        description: bank.description,
        supported_source_countries: bank.supported_source_countries,
        destination_markets: bank.destination_markets,
        known_us_partners_accepting_report: bank.known_us_partners_accepting_report,
      };
    }
    const products = MFB.productsByBank(bankId);
    const statePresence = {};
    const states = locations[bankId]?.states || {};
    Object.entries(states).forEach(([code, entry]) => {
      if (entry.branches > 0) statePresence[code] = entry.branches;
    });
    return {
      bank_id: bank.bank_id,
      name: bank.name,
      type: bank.type,
      eligibility_summary: {
        no_ssn_available: bank.has_product_without_ssn,
        itin_accepted: bank.has_product_with_itin,
        no_us_credit_history_ok: bank.has_product_no_us_credit_history_required,
      },
      state_coverage_completeness: bank.state_coverage_completeness,
      state_presence: statePresence,
      products: {
        checking: products.checking.map(compactProduct),
        savings: products.savings.map(compactProduct),
        credit_card: products.credit_card.map(compactCreditCard),
      },
    };
  }

  function compactProduct(p) {
    return {
      product_id: p.product_id,
      name: p.name,
      monthly_fee_usd: p.monthly_fee_usd,
      apy: p.apy_current ?? p.apy ?? null,
      accepts_no_ssn: p.accepts_no_ssn ?? null,
      accepts_itin: p.accepts_itin ?? null,
      can_open_online: p.can_open_online,
      last_verified_date: p.last_verified_date,
    };
  }

  function compactCreditCard(p) {
    return {
      product_id: p.product_id,
      name: p.name,
      annual_fee_usd: p.annual_fee_usd,
      apr_regular_min: p.apr_regular_min,
      apr_regular_max: p.apr_regular_max,
      requires_ssn: p.requires_ssn,
      accepts_itin: p.accepts_itin,
      accepts_no_us_credit_history: p.accepts_no_us_credit_history,
      rewards_rate_description: p.rewards_rate_description,
      last_verified_date: p.last_verified_date,
    };
  }

  // --- (b) Cross-institution product-type index ---------------------------
  const all_checking_accounts = checkingAccounts.map((p) => ({
    bank_id: p.bank_id, bank_name: bankName(p.bank_id), product_id: p.product_id, name: p.name,
    monthly_fee_usd: p.monthly_fee_usd, accepts_no_ssn: p.accepts_no_ssn, accepts_itin: p.accepts_itin,
    can_open_online: p.can_open_online, last_verified_date: p.last_verified_date,
  }));
  const all_savings_accounts = savingsAccounts.map((p) => ({
    bank_id: p.bank_id, bank_name: bankName(p.bank_id), product_id: p.product_id, name: p.name,
    apy_current: p.apy_current, accepts_no_ssn: p.accepts_no_ssn, accepts_itin: p.accepts_itin,
    can_open_online: p.can_open_online, last_verified_date: p.last_verified_date,
  }));
  const all_credit_cards = creditCards.map((p) => ({
    bank_id: p.bank_id, bank_name: bankName(p.bank_id), product_id: p.product_id, name: p.name,
    annual_fee_usd: p.annual_fee_usd, apr_regular_min: p.apr_regular_min, apr_regular_max: p.apr_regular_max,
    requires_ssn: p.requires_ssn, accepts_itin: p.accepts_itin, accepts_no_us_credit_history: p.accepts_no_us_credit_history,
    last_verified_date: p.last_verified_date,
  }));

  // --- (c) Precomputed eligibility index -----------------------------------
  const eligibilityIndex = {
    no_ssn_accepted: [
      ...checkingAccounts.filter((p) => p.accepts_no_ssn === true).map((p) => p.product_id),
      ...savingsAccounts.filter((p) => p.accepts_no_ssn === true).map((p) => p.product_id),
      ...creditCards.filter((p) => p.requires_ssn === false).map((p) => p.product_id),
    ],
    itin_accepted: [
      ...checkingAccounts.filter((p) => p.accepts_itin === true).map((p) => p.product_id),
      ...savingsAccounts.filter((p) => p.accepts_itin === true).map((p) => p.product_id),
      ...creditCards.filter((p) => p.accepts_itin === true).map((p) => p.product_id),
    ],
    no_us_credit_history_ok: creditCards.filter((p) => p.accepts_no_us_credit_history === true).map((p) => p.product_id),
  };

  // --- (d) Inverted geographic index ---------------------------------------
  // Only ever lists confirmed-present (branches > 0) entries — a bank absent
  // from a state's list here is NOT confirmed-absent, just not confirmed-
  // present. The system prompt must reflect this; see the copy rule.
  const geographicIndex = {};
  Object.entries(locations).forEach(([bankId, entry]) => {
    Object.entries(entry.states || {}).forEach(([stateCode, s]) => {
      if (s.branches > 0) {
        geographicIndex[stateCode] = geographicIndex[stateCode] || {};
        geographicIndex[stateCode][bankId] = s.branches;
      }
    });
  });

  // --- (e) Credit card rewards/benefits index ------------------------------
  function leadingPercent(desc) {
    if (!desc) return null;
    const m = desc.match(/(\d+(\.\d+)?)\s*%/);
    return m ? parseFloat(m[1]) : null;
  }
  const rewardsIndex = {
    no_annual_fee: creditCards.filter((p) => p.annual_fee_usd === 0).map((p) => p.product_id),
    cashback_over_1_5pct: creditCards
      .filter((p) => p.rewards_type === "cashback" && leadingPercent(p.rewards_rate_description) >= 1.5)
      .map((p) => p.product_id),
    no_foreign_transaction_fee: creditCards.filter((p) => p.foreign_transaction_fee_pct === 0).map((p) => p.product_id),
  };

  // --- (f) Precomputed rankings --------------------------------------------
  const rankings = {
    checking_by_monthly_fee_asc: [...checkingAccounts]
      .filter((p) => typeof p.monthly_fee_usd === "number")
      .sort((a, b) => a.monthly_fee_usd - b.monthly_fee_usd)
      .map((p) => ({ product_id: p.product_id, bank_name: bankName(p.bank_id), name: p.name, monthly_fee_usd: p.monthly_fee_usd })),
    savings_by_apy_desc: [...savingsAccounts]
      .filter((p) => typeof p.apy_current === "number")
      .sort((a, b) => b.apy_current - a.apy_current)
      .map((p) => ({ product_id: p.product_id, bank_name: bankName(p.bank_id), name: p.name, apy_current: p.apy_current })),
    credit_cards_by_annual_fee_asc: [...creditCards]
      .filter((p) => typeof p.annual_fee_usd === "number")
      .sort((a, b) => a.annual_fee_usd - b.annual_fee_usd)
      .map((p) => ({ product_id: p.product_id, bank_name: bankName(p.bank_id), name: p.name, annual_fee_usd: p.annual_fee_usd })),
  };

  // --- (g) "Alternative path" index ----------------------------------------
  // Curated grouping for someone with no US SSN/ITIN/credit history yet —
  // validated against the actual data (not disconnected from it), but the
  // grouping itself and the "why" blurbs are hand-picked, not derived.
  const alternativePaths = [
    { bank_id: "zolve", why: "Built for internationals — can open an account before arriving in the US." },
    { bank_id: "firstcard", why: "No SSN or ITIN required; reports to all 3 credit bureaus to help build US credit from scratch." },
    { bank_id: "nova_credit", why: "Not a bank — translates existing international credit history into a report US lenders can use, for 16 source countries." },
    { bank_id: "hsbc", why: "Premier program allows opening a US account remotely with a passport, before arriving, for existing HSBC customers abroad." },
  ].map((entry) => ({ ...entry, name: bankName(entry.bank_id) }));

  // --- (h) Static glossary (hand-written, not derived from the JSONs) ------
  const glossary = {
    SSN: "Social Security Number — the primary US tax/identity number, usually only available to those authorized to work in the US.",
    ITIN: "Individual Taxpayer Identification Number — an IRS-issued alternative to an SSN for people who need to file US taxes but aren't eligible for an SSN.",
    APY: "Annual Percentage Yield — the real annual return on a savings/deposit balance, including compounding. Higher is better for the saver.",
    APR: "Annual Percentage Rate — the yearly cost of borrowing on a credit card if a balance is carried. Lower is better for the borrower.",
    "FDIC insured": "Deposits are protected by the Federal Deposit Insurance Corporation up to $250,000 per depositor, per bank, if the bank fails.",
    credit_history_bridge: "A service (not a bank) that translates a person's credit history from another country into something a US lender can evaluate, since US bureaus have no file on new arrivals.",
    "secured credit card": "A card backed by a refundable cash deposit that sets the credit limit — usually easier to qualify for with no US credit history, and can help build one.",
    no_us_credit_history_ok: "This flag means at least one product from that institution doesn't require existing US credit history — always check the specific product before assuming every product there qualifies.",
  };

  MFB.semantic = {
    perInstitution,
    all_checking_accounts,
    all_savings_accounts,
    all_credit_cards,
    eligibilityIndex,
    geographicIndex,
    rewardsIndex,
    rankings,
    alternativePaths,
    glossary,
  };
});
