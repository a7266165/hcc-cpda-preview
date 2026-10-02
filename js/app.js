// HCC-CPDA web MVP: form, validation, rendering and URL-hash handling (calculator and about page).
// Inputs stay in this page: they are never sent, stored, logged or written to the URL. The form and
// every input carry autocomplete="off", so the browser does not keep their values for form restore.

import {
  initI18n, t, lang, setLang, onLangChange, wireLangToggle, fmt, fmtPlain,
} from "./i18n.js";
import { renderChart, makeSwatch } from "./chart.js";
import { thresholdDisplay, smallValueDisplay } from "./format.js";

const PAGE = document.body.dataset.page || "calc";
const NUMBER_RE = /^(\d+\.?\d*|\.\d+)$/;

const state = {
  config: null,
  fields: [],
  support: null,
  supportOk: false,
  supportPromise: Promise.resolve(),
  supportSettled: false,
  engine: null,
  model: null,
  manifest: null,
  shortHash: null,
  modelStatus: "loading", // loading | ready | nomodel | noengine | noconfig
  values: {},
  touched: new Set(),
  attempted: false,
  example: null, // stage letter while the inputs are an unedited synthetic example
  undo: null, // inputs replaced by "Load synthetic example", kept in memory until the next edit
  result: null,
  resultMeta: null,
  stale: false,
  error: null,
  highlight: "",
  detailsOpen: false,
  status: { key: "status.loading", params: null },
  notice: null, // array of {key, params}, shown in #form-notice (role=status)
  exampleHint: false,
};

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

/** Set text only when it changes, so live regions are not re-announced on every render. */
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Announce `text` once through a (visually hidden) status region, even if it repeats. */
function announce(el, text) {
  if (!el) return;
  el.textContent = "";
  setTimeout(() => { el.textContent = text; }, 60);
}

