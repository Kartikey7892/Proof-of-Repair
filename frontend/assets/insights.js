/* Insights dashboard — renders /api/analytics/* with Chart.js.
 * Color roles (validated for the dark surface #161b20 with the dataviz checker):
 *   single series  → --viz-1   (#c98500, amber step inside the lightness band)
 *   two series     → --viz-s1 / --viz-s2 (blue #3987e5, orange #d95926)
 *   magnitude      → blue sequential ramp (dark = near zero, light = high)
 * Every chart card has a table view; labels are inserted with textContent.
 */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const fmt = new Intl.NumberFormat();
  const pct = (x, d = 1) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);

  const charts = new Map();
  let vehicleFilter = "";
  let days = 30;

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    return res.json();
  }

  function el(tag, props = {}, children = []) {
    const n = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    });
    children.forEach((c) => n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return n;
  }

  // ---------------------------------------------------------------- Chart.js
  function baseOptions({ horizontal = false, stacked = false, percent = false, legend = false } = {}) {
    const muted = css("--muted");
    const grid = css("--viz-grid");
    const tickFmt = (v) => (percent ? `${Math.round(v * 100)}%` : fmt.format(v));
    const valueAxis = {
      beginAtZero: true,
      stacked,
      grid: { color: grid, drawTicks: false },
      border: { display: false },
      ticks: { color: muted, padding: 6, maxTicksLimit: 5, callback: tickFmt, font: { family: "IBM Plex Mono", size: 10 }, ...(percent ? {} : { precision: 0 }) },
      ...(percent ? { max: 1 } : {}),
    };
    const catAxis = {
      stacked,
      grid: { display: false },
      border: { color: css("--viz-axis") },
      ticks: { color: muted, autoSkip: !horizontal, maxRotation: 0, font: { family: "IBM Plex Mono", size: 10 } },
    };
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      indexAxis: horizontal ? "y" : "x",
      interaction: { mode: "index", intersect: false, axis: horizontal ? "y" : "x" },
      scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
      plugins: {
        legend: legend
          ? { display: true, align: "start", labels: { color: css("--ink"), boxWidth: 10, boxHeight: 10, font: { family: "Manrope", size: 12 } } }
          : { display: false },
        tooltip: {
          backgroundColor: "#0a0c0e",
          borderColor: css("--line"),
          borderWidth: 1,
          titleColor: css("--muted"),
          bodyColor: css("--ink"),
          titleFont: { family: "IBM Plex Mono", size: 11, weight: "normal" },
          bodyFont: { family: "Manrope", size: 13, weight: "bold" },
          padding: 10,
          boxWidth: 10,
          boxHeight: 2,
          callbacks: {
            label: (ctx) => {
              const v = horizontal ? ctx.parsed.x : ctx.parsed.y;
              const val = percent ? pct(v) : fmt.format(v);
              return ctx.chart.data.datasets.length > 1 ? `${val}  ${ctx.dataset.label}` : val;
            },
          },
        },
      },
    };
  }

  function barDataset(label, data, color) {
    return {
      label,
      data,
      backgroundColor: color,
      hoverBackgroundColor: color + "dd",
      borderRadius: 4,
      borderSkipped: "start",
      maxBarThickness: 22,
      categoryPercentage: 0.8,
      barPercentage: 0.9,
    };
  }

  function renderChart(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas || !window.Chart) return;
    charts.get(id)?.destroy();
    charts.set(id, new window.Chart(canvas, config));
  }

  /** Table view for a card: columns = [{key,label,format?}], rows = objects. */
  function setTable(cardId, columns, rows) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const holder = $(".viz-table", card);
    holder.textContent = "";
    const table = el("table");
    table.appendChild(el("thead", {}, [el("tr", {}, columns.map((c) => el("th", { text: c.label })))]));
    const tbody = el("tbody");
    rows.forEach((r) => tbody.appendChild(el("tr", {}, columns.map((c) => el("td", { text: c.format ? c.format(r[c.key], r) : String(r[c.key] ?? "—") })))));
    table.appendChild(tbody);
    holder.appendChild(table);
  }

  function emptyState(cardId, show, text = "No data yet") {
    const card = document.getElementById(cardId);
    if (!card) return;
    let note = $(".viz-empty", card);
    if (!note) {
      note = el("p", { class: "viz-empty hint" });
      $(".viz-body", card).prepend(note);
    }
    note.textContent = text;
    note.hidden = !show;
    const canvas = $("canvas", card);
    if (canvas) canvas.style.visibility = show ? "hidden" : "visible";
  }

  // ---------------------------------------------------------------- Sections
  function tile(label, value, sub) {
    return el("div", { class: "kpi" }, [
      el("span", { class: "kpi-label", text: label }),
      el("strong", { class: "kpi-value", text: value }),
      el("span", { class: "kpi-sub", text: sub || "" }),
    ]);
  }

  async function loadOverview() {
    const o = await getJson(`/api/analytics/overview?days=${days}`);
    const t = o.totals;
    const k = $("#kpiRow");
    k.textContent = "";
    const secs = t.median_seconds_to_anchor;
    const anchorTime = secs == null ? "—" : secs < 90 ? `${Math.round(secs)} s` : secs < 5400 ? `${Math.round(secs / 60)} min` : `${(secs / 3600).toFixed(1)} h`;
    k.append(
      tile("Sealed repairs", fmt.format(t.proofs), `${fmt.format(t.vins)} VINs`),
      tile("Anchored", pct(t.anchor_rate, 0), `${fmt.format(t.pending_proofs)} pending · ${fmt.format(t.batches)} batches`),
      tile("Median seal → anchor", anchorTime, "time until on-chain/OTS"),
      tile("High severity", fmt.format(t.high_severity), t.proofs ? `${pct(t.high_severity / t.proofs, 0)} of repairs` : ""),
      tile("Avg confidence", t.avg_confidence == null ? "—" : t.avg_confidence.toFixed(2), "engine self-reported"),
      tile("Buyer lookups", fmt.format(o.buyer_lookups.total), o.buyer_lookups.hit_rate == null ? "" : `${pct(o.buyer_lookups.hit_rate, 0)} found history`),
    );

    const perDay = o.proofs_per_day;
    renderChart("chartPerDay", {
      type: "bar",
      data: { labels: perDay.map((d) => d.day.slice(5)), datasets: [barDataset("Sealed", perDay.map((d) => d.sealed), css("--viz-1"))] },
      options: baseOptions(),
    });
    emptyState("cardPerDay", !perDay.some((d) => d.sealed), "No repairs sealed in this window yet — seal one in the workshop bay.");
    setTable("cardPerDay", [{ key: "day", label: "Day" }, { key: "sealed", label: "Sealed" }, { key: "high_severity", label: "High severity" }], perDay.filter((d) => d.sealed));

    const codes = o.top_fault_codes;
    renderChart("chartCodes", {
      type: "bar",
      data: { labels: codes.map((c) => c.fault_code), datasets: [barDataset("Repairs", codes.map((c) => c.n), css("--viz-1"))] },
      options: baseOptions({ horizontal: true }),
    });
    emptyState("cardCodes", !codes.length);
    setTable("cardCodes", [
      { key: "fault_code", label: "Code" },
      { key: "description", label: "Description" },
      { key: "n", label: "Repairs" },
      { key: "vins", label: "VINs" },
    ], codes);

    const sevOrder = ["high", "medium", "low", "unknown"];
    const sev = [...o.severity_mix].sort((a, b) => sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity));
    renderChart("chartSeverity", {
      type: "bar",
      data: { labels: sev.map((s) => s.severity), datasets: [barDataset("Repairs", sev.map((s) => s.n), css("--viz-1"))] },
      options: baseOptions({ horizontal: true }),
    });
    emptyState("cardSeverity", !sev.length);
    setTable("cardSeverity", [{ key: "severity", label: "Severity" }, { key: "n", label: "Repairs" }], sev);

    const eng = $("#engineTable");
    eng.textContent = "";
    o.engines.forEach((e) =>
      eng.appendChild(el("tr", {}, [
        el("td", { text: e.engine }),
        el("td", { text: fmt.format(e.n) }),
        el("td", { text: e.avg_confidence == null ? "—" : e.avg_confidence.toFixed(2) }),
        el("td", { text: e.median_ms == null ? "—" : `${fmt.format(e.median_ms)} ms` }),
      ])),
    );
    if (!o.engines.length) eng.appendChild(el("tr", {}, [el("td", { colspan: "4", class: "hint", text: "No diagnoses yet" })]));
  }

  async function loadComplaints() {
    const q = vehicleFilter ? `?${new URLSearchParams(JSON.parse(vehicleFilter))}` : "";
    const c = await getJson(`/api/analytics/complaints${q}`);
    const sel = $("#vehicleSelect");
    if (!vehicleFilter && sel.options.length <= 1) {
      c.by_vehicle.forEach((v) => {
        const value = JSON.stringify({ make: v.make, model: v.model, year: String(v.model_year) });
        sel.appendChild(el("option", { value, text: `${v.model_year} ${v.make} ${v.model} (${fmt.format(v.complaints)})` }));
      });
    }
    $("#nhtsaTotals").textContent =
      `${fmt.format(c.totals.complaints)} complaints · ${fmt.format(c.totals.crashes)} crashes · ` +
      `${fmt.format(c.totals.fires)} fires · ${fmt.format(c.totals.injuries)} injuries`;

    const comps = c.by_component.filter((x) => x.component !== "UNKNOWN OR OTHER").slice(0, 10);
    renderChart("chartComponents", {
      type: "bar",
      data: { labels: comps.map((x) => x.component), datasets: [barDataset("Complaints", comps.map((x) => x.n), css("--viz-1"))] },
      options: baseOptions({ horizontal: true }),
    });
    setTable("cardComponents", [
      { key: "component", label: "Component" },
      { key: "n", label: "Complaints" },
      { key: "share_pct", label: "Share", format: (v) => `${v}%` },
      { key: "crashes", label: "Crashes" },
    ], c.by_component);

    const years = c.by_incident_year.filter((y) => y.year >= 2012);
    renderChart("chartYears", {
      type: "bar",
      data: { labels: years.map((y) => String(y.year)), datasets: [barDataset("Complaints", years.map((y) => y.n), css("--viz-1"))] },
      options: baseOptions(),
    });
    setTable("cardYears", [{ key: "year", label: "Incident year" }, { key: "n", label: "Complaints" }], years);

    renderHeatmap(c.component_heatmap);
  }

  /** Component share per vehicle — an HTML grid heatmap (sequential blue, value printed in-cell). */
  function renderHeatmap(cells) {
    const host = $("#heatmap");
    host.textContent = "";
    if (!cells.length) return;
    const vehicles = [...new Set(cells.map((c) => c.vehicle))];
    const comps = [...new Set(cells.map((c) => c.component))];
    const max = Math.max(...cells.map((c) => c.share_pct));
    const ramp = ["#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef"];
    const color = (v) => ramp[Math.min(ramp.length - 1, Math.floor((v / max) * (ramp.length - 1)))];
    const table = el("table", { class: "heat" });
    table.appendChild(el("thead", {}, [el("tr", {}, [el("th", { text: "" }), ...comps.map((c) => el("th", { text: c, title: c }))])]));
    const tb = el("tbody");
    vehicles.forEach((v) => {
      const tr = el("tr", {}, [el("th", { text: v })]);
      comps.forEach((comp) => {
        const cell = cells.find((x) => x.vehicle === v && x.component === comp);
        const td = el("td", { tabindex: "0" });
        if (cell) {
          td.style.background = color(cell.share_pct);
          td.style.color = cell.share_pct / max > 0.62 ? "#0a0c0e" : "#e8ebe6";
          td.textContent = `${cell.share_pct}`;
          td.title = `${v} · ${comp}: ${cell.share_pct}% of its complaints (${cell.n})`;
        } else {
          td.textContent = "·";
          td.className = "heat-empty";
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    host.appendChild(table);
  }

  async function loadModels() {
    const rows = await getJson("/api/analytics/models");
    const bench = rows.filter((r) => r.benchmark === "primary_obd_holdout_n57");
    const metrics = [
      ["fault_code_accuracy", "Fault code"],
      ["json_validity_rate", "Valid JSON"],
      ["schema_completeness_rate", "Schema"],
      ["severity_accuracy", "Severity"],
      ["rouge_l_repair_steps", "ROUGE-L steps"],
    ];
    const series = [
      ["tinyllama", "TinyLlama LoRA", css("--viz-s1")],
      ["mistral_mlx", "Mistral 7B MLX", css("--viz-s2")],
    ];
    renderChart("chartModels", {
      type: "bar",
      data: {
        labels: metrics.map((m) => m[1]),
        datasets: series
          .map(([key, label, color]) => {
            const r = bench.find((b) => b.model === key);
            return r ? barDataset(label, metrics.map(([m]) => r[m]), color) : null;
          })
          .filter(Boolean),
      },
      options: baseOptions({ percent: true, legend: true }),
    });
    emptyState("cardModels", !bench.length, "No benchmark results loaded");
    setTable("cardModels", [
      { key: "benchmark", label: "Benchmark" },
      { key: "model", label: "Model" },
      { key: "n", label: "n" },
      ...metrics.map(([k, l]) => ({ key: k, label: l, format: (v) => pct(v) })),
    ], rows);
  }

  async function loadDtc() {
    const d = await getJson("/api/analytics/dtc");
    const tb = $("#costTable");
    tb.textContent = "";
    d.most_expensive_first_fix.forEach((r) =>
      tb.appendChild(el("tr", {}, [
        el("td", { class: "mono", text: r.dtc_code }),
        el("td", { text: r.fix_title }),
        el("td", { class: "num", text: `$${fmt.format(r.parts_cost_min_usd)}–$${fmt.format(r.parts_cost_max_usd)}` }),
        el("td", { class: "num", text: r.labor_hours == null ? "—" : `${r.labor_hours} h` }),
        el("td", { text: r.difficulty_level || "—" }),
      ])),
    );
  }

  async function loadAi4i() {
    const a = await getJson("/api/analytics/ai4i");
    $("#ai4iTotals").textContent = `${fmt.format(a.totals.readings)} readings · ${a.totals.failure_rate_pct}% failed`;
    const wear = a.by_tool_wear;
    const opts = baseOptions();
    opts.scales.y.ticks.callback = (v) => `${v}%`;
    opts.plugins.tooltip.callbacks.label = (ctx) => `${ctx.parsed.y.toFixed(2)}% failed`;
    renderChart("chartWear", {
      type: "bar",
      data: {
        labels: wear.map((w) => `${w.wear_from_min}+`),
        datasets: [barDataset("Failure rate", wear.map((w) => w.failure_rate_pct), css("--viz-1"))],
      },
      options: opts,
    });
    setTable("cardWear", [
      { key: "wear_from_min", label: "Tool wear from (min)" },
      { key: "readings", label: "Readings" },
      { key: "failure_rate_pct", label: "Failure rate", format: (v) => `${v}%` },
    ], wear);
  }

  async function loadLineage() {
    const rows = await getJson("/api/analytics/datasets");
    const tb = $("#lineageTable");
    tb.textContent = "";
    rows.forEach((r) =>
      tb.appendChild(el("tr", {}, [
        el("td", { text: r.dataset }),
        el("td", { class: "mono", text: r.source_path }),
        el("td", { class: "num", text: fmt.format(r.row_count) }),
        el("td", { class: "mono", text: `${r.source_sha256.slice(0, 12)}…`, title: r.source_sha256 }),
      ])),
    );
  }

  // ---------------------------------------------------------------- Buyer risk (used by app.js)
  async function renderVehicleRisk(vehicle, host) {
    host.textContent = "";
    host.hidden = true;
    if (!vehicle) return;
    let r;
    try {
      r = await getJson(`/api/analytics/vehicle-risk?vehicle=${encodeURIComponent(vehicle)}`);
    } catch {
      return;
    }
    if (!r.matched) return;
    host.hidden = false;
    host.append(
      el("h3", { text: `Known issues · ${vehicle}` }),
      el("p", { class: "hint", text: `${r.headline}. Source: ${fmt.format(r.nhtsa.complaints)} NHTSA owner complaints (${fmt.format(r.nhtsa.crashes)} with crashes).` }),
    );
    const max = Math.max(...r.components.map((c) => c.share_pct), 1);
    const list = el("div", { class: "risk-bars" });
    r.components.forEach((c) => {
      const bar = el("span", { class: "risk-fill" });
      bar.style.width = `${(c.share_pct / max) * 100}%`;
      list.appendChild(
        el("div", { class: "risk-row", title: `${c.n} complaints · ${c.crashes} crashes` }, [
          el("span", { class: "risk-name", text: c.component }),
          el("span", { class: "risk-track" }, [bar]),
          el("span", { class: "risk-val", text: `${c.share_pct}%` }),
          el("span", { class: `risk-lift${c.lift >= 1.5 ? " hot" : ""}`, text: c.lift == null ? "" : `${c.lift}× fleet` }),
        ]),
      );
    });
    host.appendChild(list);
    if (r.registry?.sealed_repairs) {
      host.appendChild(el("p", { class: "hint", text: `Registry: ${r.registry.sealed_repairs} sealed repair(s) on ${r.registry.vins} VIN(s) of this model; most common fault ${r.registry.most_common_fault || "—"}.` }));
    }
  }

  // ---------------------------------------------------------------- Wiring
  async function refresh(part = "all") {
    const root = $("#insights");
    root.classList.add("refreshing");
    const jobs = {
      overview: loadOverview,
      complaints: loadComplaints,
      models: loadModels,
      dtc: loadDtc,
      ai4i: loadAi4i,
      lineage: loadLineage,
    };
    const run = part === "all" ? Object.values(jobs) : [jobs[part]];
    await Promise.all(run.map((fn) => fn().catch((e) => console.warn("[insights]", e))));
    root.classList.remove("refreshing");
  }

  function init() {
    document.querySelectorAll("[data-table-toggle]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const card = btn.closest(".viz-card");
        const on = card.classList.toggle("show-table");
        btn.textContent = on ? "Chart" : "Table";
        btn.setAttribute("aria-pressed", String(on));
      }),
    );
    $("#daysSelect").addEventListener("change", (e) => {
      days = Number(e.target.value);
      refresh("overview");
    });
    $("#vehicleSelect").addEventListener("change", (e) => {
      vehicleFilter = e.target.value;
      refresh("complaints");
    });
    refresh();
  }

  window.PorInsights = { refresh, renderVehicleRisk };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
