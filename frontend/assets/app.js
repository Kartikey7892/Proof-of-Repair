(() => {
  const $ = (sel) => document.querySelector(sel);
  const form = $("#diagForm");
  const loader = $("#loader");
  const loaderText = $("#loaderText");
  const proofSection = $("#proof");
  const healthPill = $("#healthPill");
  const chainPill = $("#chainPill");
  const otsPill = $("#otsPill");
  const pendingCount = $("#pendingCount");
  const verifyGrid = $("#verifyGrid");
  const anchorPlate = $("#anchorPlate");
  const btnVerify = $("#btnVerify");
  const btnAnchor = $("#btnAnchor");
  const demoChips = $("#demoChips");
  const engineSelect = $("#engineSelect");
  const vinForm = $("#vinForm");
  const vinTimeline = $("#vinTimeline");
  const vinTrust = $("#vinTrust");
  const vinHint = $("#vinHint");

  let lastProof = null;
  let pending = 0;
  let lastChainTx = null;
  let lastLookupVin = "";

  function setLoading(on, text) {
    loader.hidden = !on;
    if (text) loaderText.textContent = text;
  }

  function short(hex, n = 18) {
    if (!hex) return "—";
    return hex.length > n ? `${hex.slice(0, n)}…` : hex;
  }

  function fillForm(caseData) {
    const f = form.elements;
    f.vin.value = caseData.vin || "";
    f.vehicle.value = caseData.vehicle || "";
    f.odometer_km.value = caseData.odometer_km ?? "";
    f.dtc_codes.value = caseData.dtc_codes || "";
    f.symptoms.value = caseData.symptoms || "";
    f.sensor_notes.value = caseData.sensor_notes || "";
  }

  async function refreshHealth() {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      const engines = data.engines || {};
      healthPill.textContent = `api ok · tinyllama ${engines.tinyllama ? "ready" : "missing"} · mistral ${engines.mistral ? "ready" : "missing"} · ${data.storage?.backend || "db"}`;
      healthPill.classList.add("ok");
      pending = data.pending_leaves || 0;
      pendingCount.textContent = `${pending} pending`;
      if (!engines.mistral) {
        const opt = engineSelect.querySelector('option[value="mistral"]');
        if (opt) opt.disabled = true;
      }
      const chain = data.chain || {};
      if (chainPill) {
        if (chain.mode === "live_evm") {
          chainPill.textContent = `LIVE · ${chain.network} · id ${chain.chain_id} · ${short(chain.contract_address, 12)}`;
          chainPill.classList.add("live");
          chainPill.title = `RPC ${chain.rpc_url} | contract ${chain.contract_address} | block ${chain.block_number}`;
        } else {
          chainPill.textContent = `sim · ${chain.mode || "in_memory"}`;
          chainPill.classList.remove("live");
        }
      }
      const ots = data.ots || {};
      if (otsPill) {
        if (ots.mode === "live_ots") {
          otsPill.textContent = "OTS live · pending→BTC";
          otsPill.classList.add("live");
          otsPill.title = (ots.calendars || []).join("\n") || ots.note || "";
        } else {
          otsPill.textContent = `OTS · ${ots.mode || "sim"}`;
          otsPill.classList.remove("live");
          otsPill.title = ots.note || "";
        }
      }
    } catch (e) {
      healthPill.textContent = "api offline";
      healthPill.classList.remove("ok");
      if (chainPill) chainPill.textContent = "chain offline";
      if (otsPill) otsPill.textContent = "ots offline";
    }
  }

  function formatWhen(ts) {
    if (!ts) return "—";
    try {
      return new Date(Number(ts) * 1000).toLocaleString();
    } catch (_) {
      return String(ts);
    }
  }

  function trustLabel(summary, count, anchored) {
    if (summary === "verified_timeline") {
      return `VERIFIED · ${count} event(s) anchored on chain/OTS`;
    }
    if (summary === "partial") {
      return `PARTIAL · ${anchored}/${count} anchored — seal remaining batch`;
    }
    if (summary === "sealed_only") {
      return `SEALED · ${count} event(s) not yet batch-anchored`;
    }
    return "NO ATTESTATIONS · workshop has not sealed this VIN here";
  }

  async function lookupVin(vin, { scroll } = { scroll: true }) {
    const v = (vin || "").trim().toUpperCase();
    if (v.length < 11) {
      vinHint.textContent = "Enter a full VIN (11+ characters).";
      return;
    }
    lastLookupVin = v;
    setLoading(true, "Looking up VIN timeline…");
    try {
      const res = await fetch(`/api/vin/${encodeURIComponent(v)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
      }
      const data = await res.json();
      vinHint.textContent = `${data.vin} · ${data.count} attestation(s)`;
      vinTrust.hidden = false;
      vinTrust.className = `trust-banner ${data.trust_summary || "empty"}`;
      if (data.trust_summary === "verified_timeline") vinTrust.classList.add("verified");
      if (data.trust_summary === "partial") vinTrust.classList.add("partial");
      vinTrust.textContent = trustLabel(data.trust_summary, data.count, data.anchored_count);

      vinTimeline.hidden = false;
      vinTimeline.innerHTML = "";
      (data.timeline || []).forEach((ev, i) => {
        const item = document.createElement("article");
        item.className = `tl-item${ev.anchored ? " anchored" : ""}`;
        item.style.animationDelay = `${i * 0.06}s`;
        const parts = (ev.parts || [])
          .map((p) => `<li>${p}</li>`)
          .join("");
        const badge = ev.anchored
          ? `<span class="tl-badge on">anchored</span>`
          : `<span class="tl-badge">sealed</span>`;
        item.innerHTML = `
          <div class="tl-head">
            <span class="tl-code">${ev.fault_code || "—"}</span>
            ${badge}
            <span class="tl-meta">${formatWhen(ev.when)} · ${ev.odometer_km ?? "—"} km · ${ev.issuer_id || "workshop"}</span>
          </div>
          <p class="tl-body">${ev.diagnosis || ""}</p>
          ${parts ? `<ul class="tl-parts">${parts}</ul>` : ""}
          <p class="tl-meta" style="margin-top:0.45rem">leaf ${short(ev.leaf_digest, 20)}${ev.anchor?.merkle_root ? ` · root ${short(ev.anchor.merkle_root, 16)}` : ""}</p>
        `;
        vinTimeline.appendChild(item);
      });
      if (!(data.timeline || []).length) {
        vinTimeline.innerHTML = `<p class="hint">No sealed repairs for this VIN in the local registry.</p>`;
      }
      if (scroll) {
        document.getElementById("lookup").scrollIntoView({ behavior: "smooth" });
      }
    } catch (err) {
      alert(`VIN lookup failed: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  }

  vinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    lookupVin(new FormData(vinForm).get("vin").toString());
  });

  async function loadDemoCases() {
    try {
      const res = await fetch("/api/demo_cases");
      const cases = await res.json();
      demoChips.innerHTML = "";
      cases.forEach((c, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = `${c.vehicle.split(" ").slice(-1)[0]} · ${c.dtc_codes}`;
        b.addEventListener("click", () => {
          fillForm(c);
          vinForm.elements.vin.value = c.vin || "";
          document.getElementById("inspect").scrollIntoView({ behavior: "smooth" });
        });
        demoChips.appendChild(b);
        if (i === 0) window.__firstDemo = c;
      });
    } catch (_) {
      /* ignore */
    }
  }

  function renderReport(payload) {
    const report = payload.report || {};
    const proof = payload.proof || {};
    const model = proof.model || {};

    proofSection.hidden = false;
    $("#faultCode").textContent = report.fault_code || "—";
    $("#severity").textContent = `severity · ${report.severity || "—"}`;
    $("#diagnosis").textContent = report.diagnosis || "";
    $("#buyerAdvice").textContent = report.buyer_advice || "";
    $("#reportMeta").textContent = `${proof.vehicle || ""} · VIN ${proof.vin || ""} · engine ${payload.engine || ""} · ${model.model_version || ""}`;

    const steps = $("#repairSteps");
    steps.innerHTML = "";
    (report.repair_steps || []).forEach((s) => {
      const li = document.createElement("li");
      li.textContent = s;
      steps.appendChild(li);
    });

    const parts = $("#parts");
    parts.innerHTML = "";
    (report.parts || []).forEach((p) => {
      const li = document.createElement("li");
      li.textContent = p;
      parts.appendChild(li);
    });

    $("#leafDigest").textContent = proof.leaf_digest || "—";
    $("#reportHash").textContent = proof.report_hash || "—";
    $("#evidenceCid").textContent = proof.evidence_cid || "—";
    $("#adapterHash").textContent = short(model.adapter_hash, 24);

    lastProof = proof;
    pending = payload.pending_batch_size ?? pending + 1;
    pendingCount.textContent = `${pending} pending`;
    btnVerify.disabled = !lastProof;
    proofSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      vin: fd.get("vin").toString().trim(),
      vehicle: fd.get("vehicle").toString().trim(),
      odometer_km: Number(fd.get("odometer_km")),
      symptoms: fd.get("symptoms").toString().trim(),
      dtc_codes: fd.get("dtc_codes").toString().trim(),
      sensor_notes: fd.get("sensor_notes").toString().trim(),
      engine: fd.get("engine").toString(),
    };

    setLoading(true, body.engine === "mistral" ? "Mistral diagnosing (can take a few minutes)…" : "Diagnosing & sealing proof…");
    try {
      const res = await fetch("/api/diagnose_and_prove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
      }
      const data = await res.json();
      renderReport(data);
      $("#formHint").textContent = "Sealed to VIN. Anchor the batch, then buyer can look it up.";
      if (body.vin) {
        vinForm.elements.vin.value = body.vin;
        lookupVin(body.vin, { scroll: false });
      }
    } catch (err) {
      alert(`Diagnosis failed: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  });

  btnAnchor.addEventListener("click", async () => {
    setLoading(true, "Anchoring Merkle batch…");
    try {
      const res = await fetch("/api/anchor_batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_id: `ui-${Date.now()}` }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
      }
      const data = await res.json();
      anchorPlate.hidden = false;
      $("#merkleRoot").textContent = data.merkle_root || "—";
      $("#otsId").textContent = data.ots_receipt?.receipt_id || "—";
      const ots = data.ots_receipt || {};
      if (ots.mode === "live_ots") {
        const cal = (ots.pending_calendars && ots.pending_calendars[0]) || ots.calendar_url || "";
        $("#otsId").textContent = `${ots.receipt_id} · ${ots.status}${cal ? " · " + cal.replace(/^https?:\/\//, "") : ""}`;
        $("#otsId").title = ots.ots_file || "";
      }
      const tx = data.chain_tx || {};
      const txHash = tx.tx_hash || tx || "—";
      $("#chainTx").textContent = typeof txHash === "string" ? txHash : JSON.stringify(txHash);
      lastChainTx = tx;
      if (tx.explorer_url) {
        $("#chainTx").innerHTML = `<a href="${tx.explorer_url}" target="_blank" rel="noreferrer">${tx.tx_hash}</a>`;
      }
      if (tx.mode === "live_evm") {
        $("#formHint").textContent = `Anchored on ${tx.network} (chainId ${tx.chain_id}) in block ${tx.block_number}.`;
      }
      pending = 0;
      pendingCount.textContent = "0 pending";
      btnVerify.disabled = !lastProof;
      refreshHealth();
      if (lastLookupVin || lastProof?.vin) {
        lookupVin(lastLookupVin || lastProof.vin, { scroll: false });
      }
    } catch (err) {
      alert(`Anchor failed: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  });

  btnVerify.addEventListener("click", async () => {
    if (!lastProof) return;
    setLoading(true, "Verifying proof…");
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proof: lastProof }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
      }
      const data = await res.json();
      verifyGrid.hidden = false;
      verifyGrid.innerHTML = "";
      Object.entries(data).forEach(([k, v]) => {
        const el = document.createElement("div");
        el.className = `v-item ${v ? "ok" : "bad"}`;
        el.textContent = `${k}: ${v ? "PASS" : "FAIL"}`;
        verifyGrid.appendChild(el);
      });
    } catch (err) {
      alert(`Verify failed: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  });

  refreshHealth();
  loadDemoCases();
  setInterval(refreshHealth, 15000);
})();
