// Stay Updated lead-capture form (stay-updated.html). Posts directly to a
// Lambda Function URL (see lambda/README.md) — no CRM automation UI, no
// double opt-in, just a scoped serverless write + an immediate Brevo
// welcome email/SMS triggered from the Lambda itself. Ships with
// LAMBDA_URL empty until the AWS side is deployed (same "not connected
// yet" precedent as WORKER_URL in js/agent.js before the Cloudflare
// Worker existed) — the whole form is still fully reviewable/testable
// client-side before that.

const LAMBDA_URL = "https://eckbdei7cv3uxl7ytw5ebrsqs40daeoz.lambda-url.us-east-2.on.aws/";

// How long the client waits for the Lambda before giving up and showing a
// network-style error instead of leaving the button on "Submitting…"
// forever — a slow/dead connection shouldn't hang the form indefinitely.
const SUBMIT_TIMEOUT_MS = 15000;

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

// --- Field-level validators -------------------------------------------------
// Each returns "" when valid, or a specific, field-anchored error string.
// Kept as free functions (not methods) so they're easy to unit-test in
// isolation later if this ever grows a build step / test runner.

const NAME_RE = /^[\p{L}\s'-]+$/u; // letters (incl. accents/ñ), spaces, apostrophes, hyphens
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 100;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
const ARRIVAL_MAX_YEARS_AHEAD = 2;

function sanitizePhoneDigits(value) {
  // Strips everything but digits — handles browser autofill pasting a
  // formatted number like "(999) 888-7777" straight into the field.
  return String(value || "").replace(/\D/g, "");
}

function validateNameField(value, label) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return `${label} is required.`;
  if (trimmed.length < NAME_MIN_LENGTH) return `${label} must be at least ${NAME_MIN_LENGTH} characters.`;
  if (trimmed.length > NAME_MAX_LENGTH) return `${label} must be ${NAME_MAX_LENGTH} characters or fewer.`;
  // NAME_RE already excludes digits, so an all-numeric value (e.g. "12345")
  // fails here too — no separate "no digits" check needed.
  if (!NAME_RE.test(trimmed)) return `${label} can only contain letters, spaces, apostrophes, and hyphens.`;
  return "";
}

function validateEmailValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "Email is required.";
  if (trimmed.length > EMAIL_MAX_LENGTH) return `Email must be ${EMAIL_MAX_LENGTH} characters or fewer.`;
  if (!EMAIL_RE.test(trimmed)) return "Enter a valid email address.";
  return "";
}

function validatePhoneValue(value) {
  const digits = sanitizePhoneDigits(value);
  if (!digits) return "Phone number is required.";
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) {
    return `Enter a valid phone number (${PHONE_MIN_DIGITS}–${PHONE_MAX_DIGITS} digits).`;
  }
  return "";
}

