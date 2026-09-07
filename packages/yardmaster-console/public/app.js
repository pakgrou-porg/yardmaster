// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

const $ = (s) => document.querySelector(s);
const api = (p, opt) => fetch(p, opt).then((r) => r.json());
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const ms = (n) => (n == null ? "—" : `${Math.round(n)} ms`);
const usd = (n) => `$${(n || 0).toFixed(4)}`;

// ---- tabs ----
document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === b.dataset.tab));
    if (b.dataset.tab === "backends") refreshBackends();
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
  $("#ag-url").textContent = a.url;
  $("#ag-open").href = a.url;
  if ($("#ag-frame").src !== a.url) $("#ag-frame").src = a.url;
}

loadConfig();