async function fetchJson(path) {
  const url = path instanceof URL ? path : new URL(path, document.baseURI);
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.pathname}`);
  return res.json();
}

/** Give stacked tables explicit roles and per-cell labels (used by the narrow-screen layout). */
function labelTables(root = document) {
  for (const table of root.querySelectorAll("table.stack")) {
    table.setAttribute("role", "table");
    const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    for (const g of table.querySelectorAll("thead, tbody")) g.setAttribute("role", "rowgroup");
    for (const tr of table.querySelectorAll("tr")) {
      tr.setAttribute("role", "row");
      [...tr.children].forEach((cell, i) => {
        if (cell.closest("thead")) {
          cell.setAttribute("role", "columnheader");
        } else if (cell.tagName === "TH") {
          cell.setAttribute("role", "rowheader");
        } else {
          cell.setAttribute("role", "cell");
          if (heads[i]) cell.setAttribute("data-label", heads[i]);
        }
      });
    }
  }
}

function parseHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ""));
  return { example: p.get("example"), lang: p.get("lang"), highlight: p.get("highlight") };
}

async function shortBoosterHash(manifest) {
  const list = (manifest && Array.isArray(manifest.boosters) ? manifest.boosters : [])
    .map((b) => b.sha256 || "").join("\n");
  if (!list) return null;
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(list));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
  } catch {
    return null; // crypto.subtle needs a secure context (https or localhost)
  }
}

/** Skip link: focus a visible target without writing the target id into the URL hash. */
function wireSkipLink(getTarget) {
  const link = document.querySelector(".skip-link");
  if (!link) return;
  link.addEventListener("click", (evt) => {
    const target = getTarget();
    if (!target) return;
    evt.preventDefault();
    if (!target.hasAttribute("tabindex")) {
      target.setAttribute("tabindex", "-1");
      target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
    }
    target.focus();
  });
}

// ---------------------------------------------------------------------------
// Footer (both pages)
// ---------------------------------------------------------------------------

function setStatus(key, params = null) {
  state.status = { key, params };
  renderFooter();
}

function renderFooter() {
  const model = $("footer-model");
  if (model) {
    model.textContent = state.manifest
      ? t("footer.model", { version: state.manifest.model_version || "?", hash: state.shortHash || "—" })
      : t("footer.model_none");
  }
  const status = $("footer-status");
  if (status) {
    let text = t(state.status.key, state.status.params || undefined);
    if (PAGE === "calc" && state.config && !state.supportOk && state.supportSettled) {
      text += `; ${t("status.nosupport")}`;
    }
    setText(status, t("footer.status", { text }));
  }
}

// ---------------------------------------------------------------------------
// Calculator: form
// ---------------------------------------------------------------------------

function unitText(f) {
  return f.unit ? t(`unit.${f.unit}`) : t("unit.none");
}

function unitSuffix(f) {
  return f.unit ? ` ${t(`unit.${f.unit}`)}` : "";
}

function buildForm() {
  for (const f of state.fields) {
    const host = document.querySelector(`[data-fields-for="${f.section}"]`);
    if (!host) continue;
    const id = `f-${f.name}`;
    if (f.kind === "number") {
      const input = h("input", {
        id, name: f.name, type: "text", inputmode: "decimal", autocomplete: "off",
        spellcheck: "false", required: true, "aria-required": "true",
        "aria-describedby": `${id}-unit ${id}-hint ${id}-msg`, class: "num-input",
      });
      input.addEventListener("input", () => onNumberInput(f, input));
      input.addEventListener("change", () => onFieldTouched(f));
      input.addEventListener("blur", () => onFieldTouched(f));
      host.append(h("div", { class: `field field-number field-${f.name}`, "data-field": f.name },
        h("label", { for: id, class: "field-label", "data-i18n": `field.${f.name}.label` }),
        h("div", { class: "num-wrap" }, input,
          h("span", { class: "unit", id: `${id}-unit`, "data-unit-for": f.name })),
        h("p", { class: "field-hint", id: `${id}-hint`, "data-range-for": f.name }),
        h("p", { class: "field-msg", id: `${id}-msg`, "data-msg-for": f.name })));
    } else {
      const seg = h("div", { class: `seg seg-${f.options.length}` });
      for (const opt of f.options) {
        const oid = `${id}-${String(opt)}`;
        const radio = h("input", {
          type: "radio", id: oid, name: f.name, value: String(opt), class: "seg-input", required: true,
          autocomplete: "off",
        });
        radio.addEventListener("change", () => onChoice(f, opt));
        seg.append(radio, h("label", { for: oid, class: "seg-label", "data-i18n": `field.${f.name}.opt.${opt}` }));
      }
      const describedBy = [];
      const hintKey = ["stage", "site"].includes(f.name) ? `field.${f.name}.hint` : null;
      if (hintKey) describedBy.push(`${id}-hint`);
      describedBy.push(`${id}-msg`);
      host.append(h("fieldset", {
        class: `field field-choice field-${f.name}`, "data-field": f.name, id,
        "aria-describedby": describedBy.join(" "),
      },
      h("legend", { class: "field-label", "data-i18n": `field.${f.name}.label` }),
      seg,
      hintKey ? h("p", { class: "field-hint", id: `${id}-hint`, "data-i18n": hintKey }) : null,
      h("p", { class: "field-msg", id: `${id}-msg`, "data-msg-for": f.name })));
    }
  }
}

function normaliseNumber(raw) {
  return String(raw ?? "").normalize("NFKC").trim();
}

function validateField(f) {
  const raw = state.values[f.name];
  if (f.kind !== "number") {
    return raw === undefined || raw === null || raw === "" ? { status: "empty" } : { status: "ok", value: raw };
  }
  const s = normaliseNumber(raw);
  if (s === "") return { status: "empty" };
  if (!NUMBER_RE.test(s)) return { status: "format" };
  const v = Number(s);
  if (!Number.isFinite(v)) return { status: "format" };
  if (v < f.min || v > f.max) return { status: "range", value: v };
  const lowSoft = f.soft_min !== undefined && f.soft_min !== null && v < f.soft_min;
  const highSoft = f.soft_max !== undefined && f.soft_max !== null && v > f.soft_max;
  if (lowSoft || highSoft) return { status: "soft", value: v };
  return { status: "ok", value: v };
}

const isComplete = (r) => r.status === "ok" || r.status === "soft";

/** Errors are shown (and counted for the reason line) only after a field is left or Project is tried. */
const errorShown = (f) => state.touched.has(f.name) || state.attempted;

function formSummary() {
  let complete = 0;
  let invalid = 0;
  let invalidShown = 0;
  const bySection = {};
  for (const f of state.fields) {
    const r = validateField(f);
    const sec = (bySection[f.section] ||= { n: 0, total: 0 });
    sec.total += 1;
    if (isComplete(r)) {
      complete += 1;
      sec.n += 1;
    } else if (r.status === "format" || r.status === "range") {
      invalid += 1;
      if (errorShown(f)) invalidShown += 1;
    }
  }
  return { complete, invalid, invalidShown, total: state.fields.length, bySection };
}

function fieldMessage(f, r) {
  const show = errorShown(f);
  if (r.status === "format" && show) return { cls: "is-error", text: t("valid.format") };
  if (r.status === "range" && show) {
    return { cls: "is-error", text: t("valid.range", { min: fmtPlain(f.min), max: fmtPlain(f.max), unit: unitSuffix(f) }) };
  }
  if (r.status === "soft") {
    return {
      cls: "is-warn",
      text: t("valid.soft", { min: fmtPlain(f.soft_min), max: fmtPlain(f.soft_max), unit: unitSuffix(f) }),
    };
  }
  if (r.status === "empty" && state.attempted) return { cls: "is-error", text: t("valid.required") };
  return { cls: "", text: "" };
}

function renderFieldStates() {
  for (const f of state.fields) {
    const r = validateField(f);
    const msg = fieldMessage(f, r);
    const wrap = document.querySelector(`[data-field="${f.name}"]`);
    const msgEl = document.querySelector(`[data-msg-for="${f.name}"]`);
    if (msgEl) {
      setText(msgEl, msg.text);
      msgEl.className = `field-msg ${msg.cls}`.trim();
    }
    if (wrap) {
      wrap.classList.toggle("is-error", msg.cls === "is-error");
      wrap.classList.toggle("is-warn", msg.cls === "is-warn");
      wrap.classList.toggle("is-complete", isComplete(r));
    }
    if (f.kind === "number") {
      const input = $(`f-${f.name}`);
      if (input) input.setAttribute("aria-invalid", msg.cls === "is-error" ? "true" : "false");
      const unitEl = document.querySelector(`[data-unit-for="${f.name}"]`);
      if (unitEl) {
        // Units the draft gives only as source-data units carry a visible "assumed unit" flag.
        unitEl.textContent = unitText(f);
        if (f.unit_assumed) unitEl.append(" ", h("span", { class: "unit-flag", text: t("unit.assumed") }));
      }
      const hintEl = document.querySelector(`[data-range-for="${f.name}"]`);
      if (hintEl) hintEl.textContent = t("valid.range_hint", { min: fmtPlain(f.min), max: fmtPlain(f.max), unit: unitSuffix(f) });
    }
  }
}

function supportMissing() {
  return state.supportSettled && !state.supportOk;
}

function modelBlocked() {
  return ["nomodel", "noengine", "noconfig"].includes(state.modelStatus) || supportMissing();
}

/** Why Project survival cannot run now ("" when it can). Counts only errors that are visibly marked. */
function projectReason(s = formSummary()) {
  if (state.modelStatus === "noengine") return t("reason.noengine");
  if (["nomodel", "noconfig"].includes(state.modelStatus)) return t("reason.nomodel");
  if (supportMissing()) return t("reason.nosupport");
  if (s.invalidShown > 0) return t("reason.invalid");
  if (s.complete < s.total) return t("reason.incomplete", { total: s.total, missing: s.total - s.complete });
  if (state.modelStatus === "loading") return t("reason.loading");
  return "";
}

function noticeText() {
  if (state.exampleHint) return t("reason.example_needs_stage");
  if (!state.notice) return "";
  return state.notice.map((n) => t(n.key, n.params || undefined)).join(" ");
}

function renderFormState() {
  const s = formSummary();
  const label = $("completion-label");
  if (label) label.textContent = t("form.completion", { n: s.complete, total: s.total });
  const bar = $("completion-bar");
  if (bar) {
    bar.max = s.total;
    bar.value = s.complete;
  }
  for (const [sec, v] of Object.entries(s.bySection)) {
    const el = document.querySelector(`[data-count-for="${sec}"]`);
    if (el) {
      el.textContent = t("section.count", { n: v.n, total: v.total });
      el.classList.toggle("is-done", v.n === v.total);
      const sr = document.querySelector(`[data-count-sr-for="${sec}"]`);
      if (sr) sr.textContent = t("section.count_sr", { n: v.n, total: v.total });
    }
  }

  const reason = projectReason(s);
  const ready = reason === "";
  const btn = $("btn-project");
  if (btn) {
    btn.setAttribute("aria-disabled", ready ? "false" : "true");
    btn.classList.toggle("is-disabled", !ready);
  }
  // Not a live region: the button's aria-describedby exposes it, and a Project attempt announces it once.
  setText($("project-reason"), reason);

  const stage = state.values.stage;
  const exBtn = $("btn-example");
  if (exBtn) {
    exBtn.textContent = stage !== undefined && stage !== null && stage !== ""
      ? t("btn.example_for", { stage }) : t("btn.example");
  }
  const undoBtn = $("btn-undo");
  if (undoBtn) undoBtn.hidden = !state.undo;
  setText($("form-notice"), noticeText());
}

function markEdited() {
  state.example = null;
  state.exampleHint = false;
  state.undo = null;
  if (state.result) {
    state.stale = true;
    state.notice = [{ key: "notice.stale" }];
  } else {
    state.notice = null;
  }
}

function onNumberInput(f, input) {
  state.values[f.name] = input.value;
  markEdited();
  renderFieldStates();
  renderFormState();
  renderStale();
}

function onFieldTouched(f) {
  if (normaliseNumber(state.values[f.name]) !== "") state.touched.add(f.name);
  renderFieldStates();
  renderFormState();
}

function onChoice(f, opt) {
  state.values[f.name] = opt;
  state.touched.add(f.name);
  markEdited();
  renderFieldStates();
  renderFormState();
  renderStale();
}

function setFieldValue(name, value) {
  const f = state.fields.find((x) => x.name === name);
  if (!f) return;
  if (f.kind === "number") {
    state.values[name] = value === null || value === undefined ? "" : String(value);
    const input = $(`f-${name}`);
    if (input) input.value = state.values[name];
  } else {
    const opt = f.options.find((o) => String(o) === String(value));
    state.values[name] = opt === undefined ? undefined : opt;
    for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
      radio.checked = opt !== undefined && radio.value === String(opt);
    }
  }
}

/** True when any of the 15 predictors (not stage or site) has a value. */
function hasPredictorValues() {
  return state.fields.some((f) => f.name !== "stage" && f.name !== "site" && validateField(f).status !== "empty");
}

function loadExample(stage, site, { keepUndo = false } = {}) {
  const ex = state.config.examples && state.config.examples[stage];
  if (!ex || !ex.profile) return false;
  const undo = keepUndo && hasPredictorValues()
    ? { values: { ...state.values }, touched: new Set(state.touched), attempted: state.attempted }
    : null;
  for (const f of state.fields) {
    if (f.name === "stage" || f.name === "site") continue;
    setFieldValue(f.name, ex.profile[f.name]);
  }
  setFieldValue("stage", stage);
  const siteOk = site !== null && site !== undefined && state.config.sites.map(String).includes(String(site));
  const siteValue = siteOk ? Number(site) : ex.site;
  setFieldValue("site", siteValue);
  state.touched = new Set(state.fields.map((f) => f.name));
  state.example = stage;
  state.exampleHint = false;
  state.undo = undo;
  state.notice = [{ key: "notice.example_loaded", params: { stage, site: siteValue } }];
  if (!siteOk) state.notice.push({ key: "notice.site_defaulted", params: { site: siteValue } });
  if (undo) state.notice.push({ key: "notice.example_replaced" });
  if (state.result) state.stale = true;
  renderFieldStates();
  renderFormState();
  renderStale();
  return true;
}

function undoExample() {
  const snap = state.undo;
  if (!snap) return;
  for (const f of state.fields) {
    const v = snap.values[f.name];
    setFieldValue(f.name, f.kind === "number" ? (v ?? "") : v);
  }
  state.values = { ...snap.values };
  state.touched = new Set(snap.touched);
  state.attempted = snap.attempted;
  state.example = null;
  state.exampleHint = false;
  state.undo = null;
  state.notice = [{ key: "notice.restored" }];
  if (state.result) state.stale = true;
  renderFieldStates();
  renderFormState();
  renderStale();
  $("btn-example")?.focus();
}

function clearForm() {
  for (const f of state.fields) setFieldValue(f.name, f.kind === "number" ? "" : undefined);
  state.values = {};
  state.touched = new Set();
  state.attempted = false;
  state.example = null;
  state.undo = null;
  state.result = null;
  state.resultMeta = null;
  state.stale = false;
  state.error = null;
  state.highlight = "";
  state.exampleHint = false;
  state.notice = [{ key: "notice.cleared" }];
  renderFieldStates();
  renderFormState();
  renderResults();
  renderContext();
}

function focusFirstProblem() {
  for (const f of state.fields) {
    if (isComplete(validateField(f))) continue;
    const target = f.kind === "number" ? $(`f-${f.name}`) : document.querySelector(`input[name="${f.name}"]`);
    if (target) target.focus();
    return;
  }
}

function buildProfile() {
  const profile = {};
  for (const f of state.fields) profile[f.name] = validateField(f).value;
  return profile;
}

// ---------------------------------------------------------------------------
// Calculator: model and projection
// ---------------------------------------------------------------------------

async function loadEngineAndModel() {
  try {
    state.engine = await import("./engine.js");
  } catch (err) {
    console.warn("[engine] could not load engine.js:", err && err.message);
    state.modelStatus = "noengine";
    setStatus("status.noengine");
    renderFormState();
    renderResults();
    return false;
  }
  const base = new URL(state.config.model_path || "model/", document.baseURI);
  try {
    state.model = await state.engine.loadModel(base.href);
    state.manifest = (state.model && state.model.manifest) || await fetchJson(new URL("manifest.json", base));
    state.shortHash = await shortBoosterHash(state.manifest);
    state.modelStatus = "ready";
    const n = Array.isArray(state.manifest.boosters) ? state.manifest.boosters.length : state.manifest.n_models;
    setStatus("status.ready", { n });
  } catch (err) {
    console.warn("[model] model files unavailable:", err && err.message);
    state.model = null;
    state.modelStatus = "nomodel";
    setStatus("status.nomodel");
  }
  renderFormState();
  renderResults();
  return state.modelStatus === "ready";
}

function canProject() {
  const s = formSummary();
  return state.modelStatus === "ready" && !supportMissing() && s.invalid === 0 && s.complete === s.total;
}

async function onProject() {
  state.attempted = true;
  state.exampleHint = false;
  renderFieldStates();
  renderFormState();
  if (!canProject()) {
    // One announcement per attempt (the reason line itself is not a live region).
    announce($("form-live"), projectReason());
    if (!modelBlocked()) focusFirstProblem();
    return;
  }
  await runProjection({ focus: true });
}

async function runProjection({ focus }) {
  if (!canProject()) return;
  const profile = buildProfile();
  setStatus("status.computing");
  await state.supportPromise;
  if (!state.supportOk) {
    renderFormState();
    renderResults();
    return;
  }
  try {
    const result = await state.engine.project(state.model, state.config, state.support, profile);
    if (!result || !Array.isArray(result.rows)) throw new Error("unexpected result");
    state.result = result;
    state.resultMeta = {
      stage: profile.stage,
      site: profile.site,
      synthetic: Boolean(state.example),
      soft: state.fields.filter((f) => validateField(f).status === "soft").map((f) => f.name),
      supportOk: state.supportOk,
    };
    state.stale = false;
    state.error = null;
    if (state.notice && state.notice.some((n) => n.key === "notice.stale")) state.notice = null;
    const menu = result.rows.map((r) => r.treatment);
    if (state.highlight && !menu.includes(state.highlight)) state.highlight = "";
    renderFormState();
    renderResults();
    renderContext();
    announce($("results-live"), t("results.announce", { n: result.rows.length }));
    setStatus("status.done");
    if (focus) $("results-title")?.focus();
  } catch (err) {
    console.warn("[engine] projection failed:", err && err.message);
    state.result = null;
    state.resultMeta = null;
    state.error = (err && err.message) || String(err);
    renderResults();
    renderContext();
    setStatus("status.ready", {
      n: state.manifest && Array.isArray(state.manifest.boosters) ? state.manifest.boosters.length : "?",
    });
  }
}

function contextLine() {
  const r = state.result;
  const meta = state.resultMeta;
  const version = (state.manifest && state.manifest.model_version) || r.modelVersion || "?";
  let line = t("results.context", { stage: meta.stage, h: r.horizon, site: meta.site, version });
  if (meta.synthetic) line += ` · ${t("results.synthetic")}`;
  return line;
}

/** The visible context line depends only on the current result (announcements go to #results-live). */
function renderContext() {
  setText($("results-context"), state.result && state.resultMeta ? contextLine() : "");
}

// ---------------------------------------------------------------------------
// Calculator: results
// ---------------------------------------------------------------------------

const pct = (p) => `${fmt(Math.round(p), 0)}%`;

/** Localised text for a display decision from format.js ("< 0.01", "> 2.00" or the number). */
function displayText(value, d, threshold) {
  if (d.kind === "below") return `<${fmt(10 ** -d.digits, d.digits)}`;
  if (d.kind === "above") return `>${fmt(threshold, d.digits)}`;
  if (d.kind === "invalid") return t("table.na");
  return fmt(value, d.digits);
}

function trtColor(code) {
  const c = state.config.treatments[code] || {};
  return { color: c.color || "#000000", dash: c.dash || "" };
}

function trtLabel(code) {
  return `${t(`trt.short.${code}`)} · ${t(`trt.${code}`)}`;
}

function renderStale() {
  const el = $("results-stale");
  if (el) el.hidden = !(state.result && state.stale);
  const body = $("results-body");
  if (body) body.classList.toggle("is-stale", Boolean(state.result && state.stale));
}

function renderResults() {
  const body = $("results-body");
  if (!body) return;
  body.textContent = "";
  body.classList.toggle("is-stale", Boolean(state.result && state.stale));
  if (state.error) {
    body.append(h("p", { class: "msg msg-error", role: "alert", text: t("results.error", { message: state.error }) }));
    return;
  }
  if (!state.result) {
    let key = "results.placeholder";
    if (supportMissing()) key = "results.nosupport";
    if (state.modelStatus === "nomodel") key = "results.nomodel";
    if (state.modelStatus === "noengine") key = "results.noengine";
    body.append(h("p", {
      class: modelBlocked() ? "msg msg-warn" : "placeholder", text: t(key),
    }));
    return;
  }

  const r = state.result;
  const meta = state.resultMeta;
  const stageCfg = state.config.stages[meta.stage];
  const H = r.horizon;
  const rows = r.rows;

  body.append(h("p", {
    id: "results-stale", class: "msg msg-warn stale-msg", hidden: !state.stale, text: t("results.stale"),
  }));

  // Warnings and context notes.
  const notes = h("ul", { class: "result-flags" });
  notes.append(h("li", { text: t("results.menu_note", { stage: meta.stage, n: rows.length }) }));
  if (meta.synthetic) notes.append(h("li", { class: "flag-synthetic", text: t("warn.synthetic") }));
  if (meta.soft.length) {
    notes.append(h("li", {
      class: "flag-warn",
      text: t("warn.soft", { fields: meta.soft.map((n) => t(`field.${n}.label`)).join(", ") }),
    }));
  }
  const anyLocal = rows.some((row) => row.local && row.local.n !== undefined && row.local.n !== null);
  if (meta.supportOk && anyLocal && rows.every((row) => row.local && row.local.supported === false)) {
    notes.append(h("li", { class: "flag-warn", text: t("warn.no_local_support_any", { site: meta.site }) }));
  }
  body.append(notes);

  // Highlight control.
  const select = h("select", { id: "highlight-select", "aria-describedby": "highlight-note" });
  select.append(h("option", { value: "", text: t("highlight.none") }));
  for (const code of stageCfg.menu) {
    const opt = h("option", { value: code, text: trtLabel(code) });
    if (code === state.highlight) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener("change", () => {
    state.highlight = select.value;
    applyHighlight();
  });
  body.append(h("div", { class: "result-tools" },
    h("label", { for: "highlight-select", text: t("highlight.label") }),
    select,
    h("p", { id: "highlight-note", class: "hint", text: t("highlight.note") })));

  // Chart. The legend follows the table and the line ends (unrounded RMST order).
  const legend = h("ul", { class: "legend", "aria-label": t("chart.legend") });
  for (const row of rows) {
    const code = row.treatment;
    const { color, dash } = trtColor(code);
    legend.append(h("li", { "data-treatment": code }, makeSwatch(color, dash),
      h("span", { class: "legend-code", text: t(`trt.short.${code}`) }),
      h("span", { class: "legend-name", text: t(`trt.${code}`) })));
  }
  const chartHost = h("div", { class: "chart-host", id: "chart-host" });
  body.append(h("figure", { class: "chart-figure" },
    h("figcaption", { id: "chart-caption", text: t("chart.caption", { h: H }) }),
    legend,
    chartHost));

  // Table, then the statement that its order is not advice, directly under it.
  body.append(buildTable(r, meta, stageCfg));
  body.append(h("p", { class: "order-note", text: t("results.order_note") }));

  // Table notes.
  const tnotes = h("ul", { class: "table-notes" });
  tnotes.append(h("li", { text: t("table.note.rmst", { h: H }) }));
  tnotes.append(h("li", { text: t("table.note.within") }));
  tnotes.append(h("li", { text: t("table.note.dagger", { site: meta.site, h: H }) }));
  tnotes.append(h("li", { text: t("table.note.counts", { site: meta.site, stage: meta.stage }) }));
  if (meta.stage === "C" || meta.stage === "D") tnotes.append(h("li", { text: t("table.note.horizon") }));
  body.append(tnotes);

  // Ranking details.
  body.append(buildDetails(r, meta));

  labelTables(body);
  drawChart();
  applyHighlight();
}

function buildTable(r, meta, stageCfg) {
  const H = r.horizon;
  const landmarks = stageCfg.landmarks || [];
  const colRmst = t("table.col.rmst", { h: H });
  const colDiff = t("table.col.diff");
  const colLocal = t("table.col.local", { site: meta.site, h: H });
  const tol = Number(state.config.tolerance_months ?? 2);

  const headRow = h("tr", { role: "row" },
    h("th", { scope: "col", role: "columnheader", text: t("table.col.treatment") }),
    h("th", { scope: "col", role: "columnheader", class: "num", text: colRmst }),
    ...landmarks.map((m) => h("th", { scope: "col", role: "columnheader", class: "num", text: t("table.col.surv", { m }) })),
    h("th", { scope: "col", role: "columnheader", class: "num", text: colDiff }),
    h("th", { scope: "col", role: "columnheader", class: "local", text: colLocal }));

  const tbody = h("tbody", { role: "rowgroup" });
  r.rows.forEach((row, idx) => {
    const { color, dash } = trtColor(row.treatment);
    const cells = [];
    cells.push(h("th", { scope: "row", role: "rowheader", class: "trt-cell" },
      h("span", { class: "trt" }, makeSwatch(color, dash),
        h("span", { class: "trt-text" },
          h("span", { class: "trt-code", text: t(`trt.short.${row.treatment}`) }),
          h("span", { class: "trt-name", text: t(`trt.${row.treatment}`) })))));
    // data-short: compact labels for the card layout below 60rem (the hidden header row keeps the full ones).
    cells.push(h("td", {
      role: "cell", class: "num rmst", "data-label": colRmst, "data-short": t("table.short.rmst", { h: H }), text: fmt(row.rmst, 1),
    }));
    for (const m of landmarks) {
      const lm = row.landmarks && (row.landmarks[String(m)] ?? row.landmarks[m]);
      const v = Number.isFinite(lm) ? lm : Number(row.curve[m]);
      cells.push(h("td", {
        role: "cell", class: "num lm", "data-label": t("table.col.surv", { m }), "data-short": t("table.short.surv", { m }), text: pct(v * 100),
      }));
    }
    const diffCell = h("td", { role: "cell", class: "num diff", "data-label": colDiff, "data-short": t("table.short.diff") });
    if (idx === 0) {
      diffCell.append(h("span", { "aria-hidden": "true", text: t("table.top") }),
        h("span", { class: "visually-hidden", text: t("table.top_sr") }));
    } else {
      const diff = Number(row.diffFromTop);
      const within = typeof row.withinTolerance === "boolean" ? row.withinTolerance : diff <= tol;
      // Two decimals, as the paper shows RMST differences; more when needed so that the shown value
      // never contradicts the flag, which uses the unrounded difference.
      diffCell.append(h("span", { class: "nowrap", text: displayText(diff, thresholdDisplay(diff, tol, { within }), tol) }));
      if (within) {
        diffCell.append(" ", h("span", { class: "tag", "aria-hidden": "true", text: t("table.within_short") }),
          h("span", { class: "visually-hidden", text: t("table.within") }));
      }
    }
    cells.push(diffCell);
    const localCell = h("td", {
      role: "cell", class: "local", "data-label": colLocal, "data-short": t("table.short.local", { site: meta.site, h: H }),
    });
    const loc = row.local;
    if (meta.supportOk && loc && loc.n !== undefined && loc.n !== null) {
      const value = h("span", { class: "nowrap" },
        `${fmt(loc.n, 0)} / ${fmt(loc.deaths, 0)} / ${fmt(loc.atRisk ?? loc.at_risk, 0)}`);
      if (loc.supported === false) {
        value.append(" ", h("span", { class: "dagger", "aria-hidden": "true", text: "†" }),
          h("span", { class: "visually-hidden", text: t("table.dagger_sr") }));
      }
      localCell.append(value);
    } else {
      localCell.append(h("span", { class: "muted", text: t("table.na") }));
    }
    cells.push(localCell);
    tbody.append(h("tr", { role: "row", "data-treatment": row.treatment }, ...cells));
  });

  const table = h("table", { class: `proj-table stack-wide lm-${landmarks.length}`, role: "table", id: "proj-table" },
    h("caption", { text: t("table.caption", { stage: meta.stage, site: meta.site, h: H }) }),
    h("thead", { role: "rowgroup" }, headRow),
    tbody);
  return h("div", { class: "table-wrap" }, table);
}

function seqText(seq) {
  return seq.map((c) => t(`trt.short.${c}`).replace("/PEIT", "")).join(" > ");
}

function buildDetails(r, meta) {
  const details = h("details", { class: "ranking", id: "ranking-details" });
  if (state.detailsOpen) details.open = true;
  details.addEventListener("toggle", () => { state.detailsOpen = details.open; });
  const trs = Array.isArray(r.trs) ? r.trs : r.rows.map((x) => x.treatment);
  const ref = Array.isArray(r.reference) ? r.reference : state.config.stages[meta.stage].reference;
  const rmst = Object.fromEntries(r.rows.map((x) => [x.treatment, Number(x.rmst)]));
  let byPos;
  try {
    if (Array.isArray(r.mismatchByPosition)) byPos = r.mismatchByPosition.map(Number);
    else if (state.engine && typeof state.engine.mismatchByPosition === "function") {
      byPos = Array.from(state.engine.mismatchByPosition(rmst, trs, ref));
    } else byPos = ref.map((code, k) => Math.abs(rmst[trs[k]] - rmst[code]));
  } catch {
    byPos = ref.map((code, k) => Math.abs(rmst[trs[k]] - rmst[code]));
  }
  const M = Number.isFinite(Number(r.maxMismatch)) ? Number(r.maxMismatch) : Math.max(...byPos);
  const yesNo = (v) => t(v ? "details.yes" : "details.no");
  const agreement = r.agreement || {};
  const small = (v) => displayText(v, smallValueDisplay(v, 2));

  const dl = h("dl", { class: "kv" },
    h("dt", { text: t("details.trs") }), h("dd", { class: "seq", text: seqText(trs) }),
    h("dt", { text: t("details.reference", { stage: meta.stage }) }), h("dd", { class: "seq", text: seqText(ref) }),
    h("dt", { text: t("details.first") }), h("dd", { text: yesNo(agreement.first ?? trs[0] === ref[0]) }),
    h("dt", { text: t("details.complete") }),
    h("dd", { text: yesNo(agreement.complete ?? trs.every((c, i) => c === ref[i])) }),
    h("dt", { text: t("details.m") }), h("dd", { text: t("details.m_value", { m: small(M) }) }));

  const posBody = h("tbody");
  ref.forEach((code, k) => {
    posBody.append(h("tr", {},
      h("th", { scope: "row", text: String(k + 1) }),
      h("td", { text: `${seqText([code])} (${fmt(rmst[code], 2)})` }),
      h("td", { text: `${seqText([trs[k]])} (${fmt(rmst[trs[k]], 2)})` }),
      h("td", { class: "num", text: small(byPos[k]) })));
  });
  const posTable = h("table", { class: "pos-table stack" },
    h("caption", { text: t("details.pos_caption") }),
    h("thead", {}, h("tr", {},
      h("th", { scope: "col", text: t("details.col.pos") }),
      h("th", { scope: "col", text: t("details.col.ref") }),
      h("th", { scope: "col", text: t("details.col.trs") }),
      h("th", { scope: "col", class: "num", text: t("details.col.diff") }))),
    posBody);

  details.append(
    h("summary", { text: t("details.summary") }),
    h("div", { class: "details-body" },
      h("p", { text: t("details.intro") }),
      dl,
      h("div", { class: "table-wrap" }, posTable),
      h("p", { class: "fine", text: t("details.caveat.m") }),
      h("p", { class: "fine", text: t("details.caveat.ref") }),
      h("p", { class: "fine", text: t("details.caveat.model") })));
  return details;
}

function drawChart() {
  const host = $("chart-host");
  if (!host || !state.result) return;
  const r = state.result;
  renderChart(host, {
    horizon: r.horizon,
    highlight: state.highlight || null,
    rows: r.rows.map((row) => ({
      treatment: row.treatment,
      label: t(`trt.short.${row.treatment}`),
      curve: row.curve,
      ...trtColor(row.treatment),
    })),
    labelledBy: "chart-caption",
    text: {
      title: t("chart.caption", { h: r.horizon }),
      desc: t("chart.desc", { n: r.rows.length, h: r.horizon }),
      x: t("chart.x"),
      y: t("chart.y"),
      hint: t("chart.hint"),
      tick: (v) => fmtPlain(v, 0),
      pct,
      readoutTitle: (m) => t("chart.readout_title", { m }),
      live: (m, values) => t("chart.readout_live", { m, values }),
    },
  });
}

function applyHighlight() {
  for (const tr of document.querySelectorAll("#proj-table tbody tr")) {
    tr.classList.toggle("is-highlight", Boolean(state.highlight) && tr.dataset.treatment === state.highlight);
  }
  for (const li of document.querySelectorAll(".legend li")) {
    li.classList.toggle("is-highlight", Boolean(state.highlight) && li.dataset.treatment === state.highlight);
  }
  drawChart();
}

// ---------------------------------------------------------------------------
// Calculator: wiring and URL hash
// ---------------------------------------------------------------------------

/** Keep an existing lang= hash parameter in step with the toggle (the hash never carries inputs). */
function syncHashLang(l) {
  const p = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (!p.has("lang") || p.get("lang") === l) return;
  p.set("lang", l);
  history.replaceState(null, "", `#${p.toString()}`);
}