// Local-date helpers — deliberately avoid `new Date(isoString)` (parses as
// UTC midnight) and `.toISOString()` (renders in UTC) for "today" math,
// since both can silently shift a day depending on the visitor's timezone.
function todayLocalMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function parseIsoDateLocal(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function toIsoDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function validateArrivalDateValue(value) {
  if (!value) return "Arrival date is required.";
  const chosen = parseIsoDateLocal(value);
  if (Number.isNaN(chosen.getTime())) return "Enter a valid date.";
  const today = todayLocalMidnight();
  if (chosen < today) return "Arrival date can't be in the past.";
  const maxDate = todayLocalMidnight();
  maxDate.setFullYear(maxDate.getFullYear() + ARRIVAL_MAX_YEARS_AHEAD);
  if (chosen > maxDate) return `Arrival date can't be more than ${ARRIVAL_MAX_YEARS_AHEAD} years from today.`;
  return "";
}

// Field → the id of the element to focus when that field's error is the
// first one found on a failed submit attempt.
const FIELD_FOCUS_IDS = {
  firstName: "lf-first-name",
  lastName: "lf-last-name",
  phoneNumber: "lf-phone-number",
  email: "lf-email",
  state: "lf-state",
  interestedIn: "lf-interest-checking",
  arrivalDate: "lf-arrival",
  consent: "lf-consent",
};
// Order matters here — it's the order fields are checked in when focusing
// the first error after a failed submit, matching the form's visual layout.
const FIELD_ORDER = ["firstName", "lastName", "phoneNumber", "email", "state", "interestedIn", "arrivalDate", "consent"];

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

    // Per-field error messages ("" = no error) and whether that field has
    // been blurred/changed at least once. Timing rule: validate on blur the
    // first time; once a field has been touched, re-validate live on every
    // change until it's fixed (and beyond, so a later mistake still shows
    // immediately rather than waiting for another blur).
    errors: { firstName: "", lastName: "", phoneNumber: "", email: "", state: "", interestedIn: "", arrivalDate: "", consent: "" },
    touched: { firstName: false, lastName: false, phoneNumber: false, email: false, state: false, interestedIn: false, arrivalDate: false, consent: false },

    sourcePage: "direct",
    submitting: false,
    submitError: "",
    submitted: false,
    duplicate: false,

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

    get todayIso() {
      return toIsoDateLocal(todayLocalMidnight());
    },
    get maxArrivalIso() {
      const d = todayLocalMidnight();
      d.setFullYear(d.getFullYear() + ARRIVAL_MAX_YEARS_AHEAD);
      return toIsoDateLocal(d);
    },

    // Lightweight "are the required fields filled" check that gates the
    // button's enabled state at a glance. This is NOT the full validation —
    // that runs in validateAll() at submit time, which is what actually
    // blocks a bad value (e.g. a filled-but-malformed email) from being
    // sent, with an inline error and focus on the offending field. A field
    // can pass this quick check yet still fail validateAll() if the user
    // never blurred it, and that's fine: submit() is the real gate.
    get formReady() {
      const f = this.form;
      return !!(
        f.firstName.trim() &&
        f.lastName.trim() &&
        sanitizePhoneDigits(f.phoneNumber).length >= PHONE_MIN_DIGITS &&
        f.email.trim() &&
        f.state &&
        this.interestCount >= 1 &&
        f.arrivalDate &&
        f.consent
      );
    },

    // --- Validation-timing plumbing ---------------------------------------

    runValidation(field) {
      const f = this.form;
      switch (field) {
        case "firstName":
          this.errors.firstName = validateNameField(f.firstName, "First name");
          break;
        case "lastName":
          this.errors.lastName = validateNameField(f.lastName, "Last name");
          break;
        case "phoneNumber":
          this.errors.phoneNumber = validatePhoneValue(f.phoneNumber);
          break;
        case "email":
          this.errors.email = validateEmailValue(f.email);
          break;
        case "state":
          this.errors.state = f.state ? "" : "Please select a state.";
          break;
        case "interestedIn":
          this.errors.interestedIn = this.interestCount >= 1 ? "" : "Select at least one product you're interested in.";
          break;
        case "arrivalDate":
          this.errors.arrivalDate = validateArrivalDateValue(f.arrivalDate);
          break;
        case "consent":
          this.errors.consent = f.consent ? "" : "You must agree to receive updates to sign up.";
          break;
      }
    },

    // Called on @blur (or @change for selects/checkboxes, which don't need
    // a separate "first commit" event) — marks the field touched and runs
    // its validator immediately.
    touchAndValidate(field) {
      this.touched[field] = true;
      // Email is normalized (trim + lowercase) at the point it's first
      // committed, not on every keystroke, so the cursor never jumps mid-
      // type. This is also what's actually sent to the Lambda — see
      // submit() — which matters for the duplicate-email check: without
      // this, "Juan@Gmail.com" and "juan@gmail.com" would be treated as two
      // different people by the email-index GSI lookup.
      if (field === "email") this.form.email = this.form.email.trim().toLowerCase();
      this.runValidation(field);
    },

    // Called on @input for fields that support live re-validation — only
    // actually validates once the field has already been touched once,
    // per the blur-then-live timing rule.
    validateIfTouched(field) {
      if (this.touched[field]) this.runValidation(field);
    },

    // Runs every validator regardless of touched state (touching each field
    // in the process) — the authoritative, final check at submit time, so a
    // field that was filled but never blurred still gets caught.
    validateAll() {
      FIELD_ORDER.forEach((field) => {
        this.touched[field] = true;
        this.runValidation(field);
      });
    },

    firstErrorField() {
      return FIELD_ORDER.find((field) => this.errors[field]);
    },

    focusFirstError() {
      const field = this.firstErrorField();
      if (!field) return;
      const el = document.getElementById(FIELD_FOCUS_IDS[field]);
      if (el) el.focus();
    },

    async submit() {
      // Re-entry guard: blocks a rapid double-click/double-Enter from
      // starting a second submission — checked synchronously, before
      // anything async, so it doesn't depend on the DOM having re-rendered
      // the disabled button yet.
      if (this.submitting) return;

      this.validateAll();
      if (this.firstErrorField()) {
        this.focusFirstError();
        return;
      }

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

      // Disabled immediately, before the fetch even starts — this line runs
      // synchronously in the same tick as the click, so there's no window
      // for a second click to slip through before the button reflects it.
      this.submitting = true;
      this.submitError = "";

      const email = this.form.email.trim().toLowerCase();
      const phone_number = sanitizePhoneDigits(this.form.phoneNumber);
      const interested_in = Object.entries(this.form.interestedIn)
        .filter(([, checked]) => checked)
        .map(([key]) => (key === "creditCard" ? "credit_card" : key));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

      try {
        const res = await fetch(LAMBDA_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            first_name: this.form.firstName.trim(),
            last_name: this.form.lastName.trim(),
            phone_country_code: this.dialCodeForCountry(this.form.phoneCountryId),
            phone_number,
            email,
            state: this.form.state,
            interested_in,
            interest_note: this.form.interestNote.slice(0, 200),
            arrival_date: this.form.arrivalDate,
            consent_email_sms: this.form.consent,
            source_page: this.sourcePage,
            website: this.form.website,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          // The Lambda's own validation returns a specific, actionable
          // message (e.g. "a valid state is required") — show that instead
          // of the generic network-error copy, which is reserved for
          // actual fetch/timeout failures below.
          this.submitError = data.error || "Something went wrong submitting the form. Please try again in a moment.";
          return;
        }

        this.duplicate = data.duplicate === true;
        this.submitted = true;
      } catch (err) {
        this.submitError = err.name === "AbortError"
          ? "This is taking longer than expected. Please check your connection and try again."
          : "Something went wrong submitting the form. Please try again in a moment.";
      } finally {
        clearTimeout(timeoutId);
        this.submitting = false;
      }
    },
  }));
});
