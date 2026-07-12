(function () {
  "use strict";

  const CSV_PATH = "customers.csv";
  const DASHBOARD_PASSWORD = "Pak@1122";
  const UNLOCK_SESSION_KEY = "call-register-dashboard-unlocked";

  let CUSTOMERS = [];
  let progress = {};
  let skipped = [];
  let currentView = "queue";
  let currentFilter = "all";
  let currentSearch = "";
  let noteDraft = "";
  let dashboardUnlocked = false;

  // ---------- CSV parsing (handles quoted fields with commas) ----------
  function parseCsv(text) {
    // strip BOM
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
        } else if (c === ",") {
          row.push(field);
          field = "";
        } else if (c === "\r") {
          // ignore, handle on \n
        } else if (c === "\n") {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
        } else {
          field += c;
        }
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
  }

  function loadCustomersFromCsv(text) {
    const rows = parseCsv(text);
    const header = rows[0];
    const idx = {};
    header.forEach((h, i) => (idx[h.trim()] = i));
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[idx.id]) continue;
      out.push({
        id: r[idx.id],
        name: r[idx.name] || "",
        father: r[idx.father] || "",
        cnic: r[idx.cnic] || "",
        mauza: r[idx.mauza] || "",
        mauza_count: r[idx.mauza_count] || "",
        registries: r[idx.registries] || "",
        role: r[idx.role] || "",
        cnic_available: r[idx.cnic_available] || "",
        phone: r[idx.phone] || "",
      });
    }
    return out;
  }

  // ---------- Persistence (shared, via /api/status backed by Redis) ----------
  async function loadProgress() {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error("Failed to load progress");
      const data = await res.json();
      return data.progress || {};
    } catch (e) {
      console.error("loadProgress error", e);
      showToast("Could not load saved progress");
      return {};
    }
  }

  async function saveStatus(customerId, status, note) {
    try {
      const res = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, status, note }),
      });
      if (!res.ok) throw new Error("Failed to save status");
      const data = await res.json();
      return data.progress || {};
    } catch (e) {
      console.error("saveStatus error", e);
      showToast("Could not save — check connection");
      return progress; // fall back to current in-memory state
    }
  }

  // Periodic refresh so multiple phones/devices stay roughly in sync
  function startProgressPolling() {
    setInterval(async () => {
      const fresh = await loadProgress();
      progress = fresh;
      if (currentView === "queue") {
        renderQueueView();
      } else if (isDashboardUnlockedThisSession()) {
        renderDashboard();
      }
    }, 8000);
  }

  // ---------- Helpers ----------
  function formatCnic(cnic) {
    const s = String(cnic);
    if (s.length === 13) return `${s.slice(0, 5)}-${s.slice(5, 12)}-${s.slice(12)}`;
    return s;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      t.style.display = "none";
    }, 1400);
  }

  // ---------- Queue logic ----------
  function getCurrentCustomer() {
    for (const c of CUSTOMERS) {
      if (progress[c.id]) continue;
      if (skipped.includes(c.id)) continue;
      return c;
    }
    for (const c of CUSTOMERS) {
      if (progress[c.id]) continue;
      return c;
    }
    return null;
  }

  function totalDone() {
    return Object.keys(progress).length;
  }

  function renderProgressBar() {
    const total = CUSTOMERS.length;
    const done = totalDone();
    const pct = total ? Math.round((done / total) * 100) : 0;
    document.getElementById("progressFill").style.width = pct + "%";
  }

  let lastRenderedCustomerId = null;

  function renderQueueView() {
    const current = getCurrentCustomer();
    const total = CUSTOMERS.length;
    const done = totalDone();

    if (!current) {
      document.getElementById("queueView").style.display = "none";
      document.getElementById("doneView").style.display = "block";
      const connected = Object.values(progress).filter((p) => p.status === "connected").length;
      const notConnected = Object.values(progress).filter((p) => p.status === "not_connected").length;
      document.getElementById("doneSub").textContent =
        `All ${total} entries logged — ${connected} connected, ${notConnected} not connected.`;
      return;
    }

    document.getElementById("queueView").style.display = "block";
    document.getElementById("doneView").style.display = "none";

    document.getElementById("entryLabel").textContent =
      `Entry ${current.id} · ${done + 1} of ${total} in register`;
    document.getElementById("serialBadge").textContent = "#" + current.id;
    document.getElementById("roleTag").textContent = current.role;
    document.getElementById("customerName").textContent = current.name;
    document.getElementById("fatherName").textContent = "ولد " + current.father;
    document.getElementById("cnicValue").textContent = formatCnic(current.cnic);
    document.getElementById("mauzaValue").textContent = current.mauza;
    document.getElementById("registriesValue").textContent =
      `${current.registries} across ${current.mauza_count} mauza${Number(current.mauza_count) > 1 ? "s" : ""}`;

    const isNewCustomer = lastRenderedCustomerId !== current.id;
    if (isNewCustomer) {
      // reset phone reveal + note only when moving to a different card
      document.getElementById("revealBtn").style.display = "flex";
      document.getElementById("phoneLink").style.display = "none";
      document.getElementById("noteInput").value = "";
      noteDraft = "";
      lastRenderedCustomerId = current.id;
    }

    const phoneLink = document.getElementById("phoneLink");
    phoneLink.href = "tel:" + current.phone.replace(/-/g, "");
    phoneLink.textContent = "☎ " + current.phone;

    document.getElementById("remainingNote").textContent = `${total - done} remaining in register`;

    renderProgressBar();
  }

  async function submitStatus(status) {
    const current = getCurrentCustomer();
    if (!current) return;
    const noteToSave = noteDraft.trim();

    if (!noteToSave) {
      showToast("Please add a note before submitting");
      document.getElementById("noteInput").focus();
      return;
    }

    // optimistic UI update
    progress[current.id] = {
      status,
      note: noteToSave,
      timestamp: new Date().toISOString(),
    };
    skipped = skipped.filter((id) => id !== current.id);
    showToast(status === "connected" ? "Saving…" : "Saving…");
    renderQueueView();

    const updated = await saveStatus(current.id, status, noteToSave);
    progress = updated;
    showToast(status === "connected" ? "Marked Connected" : "Marked Not Connected");
    renderQueueView();
  }

  function handleSkip() {
    const current = getCurrentCustomer();
    if (!current) return;
    skipped.push(current.id);
    renderQueueView();
  }

  // ---------- Dashboard ----------
  function renderDashboard() {
    const total = CUSTOMERS.length;
    const connected = CUSTOMERS.filter((c) => progress[c.id]?.status === "connected").length;
    const notConnected = CUSTOMERS.filter((c) => progress[c.id]?.status === "not_connected").length;
    const pending = total - connected - notConnected;

    document.getElementById("statTotal").textContent = total;
    document.getElementById("statConnected").textContent = connected;
    document.getElementById("statNotConnected").textContent = notConnected;
    document.getElementById("statPending").textContent = pending;

    const filtered = CUSTOMERS.filter((c) => {
      const result = progress[c.id];
      if (currentFilter === "connected" && result?.status !== "connected") return false;
      if (currentFilter === "not_connected" && result?.status !== "not_connected") return false;
      if (currentFilter === "pending" && result) return false;
      if (currentSearch) {
        const s = currentSearch.toLowerCase();
        if (
          !c.name.includes(currentSearch) &&
          !c.phone.includes(currentSearch) &&
          !String(c.id).includes(currentSearch)
        ) {
          return false;
        }
      }
      return true;
    });

    const listContainer = document.getElementById("listContainer");
    if (filtered.length === 0) {
      listContainer.innerHTML = '<div class="empty-state">No entries match this filter.</div>';
      return;
    }

    listContainer.innerHTML = filtered
      .map((c) => {
        const result = progress[c.id];
        const status = result ? result.status : "pending";
        const icon = status === "connected" ? "✓" : status === "not_connected" ? "✕" : "○";
        return `
          <div class="list-row">
            <div class="list-status-icon ${status}">${icon}</div>
            <div class="list-id">#${escapeHtml(c.id)}</div>
            <div class="list-name">${escapeHtml(c.name)}</div>
            <div class="list-phone">${escapeHtml(c.phone)}</div>
            <div class="list-note">${escapeHtml(result?.note || "")}</div>
          </div>
        `;
      })
      .join("");
  }

  function exportCsv() {
    const header = "ID,Name,Father,CNIC,Phone,Status,Note,Timestamp\n";
    const rows = CUSTOMERS.map((c) => {
      const result = progress[c.id];
      const status = result ? result.status : "pending";
      const note = (result?.note || "").replace(/"/g, '""');
      const ts = result?.timestamp || "";
      return `${c.id},"${c.name}","${c.father}",${c.cnic},${c.phone},${status},"${note}",${ts}`;
    }).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "call_register_results.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- Password protection ----------
  function isDashboardUnlockedThisSession() {
    try {
      return sessionStorage.getItem(UNLOCK_SESSION_KEY) === "true";
    } catch (e) {
      return dashboardUnlocked;
    }
  }

  function markDashboardUnlocked() {
    dashboardUnlocked = true;
    try {
      sessionStorage.setItem(UNLOCK_SESSION_KEY, "true");
    } catch (e) {
      // ignore
    }
  }

  function promptForDashboardPassword() {
    const entered = window.prompt("Enter password to view Register Summary:");
    if (entered === null) {
      // user cancelled — stay on queue view
      switchView("queue");
      return;
    }
    if (entered === DASHBOARD_PASSWORD) {
      markDashboardUnlocked();
      renderDashboard();
    } else {
      showToast("Incorrect password");
      switchView("queue");
    }
  }

  // ---------- View switching ----------
  function switchView(view) {
    currentView = view;
    document.getElementById("tabQueue").classList.toggle("tab-btn-active", view === "queue");
    document.getElementById("tabDashboard").classList.toggle("tab-btn-active", view === "dashboard");

    document.getElementById("queueView").style.display = view === "queue" ? "block" : "none";
    document.getElementById("doneView").style.display = "none";
    document.getElementById("dashboardView").style.display = view === "dashboard" ? "block" : "none";

    if (view === "queue") {
      renderQueueView();
    } else {
      if (isDashboardUnlockedThisSession()) {
        renderDashboard();
      } else {
        promptForDashboardPassword();
      }
    }
  }

  // ---------- Init ----------
  function attachEvents() {
    document.getElementById("tabQueue").addEventListener("click", () => switchView("queue"));
    document.getElementById("tabDashboard").addEventListener("click", () => switchView("dashboard"));

    document.getElementById("revealBtn").addEventListener("click", () => {
      document.getElementById("revealBtn").style.display = "none";
      document.getElementById("phoneLink").style.display = "flex";
    });

    document.getElementById("noteInput").addEventListener("input", (e) => {
      noteDraft = e.target.value;
    });

    document.getElementById("connectedBtn").addEventListener("click", () => submitStatus("connected"));
    document.getElementById("notConnectedBtn").addEventListener("click", () => submitStatus("not_connected"));
    document.getElementById("skipBtn").addEventListener("click", handleSkip);

    document.getElementById("searchInput").addEventListener("input", (e) => {
      currentSearch = e.target.value;
      renderDashboard();
    });

    document.querySelectorAll(".filter-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentFilter = btn.getAttribute("data-filter");
        document.querySelectorAll(".filter-chip").forEach((b) => b.classList.remove("filter-chip-active"));
        btn.classList.add("filter-chip-active");
        renderDashboard();
      });
    });

    document.getElementById("exportBtn").addEventListener("click", exportCsv);
  }

  async function init() {
    try {
      const res = await fetch(CSV_PATH);
      const text = await res.text();
      CUSTOMERS = loadCustomersFromCsv(text);
    } catch (e) {
      console.error("Failed to load customers.csv", e);
      document.getElementById("loading").innerHTML =
        '<div style="color:#b1503f;font-size:14px;max-width:280px;text-align:center;">Could not load customers.csv. Make sure it is deployed alongside index.html.</div>';
      return;
    }

    progress = await loadProgress();
    attachEvents();

    document.getElementById("loading").style.display = "none";
    document.getElementById("app").style.display = "block";

    switchView("queue");
    startProgressPolling();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