function parseExample(value) {
  const m = /^([0abcd])([123])?$/i.exec(String(value || "").trim());
  if (!m) return null;
  const stage = m[1].toUpperCase();
  return { stage, site: m[2] ? Number(m[2]) : null };
}

async function applyHash(hash, modelReady) {
  if (hash.lang && hash.lang !== lang()) await setLang(hash.lang, { persist: false });
  if (hash.highlight) state.highlight = String(hash.highlight).toUpperCase();
  const ex = parseExample(hash.example);
  if (ex && state.config.examples && state.config.examples[ex.stage]) {
    const site = ex.site ?? state.config.examples[ex.stage].site;
    loadExample(ex.stage, site);
    const ok = await modelReady;
    if (ok) await runProjection({ focus: false });
  } else if (state.result) {
    renderResults();
  }
}

function wireForm() {
  const form = $("calc-form");
  form.addEventListener("submit", (evt) => {
    evt.preventDefault();
    onProject();
  });
  $("btn-clear").addEventListener("click", () => clearForm());
  $("btn-undo")?.addEventListener("click", () => undoExample());
  $("btn-example").addEventListener("click", () => {
    const stage = state.values.stage;
    if (stage === undefined || stage === null || stage === "") {
      state.exampleHint = true;
      state.notice = null;
      renderFormState();
      document.querySelector('input[name="stage"]')?.focus();
      return;
    }
    const site = state.values.site !== undefined ? state.values.site : null;
    loadExample(String(stage), site, { keepUndo: true });
  });
  wireSkipLink(() => document.querySelector("#calc-form .sec"));
}

