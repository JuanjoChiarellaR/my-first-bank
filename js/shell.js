// Renders the fixed navbar and footer into every page from one source of truth.
// Each page sets <body data-page="home|compare|agent|privacy|bank-detail"> so the
// navbar can mark the active item. The navbar itself never animates (fixed anchor).

(function () {
  const page = document.body.dataset.page || "";
  const base = (window.MFB && MFB.basePath) || (location.pathname.includes("/banks/") ? "../" : "");

  const navItems = [
    { href: `${base}index.html`, label: "Browse Banks", match: ["home", "bank-detail"] },
    { href: `${base}compare.html`, label: "Compare", match: ["compare"] },
    { href: `${base}agent.html`, label: "Ask the Agent", match: ["agent"] },
  ];

  const navLinksHtml = navItems
    .map((item) => {
      const isActive = item.match.includes(page);
      const activeClasses = isActive
        ? "text-ink border-b-2 border-ink"
        : "text-ink-secondary border-b-2 border-transparent hover:text-ink hover:bg-hover";
      return `<a href="${item.href}"
                 class="px-3 py-2 text-sm font-medium transition-colors duration-150 rounded-t-sm ${activeClasses} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                 ${isActive ? 'aria-current="page"' : ""}>${item.label}</a>`;
    })
    .join("");

  const navbarHtml = `
    <nav class="fixed top-0 left-0 right-0 z-50 bg-bg/95 backdrop-blur border-b border-border" aria-label="Primary">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16">
        <a href="${base}index.html" class="flex items-center gap-2 font-semibold text-ink font-display focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink rounded-sm" aria-label="MyFirstBank home">
          <img src="${base}assets/logos/_mark.svg" alt="" class="h-7 w-7" onerror="this.style.display='none'">
          <span>MyFirstBank</span>
        </a>
        <div class="hidden sm:flex items-center gap-1">${navLinksHtml}</div>
        <button type="button" id="mobile-nav-toggle"
                class="sm:hidden inline-flex items-center justify-center w-10 h-10 rounded-md border border-border text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                aria-expanded="false" aria-controls="mobile-nav-panel" aria-label="Open menu">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
      </div>
      <div id="mobile-nav-panel" class="sm:hidden hidden flex-col border-t border-border bg-bg px-4 py-2">
        ${navLinksHtml}
      </div>
    </nav>
    <div class="h-16" aria-hidden="true"></div>
  `;

  const footerHtml = `
    <footer class="mt-16 border-t border-border bg-bg">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 py-8 text-sm text-ink-secondary space-y-2">
        <p>This is not financial advice &mdash; informational only.</p>
        <p>MyFirstBank is an independent, unaffiliated resource. All bank names, logos, and trademarks are the property of their respective owners.</p>
        <p class="pt-2">
          <a href="${base}privacy.html" class="underline hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink rounded-sm">Privacy Policy</a>
        </p>
      </div>
    </footer>
  `;

  function renderComparePill() {
    let pill = document.getElementById("mfb-compare-pill");
    const count = window.MFB && MFB.compare ? MFB.compare.count() : 0;
    if (page === "compare" || count === 0) {
      if (pill) pill.remove();
      return;
    }
    if (!pill) {
      pill = document.createElement("a");
      pill.id = "mfb-compare-pill";
      pill.className =
        "fixed bottom-5 right-5 z-40 bg-ink text-white text-sm font-medium rounded-full px-4 py-3 shadow-lg hover:bg-[#3A3A36] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
      document.body.appendChild(pill);
    }
    pill.href = `${base}compare.html`;
    pill.textContent = `Compare (${count}) →`;
  }

  document.addEventListener("DOMContentLoaded", () => {
    const navMount = document.getElementById("site-navbar");
    const footerMount = document.getElementById("site-footer");
    if (navMount) navMount.outerHTML = navbarHtml;
    if (footerMount) footerMount.outerHTML = footerHtml;

    MFB.dataReady?.finally(() => {
      renderComparePill();
      MFB.compare?.onChange(renderComparePill);
    });

    const toggle = document.getElementById("mobile-nav-toggle");
    const panel = document.getElementById("mobile-nav-panel");
    if (toggle && panel) {
      toggle.addEventListener("click", () => {
        const isOpen = !panel.classList.contains("hidden");
        panel.classList.toggle("hidden");
        panel.classList.toggle("flex");
        toggle.setAttribute("aria-expanded", String(!isOpen));
        toggle.setAttribute("aria-label", isOpen ? "Open menu" : "Close menu");
      });
    }
  });
})();
