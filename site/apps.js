const PLACEHOLDER_HREF = new Set(["", "#"]);

function markPlaceholders() {
  document.querySelectorAll("a.btn[href]").forEach((link) => {
    const href = (link.getAttribute("href") || "").trim();
    if (!PLACEHOLDER_HREF.has(href)) {
      link.classList.remove("is-placeholder");
      link.removeAttribute("aria-disabled");
      return;
    }

    link.classList.add("is-placeholder");
    link.setAttribute("aria-disabled", "true");
    link.addEventListener("click", (event) => {
      event.preventDefault();
    });
  });
}

markPlaceholders();