async function initCalc(hash) {
  setStatus("status.loading");
  try {
    state.config = await fetchJson("data/config.json");
    state.fields = state.config.fields || [];
  } catch (err) {
    console.warn("[config]", err && err.message);
    state.modelStatus = "noconfig";
    setStatus("status.noconfig");
    const body = $("results-body");
    if (body) {
      body.textContent = "";
      body.append(h("p", { class: "msg msg-error", role: "alert", text: t("results.noconfig") }));
    }
    $("calc-form")?.setAttribute("hidden", "");
    onLangChange(() => {
      setStatus("status.noconfig");
      if (body) body.firstChild.textContent = t("results.noconfig");
    });
    return;
  }

  buildForm();
  wireForm();
  // Re-apply translations to the generated form nodes.
  for (const el of document.querySelectorAll("[data-fields-for] [data-i18n]")) el.textContent = t(el.dataset.i18n);
  renderFieldStates();
  renderFormState();
  renderResults();

  state.supportPromise = fetchJson("data/support.json")
    .then((s) => {
      state.support = s;
      state.supportOk = Boolean(s && Array.isArray(s.cells));
    })
    .catch((err) => {
      console.warn("[support]", err && err.message);
      state.supportOk = false;
    })
    .finally(() => {
      state.supportSettled = true;
      renderFooter();
      renderFormState();
      if (!state.result) renderResults();
    });

  onLangChange((l) => {
    syncHashLang(l);
    renderFieldStates();
    renderFormState();
    renderFooter();
    renderResults();
    renderContext();
  });

  const modelReady = loadEngineAndModel();
  window.addEventListener("hashchange", () => applyHash(parseHash(), modelReady));
  await applyHash(hash, modelReady);
}

