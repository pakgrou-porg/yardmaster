// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

const $ = (s) => document.querySelector(s);
const api = (p, opt) => fetch(p, opt).then((r) => r.json());
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ms = (n) => (n == null ? "—" : `${Math.round(n)} ms`);
const usd = (n) => `$${(n || 0).toFixed(4)}`;

// ---- tabs ----
document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === b.dataset.tab));
    if (b.dataset.tab === "backends") refreshBackends();
    if (b.dataset.tab === "capabilities") refreshCapabilities();
    if (b.dataset.tab === "metrics") refreshMetrics();
    if (b.dataset.tab === "agent") loadAgent();
  }),
);

// ---- status ----
api("/api/status").then((s) => {
  $("#status").textContent = s.dataplane_dry_run
    ? "dry-run: dataplane"
    : "dry-run: console validator";
  $("#status").title = s.note || "";
});

// ---- config ----
async function loadConfig() {
  const c = await api("/api/config");
  $("#cfg-text").value = c.raw;
  $("#cfg-path").textContent = `writes → ${c.writable_path}`;
}
function renderResult(v) {
  const box = $("#cfg-result");
  $("#cfg-engine").textContent = v.engine ? `checked by: ${v.engine}` : "";
  let h = v.ok
    ? `<p class="ok">✓ valid${v.written ? " — saved" : ""}</p>`
    : `<p class="err">✗ ${v.errors.length} error(s)</p>`;
  if (v.errors?.length) h += "<ul>" + v.errors.map((e) => `<li class="err">${esc(e)}</li>`).join("") + "</ul>";
  if (v.warnings?.length) h += "<ul>" + v.warnings.map((e) => `<li class="warn">${esc(e)}</li>`).join("") + "</ul>";
  box.innerHTML = h;
}
$("#cfg-validate").addEventListener("click", async () => {
  renderResult(await api("/api/config/validate", { method: "POST", body: $("#cfg-text").value }));
});
$("#cfg-save").addEventListener("click", async () => {
  const r = await fetch("/api/config", { method: "PUT", body: $("#cfg-text").value });
  renderResult(await r.json());
});

// ---- backends ----
let beTimer = null;
async function refreshBackends() {
  const { backends } = await api("/api/backends");
  $("#be-list").innerHTML =
    `<table><tr><th>backend</th><th>kind</th><th>status</th><th>latency</th><th>models</th><th>endpoint</th></tr>` +
    backends
      .map(
        (b) =>
          `<tr><td>${esc(b.name)}</td><td class="dim">${esc(b.kind)}</td>` +
          `<td><span class="pill ${b.up ? "up" : "down"}">${b.up ? "up" : "down"}</span>` +
          `${b.error ? ` <span class="dim">${esc(b.error)}</span>` : ""}</td>` +
          `<td>${ms(b.latency_ms)}</td>` +
          `<td>${b.models.length ? esc(b.models.slice(0, 6).join(", ")) + (b.models.length > 6 ? " …" : "") : "<span class=dim>—</span>"}</td>` +
          `<td class="dim">${esc(b.probed || b.base_url)}</td></tr>`,
      )
      .join("") +
    `</table>` +
    (backends.length ? "" : `<p class="dim">No providers in yardmaster.toml and no YM_LOCAL_ENGINE_URL set.</p>`);
}
$("#be-refresh").addEventListener("click", refreshBackends);
$("#be-auto").addEventListener("change", (e) => {
  clearInterval(beTimer);
  if (e.target.checked) beTimer = setInterval(refreshBackends, 15000);
});
beTimer = setInterval(refreshBackends, 15000);

