const form = document.querySelector("[data-waitlist-form]");

if (form) {
  const statusEl = form.querySelector("[data-waitlist-status]");
  const submitBtn = form.querySelector("[type=submit]");
  const emailInput = form.querySelector("#waitlist-email");

  function setStatus(kind, message) {
    statusEl.dataset.kind = kind;
    statusEl.textContent = message;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const email = String(data.get("email") || "").trim();
    const name = String(data.get("name") || "").trim();
    const company = String(data.get("company") || "");

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus("err", "Enter a valid email.");
      emailInput?.focus();
      return;
    }

    submitBtn.disabled = true;
    setStatus("pending", "Joining…");

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, name, company }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload.ok === false) {
        const message =
          payload.error === "invalid_email"
            ? "Enter a valid email."
            : "Could not join right now. Try again in a bit.";
        setStatus("err", message);
        submitBtn.disabled = false;
        return;
      }
      form.classList.add("is-success");
      setStatus("ok", "You're on the list. Edmund will email when something ships.");
    } catch {
      setStatus("err", "Could not join right now. Try again in a bit.");
      submitBtn.disabled = false;
    }
  });
}