// ---------------------------------------------------------------------------
// About page: model card
// ---------------------------------------------------------------------------

// Manifest prose fixed by docs/CONTRACTS.md section 3. These texts are shown through the i18n
// dictionaries; any other manifest text is shown as written and marked as English.
const MANIFEST_PROSE = {
  seed_rule: "imputation seed = deploy_seed + 37*m; AFT tree seed = imputation seed + 1",
  imputation: "10 stochastic IterativeImputer completions (cpda.imputation.FoldImputer); imputers are not exported",
  inference: "all 15 predictors, BCLC stage and site required; no imputation at inference",
};

function manifestProse(name, value) {
  if (value === undefined || value === null || value === "") return { value };
  return value === MANIFEST_PROSE[name] ? { value: t(`card.value.${name}`) } : { value, lang: "en" };
}

function renderModelCard() {
  const host = $("model-card");
  if (!host) return;
  host.textContent = "";
  const m = state.manifest;
  if (!m) {
    host.append(h("p", {
      class: state.modelStatus === "loading" ? "placeholder" : "msg msg-warn",
      text: t(state.modelStatus === "loading" ? "about.card.loading" : "about.card.unavailable"),
    }));
    return;
  }
  const tr = m.training || {};
  const sw = m.software || {};
  const aft = m.aft || {};
  const rows = [];
  // `code` marks values that are identifiers or code (kept in English, marked lang="en").
  const add = (key, value, { code = false, valueLang } = {}) => {
    if (value === undefined || value === null || value === "") return;
    rows.push(h("dt", { text: t(key) }), h("dd", { text: String(value), lang: valueLang || (code ? "en" : null) }));
  };
  const addProse = (key, name, value) => {
    const p = manifestProse(name, value);
    add(key, p.value, { valueLang: p.lang });
  };
  add("card.version", m.model_version);
  add("card.created", m.created_utc);
  add("card.format", m.format, { code: true });
  if (tr.cohort_n !== undefined) add("card.cohort", t("card.cohort_value", { n: fmt(tr.cohort_n, 0), d: fmt(tr.deaths, 0) }));
  add("card.seed", tr.deploy_seed);
  addProse("card.seed_rule", "seed_rule", tr.seed_rule);
  add("card.device", tr.device, { code: true });
  add("card.nthread", tr.nthread);
  add("card.rounds", tr.num_boost_round);
  add("card.n_models", m.n_models);
  if (aft.objective) {
    add("card.aft", `${aft.objective}, ${aft.distribution}, σ = ${aft.sigma}, base_score = ${aft.base_score}`, { code: true });
  }
  if (tr.params && typeof tr.params === "object") {
    add("card.params", Object.entries(tr.params).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join("; "), { code: true });
  }
  addProse("card.imputation", "imputation", tr.imputation);
  const inf = m.inference || {};
  addProse("card.inference", "inference", inf.inputs);
  if (inf.imputer_identity_on_complete_rows_verified !== undefined) {
    add("card.verified", t(inf.imputer_identity_on_complete_rows_verified ? "card.yes" : "card.no"));
  }
  const swText = ["python", "xgboost", "scikit_learn", "numpy", "scipy", "pandas"]
    .filter((k) => sw[k]).map((k) => `${k.replace("_", "-")} ${sw[k]}`).join(", ");
  add("card.software", swText, { code: true });
  if (sw.cpda_git_head) add("card.git", `${sw.cpda_git_head}${sw.cpda_git_dirty ? t("card.git_dirty") : ""}`);
  add("card.short_hash", state.shortHash || "—");
  host.append(h("dl", { class: "kv card-kv" }, ...rows));

  const boosters = Array.isArray(m.boosters) ? m.boosters : [];
  if (boosters.length) {
    const tbody = h("tbody");
    for (const b of boosters) {
      tbody.append(h("tr", {},
        h("th", { scope: "row", text: b.file }),
        h("td", { class: "num", text: b.n_trees !== undefined ? fmt(b.n_trees, 0) : "—" }),
        h("td", { class: "hash", text: b.sha256 || "—" })));
    }
    host.append(h("div", { class: "table-wrap" }, h("table", { class: "card-table stack" },
      h("caption", { text: t("card.boosters") }),
      h("thead", {}, h("tr", {},
        h("th", { scope: "col", text: t("card.col.file") }),
        h("th", { scope: "col", class: "num", text: t("card.col.trees") }),
        h("th", { scope: "col", text: t("card.col.sha") }))),
      tbody)));
  }
  labelTables(host);
}

async function initAbout() {
  setStatus("status.about");
  labelTables(document);
  renderModelCard();
  onLangChange(() => {
    labelTables(document);
    renderModelCard();
    renderFooter();
  });
  let modelPath = "model/";
  try {
    const cfg = await fetchJson("data/config.json");
    if (cfg && cfg.model_path) modelPath = cfg.model_path;
  } catch {
    /* fall back to the default model path */
  }
  try {
    state.manifest = await fetchJson(new URL("manifest.json", new URL(modelPath, document.baseURI)));
    state.shortHash = await shortBoosterHash(state.manifest);
    state.modelStatus = "ready";
  } catch (err) {
    console.warn("[model card]", err && err.message);
    state.modelStatus = "nomodel";
  }
  renderModelCard();
  renderFooter();
}

// ---------------------------------------------------------------------------

async function main() {
  const hash = parseHash();
  try {
    await initI18n(hash.lang);
  } catch (err) {
    console.error("[i18n]", err && err.message);
  }
  wireLangToggle();
  renderFooter();
  if (PAGE === "about") await initAbout();
  else await initCalc(hash);
}

main().catch((err) => console.error(err));