// ---- capabilities (ADR-0028) ----
function reachPill(r) {
  // smoke_tested is *stronger* confidence than validated (a real chat
  // completion succeeded, not just a /v1/models listing) — same color.
  const cls = r === "validated" || r === "smoke_tested" ? "up" : r === "unreachable" ? "down" : "warn";
  return `<span class="pill ${cls}">${esc(r)}</span>`;
}
function policyPill(p, reason) {
  const cls = p === "enabled" ? "up" : "down";
  return `<span class="pill ${cls}" title="${esc(reason || "")}">${esc(p)}</span>`;
}
// "not_required" (require_approval is off, or this record isn't a target at
// all) renders as a plain dash — showing a pill for the common case would be
// noise; "pending"/"approved"/"rejected" are the states worth calling out.
function approvalPill(a) {
  if (!a || a === "not_required") return `<span class="dim">—</span>`;
  const cls = a === "approved" ? "up" : a === "rejected" ? "down" : "warn";
  return `<span class="pill ${cls}">${esc(a)}</span>`;
}
async function overrideAction(id, patch) {
  const r = await api("/api/capabilities/override", { method: "POST", body: JSON.stringify({ id, patch }) });
  if (!r.written) alert(`Not saved: ${(r.errors || []).join("; ") || "unknown error"}`);
  await refreshCapabilities();
}
async function refreshCapabilities() {
  const d = await api("/api/capabilities");
  if (!d.available) {
    $("#cap-note").textContent = d.note || "router unreachable";
    $("#cap-pending").innerHTML = "";
    $("#cap-approval-queue").innerHTML = "";
    $("#cap-list").innerHTML = `<p class="dim">Set YM_DATAPLANE_MODE=router on the yardmaster service to enable this.</p>`;
    return;
  }
  $("#cap-note").textContent = d.last_error ? `last reconcile error: ${d.last_error}` : "";
  $("#cap-require-approval").checked = !!d.require_approval;

  const pending = d.pending_ops || [];
  $("#cap-pending").innerHTML = pending.length
    ? `<div class="bar"><span class="msg warn">${pending.length} change(s) held for approval</span>` +
      `<button id="cap-apply" class="primary">Apply all</button></div>` +
      `<ul>${pending.map((o) => `<li>${esc(o.type)} <code>${esc(o.id ?? "")}</code>` +
        `${o.from ? ` (${esc(o.from)} → ${esc(o.to)})` : ""} — <span class="dim">${esc(o.reason)}</span></li>`).join("")}</ul>`
    : "";
  const applyBtn = $("#cap-apply");
  if (applyBtn) applyBtn.addEventListener("click", async () => {
    const r = await api("/api/capabilities/apply", { method: "POST" });
    if (r.error) alert(`Apply failed: ${r.error}`);
    await refreshCapabilities();
  });

  // Approval queue (ADR-0028 P4): newly-discovered/validated models awaiting
  // a curation decision — distinct from `pending_ops` above, which is about
  // already-computed removals/default-changes held back, not new inclusions.
  const awaiting = (d.records || []).filter((r) => r.approval === "pending");
  $("#cap-approval-queue").innerHTML = awaiting.length
    ? `<div class="bar"><span class="msg warn">${awaiting.length} model(s) awaiting approval</span></div>` +
      `<table><tr><th>id</th><th>provider</th><th>locality</th><th>reachability</th><th>context</th><th></th></tr>` +
      awaiting
        .map(
          (r) =>
            `<tr><td>${esc(r.id)}</td><td class="dim">${esc(r.provider)}</td><td class="dim">${esc(r.locality ?? "—")}</td>` +
            `<td>${reachPill(r.reachability)}</td><td class="dim">${r.context_window ? r.context_window.toLocaleString() : "—"}</td>` +
            `<td><button data-approve="${esc(r.id)}" class="primary">Approve</button>` +
            `<button data-reject="${esc(r.id)}">Reject</button></td></tr>`,
        )
        .join("") +
      `</table>`
    : "";
  $("#cap-approval-queue").querySelectorAll("button[data-approve]").forEach((b) =>
    b.addEventListener("click", () => overrideAction(b.dataset.approve, { approved: true })),
  );
  $("#cap-approval-queue").querySelectorAll("button[data-reject]").forEach((b) =>
    b.addEventListener("click", () => overrideAction(b.dataset.reject, { approved: false })),
  );

  const rows = [...(d.records || [])].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.id.localeCompare(b.id));
  $("#cap-list").innerHTML =
    `<table><tr><th>id</th><th>provider</th><th>locality</th><th>reachability</th><th>policy</th>` +
    `<th>approval</th><th>rank</th><th>default</th><th></th></tr>` +
    rows
      .map((r) => {
        const enabled = r.policy === "enabled";
        let actions = "";
        if (r.target) {
          actions += `<button data-act="toggle" data-id="${esc(r.id)}" data-enabled="${enabled}">${enabled ? "Disable" : "Enable"}</button>`;
          if (!r.default) actions += `<button data-act="default" data-id="${esc(r.id)}">Set default</button>`;
          if (r.approval === "pending") {
            actions += `<button data-act="approve" data-id="${esc(r.id)}">Approve</button><button data-act="reject" data-id="${esc(r.id)}">Reject</button>`;
          } else if (r.approval === "approved") {
            actions += `<button data-act="reject" data-id="${esc(r.id)}">Reject</button>`;
          } else if (r.approval === "rejected") {
            actions += `<button data-act="approve" data-id="${esc(r.id)}">Approve</button>`;
          }
        } else {
          actions = `<span class="dim">not a target</span>`;
        }
        return (
          `<tr><td>${esc(r.id)}</td><td class="dim">${esc(r.provider)}</td><td class="dim">${esc(r.locality ?? "—")}</td>` +
          `<td>${reachPill(r.reachability)}</td><td>${policyPill(r.policy, r.policy_reason)}</td>` +
          `<td>${approvalPill(r.approval)}</td>` +
          `<td class="dim">${r.rank ?? "—"}</td><td>${r.default ? "✓" : ""}</td><td>${actions}</td></tr>`
        );
      })
      .join("") +
    `</table>`;
  $("#cap-list").querySelectorAll("button[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.id;
      if (b.dataset.act === "toggle") overrideAction(id, { enabled: b.dataset.enabled !== "true" });
      else if (b.dataset.act === "default") overrideAction(id, { default: true });
      else if (b.dataset.act === "approve") overrideAction(id, { approved: true });
      else if (b.dataset.act === "reject") overrideAction(id, { approved: false });
    }),
  );
}
$("#cap-refresh").addEventListener("click", refreshCapabilities);
$("#cap-reconcile").addEventListener("click", async () => {
  await api("/api/capabilities/reconcile", { method: "POST" });
  await refreshCapabilities();
});
$("#cap-require-approval").addEventListener("change", async (e) => {
  const r = await api("/api/capabilities/policy", { method: "POST", body: JSON.stringify({ patch: { require_approval: e.target.checked } }) });
  if (!r.written) {
    alert(`Not saved: ${(r.errors || []).join("; ") || "unknown error"}`);
    e.target.checked = !e.target.checked; // reflect the actual on-disk state, not the failed click
  }
  await refreshCapabilities();
});
$("#cap-approve-live").addEventListener("click", async () => {
  const r = await api("/api/capabilities/approve-live", { method: "POST" });
  if (r.error) alert(`Failed: ${r.error}`);
  else if (r.approved?.length) alert(`Approved ${r.approved.length} currently-live model(s): ${r.approved.join(", ")}`);
  else alert("Nothing needed grandfathering.");
  await refreshCapabilities();
});

