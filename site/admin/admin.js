const loginView = document.querySelector("[data-login]");
const boardView = document.querySelector("[data-board]");
const loginForm = document.querySelector("[data-login-form]");
const loginStatus = document.querySelector("[data-login-status]");
const boardStatus = document.querySelector("[data-board-status]");
const logoutBtn = document.querySelector("[data-logout]");
const filtersForm = document.querySelector("[data-filters]");
const rowsEl = document.querySelector("[data-rows]");
const emptyEl = document.querySelector("[data-empty]");
const countEl = document.querySelector("[data-count]");
const sparkEl = document.querySelector("[data-spark]");
const sparkLine = document.querySelector("[data-spark-line]");
const migrationBanner = document.querySelector("[data-migration-banner]");

let bearer = "";
let adminFields = true;

function setStatus(el, kind, message) {
  if (!el) {
    return;
  }
  el.dataset.kind = kind || "";
  el.textContent = message || "";
}

function authHeaders(extra) {
  const headers = { ...(extra || {}) };
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  return headers;
}

async function api(url, init = {}) {
  const headers = authHeaders(init.headers || {});
  if (init.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  return fetch(url, {
    credentials: "same-origin",
    ...init,
    headers,
  });
}

function queryString() {
  const data = new FormData(filtersForm);
  const params = new URLSearchParams();
  for (const [key, value] of data.entries()) {
    const trimmed = String(value || "").trim();
    if (trimmed) {
      params.set(key, trimmed);
    }
  }
  return params;
}

function showLogin() {
  loginView.hidden = false;
  boardView.hidden = true;
  logoutBtn.hidden = true;
  bearer = "";
}

function showBoard() {
  loginView.hidden = true;
  boardView.hidden = false;
  logoutBtn.hidden = false;
}

function formatWhen(value) {
  const text = String(value || "");
  if (!text) {
    return "—";
  }
  const iso = text.includes("T") ? text : text.replace(" ", "T") + "Z";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return text;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function drawSpark(days) {
  if (!sparkEl || !sparkLine || !days || days.length === 0) {
    sparkEl.hidden = true;
    return;
  }
  const max = Math.max(1, ...days.map((item) => item.count));
  const width = 140;
  const height = 36;
  const pad = 3;
  const points = days.map((item, index) => {
    const x = pad + (index / Math.max(1, days.length - 1)) * (width - pad * 2);
    const y = height - pad - (item.count / max) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  sparkLine.setAttribute("points", points.join(" "));
  sparkEl.hidden = false;
}

function renderRows(signups) {
  rowsEl.replaceChildren();
  emptyEl.hidden = signups.length > 0;
  for (const row of signups) {
    const tr = document.createElement("tr");
    tr.dataset.email = row.email;

    const emailTd = document.createElement("td");
    emailTd.className = "admin-email";
    const mail = document.createElement("a");
    mail.href = `mailto:${row.email}`;
    mail.textContent = row.email;
    emailTd.append(mail);

    const nameTd = document.createElement("td");
    nameTd.textContent = row.name || "—";

    const whenTd = document.createElement("td");
    whenTd.className = "admin-when";
    whenTd.textContent = formatWhen(row.created_at);

    const emailedTd = document.createElement("td");
    emailedTd.className = "admin-emailed";
    const emailed = document.createElement("input");
    emailed.type = "checkbox";
    emailed.checked = Boolean(row.emailed);
    emailed.disabled = !adminFields;
    emailed.setAttribute("aria-label", `Emailed ${row.email}`);
    emailed.addEventListener("change", () => patchRow(row.email, { emailed: emailed.checked }, emailed));
    emailedTd.append(emailed);

    const noteTd = document.createElement("td");
    const note = document.createElement("input");
    note.type = "text";
    note.maxLength = 500;
    note.value = row.note || "";
    note.placeholder = adminFields ? "Add a note" : "Needs migration";
    note.disabled = !adminFields;
    note.setAttribute("aria-label", `Note for ${row.email}`);
    note.addEventListener("change", () => patchRow(row.email, { note: note.value }, note));
    noteTd.append(note);

    const deleteTd = document.createElement("td");
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn-ghost admin-delete";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteRow(row.email));
    deleteTd.append(del);

    tr.append(emailTd, nameTd, whenTd, emailedTd, noteTd, deleteTd);
    rowsEl.append(tr);
  }
}

async function loadBoard() {
  const params = queryString();
  params.set("format", "json");
  const res = await api(`/api/waitlist?${params.toString()}`);
  if (res.status === 401 || res.status === 404) {
    showLogin();
    if (res.status === 404) {
      setStatus(loginStatus, "err", "WAITLIST_ADMIN_TOKEN is not set on this deploy.");
    }
    return false;
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    setStatus(boardStatus, "err", "Could not load the waitlist.");
    return false;
  }
  adminFields = payload.admin_fields !== false;
  migrationBanner.hidden = adminFields;
  const total = payload.total ?? payload.signups.length;
  const count = payload.count ?? payload.signups.length;
  if (count === total) {
    countEl.textContent = total === 1 ? "1 signup" : `${total} signups`;
  } else {
    countEl.textContent = `Showing ${count} of ${total}`;
  }
  drawSpark(payload.days || []);
  renderRows(payload.signups || []);
  showBoard();
  return true;
}

async function patchRow(email, patch, control) {
  setStatus(boardStatus, "pending", "Saving…");
  const res = await api("/api/waitlist", {
    method: "PATCH",
    body: JSON.stringify({ email, ...patch }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    setStatus(boardStatus, "err", "Could not save that row.");
    await loadBoard();
    return;
  }
  setStatus(boardStatus, "ok", "Saved.");
  if (control && payload.signup) {
    if (control.type === "checkbox") {
      control.checked = Boolean(payload.signup.emailed);
    } else {
      control.value = payload.signup.note || "";
    }
  }
}

async function deleteRow(email) {
  if (!window.confirm(`Delete ${email} from the waitlist?`)) {
    return;
  }
  setStatus(boardStatus, "pending", "Deleting…");
  const res = await api(`/api/waitlist?email=${encodeURIComponent(email)}`, {
    method: "DELETE",
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    setStatus(boardStatus, "err", "Could not delete that row.");
    return;
  }
  setStatus(boardStatus, "ok", `Deleted ${email}.`);
  await loadBoard();
}

async function download(format) {
  const params = queryString();
  params.set("format", format);
  const res = await api(`/api/waitlist?${params.toString()}`);
  if (!res.ok) {
    setStatus(boardStatus, "err", "Could not export.");
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = format === "json" ? "waitlist.json" : "waitlist.csv";
  link.click();
  URL.revokeObjectURL(url);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = String(new FormData(loginForm).get("token") || "");
  setStatus(loginStatus, "pending", "Checking…");
  const res = await fetch("/api/waitlist/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const message =
      payload.error === "rate_limited"
        ? "Too many tries. Wait a few minutes."
        : "That token did not match.";
    setStatus(loginStatus, "err", message);
    return;
  }
  bearer = token;
  loginForm.reset();
  setStatus(loginStatus, "", "");
  const ok = await loadBoard();
  if (!ok) {
    setStatus(loginStatus, "err", "Signed in, but the list did not load.");
  }
});

logoutBtn.addEventListener("click", async () => {
  await api("/api/waitlist/session", { method: "DELETE" });
  showLogin();
  setStatus(loginStatus, "ok", "Logged out.");
});

filtersForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus(boardStatus, "pending", "Filtering…");
  await loadBoard();
  setStatus(boardStatus, "", "");
});

filtersForm.querySelector("[data-clear]").addEventListener("click", async () => {
  filtersForm.reset();
  await loadBoard();
});

document.querySelectorAll("[data-export]").forEach((button) => {
  button.addEventListener("click", () => download(button.dataset.export));
});

loadBoard();
