// Stay Updated lead-capture form (stay-updated.html). Posts directly to a
// Lambda Function URL (see lambda/README.md) — no CRM automation UI, no
// double opt-in, just a scoped serverless write + an immediate Brevo
// welcome email/SMS triggered from the Lambda itself. Ships with
// LAMBDA_URL empty until the AWS side is deployed (same "not connected
// yet" precedent as WORKER_URL in js/agent.js before the Cloudflare
// Worker existed) — the whole form is still fully reviewable/testable
// client-side before that.

const LAMBDA_URL = "https://eckbdei7cv3uxl7ytw5ebrsqs40daeoz.lambda-url.us-east-2.on.aws/";

// Same 51-entry list as js/app.js's US_STATES / js/agent.js's inline copy —
// duplicated here rather than importing js/app.js, matching the existing
// precedent (js/agent.js:264-274) for a page that only needs the state list
// and nothing else from that file.
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

// Curated toward the countries international students/professionals
// relocating to the US most commonly come from, plus US/Canada. Emoji flags
// keep this dependency-free (no new CDN sprite) — the dial code is always
// shown alongside the flag as a fallback since emoji-flag rendering is
// inconsistent on some Windows configurations.
// `id` (ISO 3166-1 alpha-2) is the <select>'s bound value — several
// countries share the same dialCode ("+1" for both US and Canada), so the
// dial code alone can't be the option value (the browser can't tell two
// same-value options apart, and silently picks whichever one it likes,
// which is what caused stay-updated.html to first default to showing
// Canada's flag instead of the US). The real dial code sent to the Lambda
// is looked up from `id` at submit time — see dialCodeForCountry() below.
const COUNTRY_CODES = [
  { id: "US", dialCode: "+1", flag: "🇺🇸", name: "United States" },
  { id: "CA", dialCode: "+1", flag: "🇨🇦", name: "Canada" },
  { id: "IN", dialCode: "+91", flag: "🇮🇳", name: "India" },
  { id: "CN", dialCode: "+86", flag: "🇨🇳", name: "China" },
  { id: "KR", dialCode: "+82", flag: "🇰🇷", name: "South Korea" },
  { id: "JP", dialCode: "+81", flag: "🇯🇵", name: "Japan" },
  { id: "BD", dialCode: "+880", flag: "🇧🇩", name: "Bangladesh" },
  { id: "PK", dialCode: "+92", flag: "🇵🇰", name: "Pakistan" },
  { id: "LK", dialCode: "+94", flag: "🇱🇰", name: "Sri Lanka" },
  { id: "NP", dialCode: "+977", flag: "🇳🇵", name: "Nepal" },
  { id: "VN", dialCode: "+84", flag: "🇻🇳", name: "Vietnam" },
  { id: "PH", dialCode: "+63", flag: "🇵🇭", name: "Philippines" },
  { id: "ID", dialCode: "+62", flag: "🇮🇩", name: "Indonesia" },
  { id: "MY", dialCode: "+60", flag: "🇲🇾", name: "Malaysia" },
  { id: "SG", dialCode: "+65", flag: "🇸🇬", name: "Singapore" },
  { id: "TH", dialCode: "+66", flag: "🇹🇭", name: "Thailand" },
  { id: "NG", dialCode: "+234", flag: "🇳🇬", name: "Nigeria" },
  { id: "KE", dialCode: "+254", flag: "🇰🇪", name: "Kenya" },
  { id: "EG", dialCode: "+20", flag: "🇪🇬", name: "Egypt" },
  { id: "ZA", dialCode: "+27", flag: "🇿🇦", name: "South Africa" },
  { id: "BR", dialCode: "+55", flag: "🇧🇷", name: "Brazil" },
  { id: "MX", dialCode: "+52", flag: "🇲🇽", name: "Mexico" },
  { id: "CO", dialCode: "+57", flag: "🇨🇴", name: "Colombia" },
  { id: "PE", dialCode: "+51", flag: "🇵🇪", name: "Peru" },
  { id: "AR", dialCode: "+54", flag: "🇦🇷", name: "Argentina" },
  { id: "CL", dialCode: "+56", flag: "🇨🇱", name: "Chile" },
  { id: "GB", dialCode: "+44", flag: "🇬🇧", name: "United Kingdom" },
  { id: "FR", dialCode: "+33", flag: "🇫🇷", name: "France" },
  { id: "DE", dialCode: "+49", flag: "🇩🇪", name: "Germany" },
  { id: "ES", dialCode: "+34", flag: "🇪🇸", name: "Spain" },
  { id: "IT", dialCode: "+39", flag: "🇮🇹", name: "Italy" },
  { id: "TR", dialCode: "+90", flag: "🇹🇷", name: "Turkey" },
  { id: "AE", dialCode: "+971", flag: "🇦🇪", name: "United Arab Emirates" },
  { id: "SA", dialCode: "+966", flag: "🇸🇦", name: "Saudi Arabia" },
];