// ---- metrics ----
async function refreshMetrics() {
  const m = await api(`/api/metrics?hours=${$("#mx-hours").value}`);
  $("#mx-note").textContent = m.available ? "" : m.note || "no data";
  const t = m.totals || {};
  $("#mx-tiles").innerHTML = [
    ["requests", t.requests || 0],
    ["tokens", (t.tokens || 0).toLocaleString()],
    ["cost", usd(t.cost_usd)],
    ["avg latency", ms(t.avg_latency_ms)],
    ["error rate", `${Math.round((t.error_rate || 0) * 100)}%`],
  ]
    .map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");
  const tbl = (rows, cols) =>
    rows.length
      ? `<table><tr>${cols.map((c) => `<th>${c[0]}</th>`).join("")}</tr>` +
        rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(c[1](r))}</td>`).join("")}</tr>`).join("") +
        `</table>`
      : `<p class="dim">—</p>`;
  $("#mx-routes").innerHTML = tbl(m.by_route, [
    ["route", (r) => r.route],
    ["requests", (r) => r.requests],
    ["avg latency", (r) => ms(r.avg_latency_ms)],
    ["failovers", (r) => r.failovers],
    ["cost", (r) => usd(r.cost_usd)],
  ]);
  $("#mx-nodes").innerHTML = tbl(m.by_node, [
    ["node / provider", (r) => r.node],
    ["engine", (r) => r.engine_kind],
    ["locality", (r) => r.locality],
    ["requests", (r) => r.requests],
    ["avg latency", (r) => ms(r.avg_latency_ms)],
    ["err", (r) => `${Math.round((r.error_rate || 0) * 100)}%`],
  ]);
  $("#mx-recent").innerHTML = tbl(m.recent, [
    ["time", (r) => new Date(r.ts_ms).toLocaleTimeString()],
    ["route", (r) => r.route],
    ["tier", (r) => r.tier_decided],
    ["why", (r) => r.decision_reason],
    ["node", (r) => r.node_or_provider],
    ["model", (r) => r.model],
    ["tok", (r) => `${r.prompt_tokens}/${r.completion_tokens}`],
    ["latency", (r) => ms(r.total_latency_ms)],
    ["overhead", (r) => ms(r.routing_overhead_ms)],
    ["status", (r) => r.http_status],
  ]);
}
$("#mx-refresh").addEventListener("click", refreshMetrics);
$("#mx-hours").addEventListener("change", refreshMetrics);

// ---- agent ----
async function loadAgent() {
  const a = await api("/api/agent");
  // Show the base (no token) for readability; navigate to the tokened one.
  $("#ag-url").textContent = a.base || a.url;
  $("#ag-open").href = a.url;
  $("#ag-open").textContent = a.tokened ? "open in a tab ↗ (current token)" : "open in a tab ↗";
  if ($("#ag-frame").src !== a.url) $("#ag-frame").src = a.url;
}

loadConfig();