document.addEventListener("alpine:init", () => {
  Alpine.data("leadForm", () => ({
    configured: LAMBDA_URL.length > 0,
    usStates: US_STATES,
    countryCodes: COUNTRY_CODES,

    form: {
      firstName: "",
      lastName: "",
      phoneCountryId: "US",
      phoneNumber: "",
      email: "",
      state: "",
      interestedIn: { checking: false, savings: false, creditCard: false },
      interestNote: "",
      arrivalDate: "",
      consent: false,
      website: "", // honeypot — see the off-screen field in stay-updated.html
    },

    sourcePage: "direct",
    submitting: false,
    submitError: "",
    submitted: false,

    init() {
      // New query-param convention (?source=agent-cta / ?source=browse-banner)
      // — no existing param (bank=, compare= in js/agent.js) collides with
      // this. Read the same URLSearchParams way those already do.
      this.sourcePage = new URLSearchParams(location.search).get("source") || "direct";
    },

    get interestCount() {
      return Object.values(this.form.interestedIn).filter(Boolean).length;
    },

    dialCodeForCountry(id) {
      return this.countryCodes.find((c) => c.id === id)?.dialCode || "";
    },

    get formReady() {
      const f = this.form;
      return !!(
        f.firstName.trim() &&
        f.lastName.trim() &&
        f.phoneNumber.trim() &&
        f.email.trim() &&
        f.state &&
        this.interestCount >= 1 &&
        f.arrivalDate &&
        f.consent
      );
    },

    async submit() {
      if (!this.formReady || this.submitting) return;

      // Honeypot tripped — a real user never fills or sees this field. Fake
      // a normal success after a short delay, with no network call at all,
      // so a scripted bot gets no signal that it was caught.
      if (this.form.website) {
        this.submitting = true;
        setTimeout(() => {
          this.submitting = false;
          this.submitted = true;
        }, 400);
        return;
      }

      if (!this.configured) {
        this.submitError = "Sign-ups aren't connected yet on this deploy.";
        return;
      }

      this.submitting = true;
      this.submitError = "";

      const interested_in = Object.entries(this.form.interestedIn)
        .filter(([, checked]) => checked)
        .map(([key]) => (key === "creditCard" ? "credit_card" : key));

      try {
        const res = await fetch(LAMBDA_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            first_name: this.form.firstName.trim(),
            last_name: this.form.lastName.trim(),
            phone_country_code: this.dialCodeForCountry(this.form.phoneCountryId),
            phone_number: this.form.phoneNumber.trim(),
            email: this.form.email.trim(),
            state: this.form.state,
            interested_in,
            interest_note: this.form.interestNote.slice(0, 200),
            arrival_date: this.form.arrivalDate,
            consent_email_sms: this.form.consent,
            source_page: this.sourcePage,
            website: this.form.website,
          }),
        });
        if (!res.ok) throw new Error(`Lambda responded ${res.status}`);
        this.submitted = true;
      } catch {
        this.submitError = "Something went wrong submitting the form. Please try again in a moment.";
      } finally {
        this.submitting = false;
      }
    },
  }));
});
