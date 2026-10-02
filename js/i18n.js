// EN / zh-TW switching. Dictionaries are flat {key: string} JSON files in ../i18n/.
// Only the language preference is ever written to localStorage (inside try/catch).

export const LANGS = ["en", "zh-TW"];
const STORAGE_KEY = "hcc-cpda.lang";

let current = "en";
let dict = {};
let base = {};
const listeners = [];
const cache = new Map();

async function loadDict(lang) {
  if (cache.has(lang)) return cache.get(lang);
  const url = new URL(`../i18n/${lang}.json`, import.meta.url);
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`i18n ${lang}: HTTP ${res.status}`);
  const json = await res.json();
  cache.set(lang, json);
  return json;
}

function normalise(lang) {
  if (!lang) return null;
  const l = String(lang).toLowerCase();
  if (l === "en" || l.startsWith("en-")) return "en";
  if (l === "zh-tw" || l === "zh" || l.startsWith("zh-")) return "zh-TW";
  return null;
}

function storedLang() {
  try {
    return normalise(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function storeLang(lang) {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage unavailable: the preference simply is not remembered */
  }
}

/** Translate `key`, replacing {name} placeholders from `params`. */
export function t(key, params) {
  let s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key]
    : Object.prototype.hasOwnProperty.call(base, key) ? base[key] : null;
  if (s === null) {
    console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m);
  }
  return s;
}

export function lang() {
  return current;
}

/** Locale-aware fixed-decimal number. */
export function fmt(value, digits = 0) {
  return new Intl.NumberFormat(current === "zh-TW" ? "zh-TW" : "en-GB", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Plain number with grouping and up to `maxDigits` decimals (for range hints). */
export function fmtPlain(value, maxDigits = 6) {
  return new Intl.NumberFormat(current === "zh-TW" ? "zh-TW" : "en-GB", {
    maximumFractionDigits: maxDigits,
  }).format(value);
}

/** Fill [data-i18n] text and [data-i18n-attr="attr:key;attr2:key2"] attributes. */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of el.dataset.i18nAttr.split(";")) {
      const idx = pair.indexOf(":");
      if (idx < 0) continue;
      el.setAttribute(pair.slice(0, idx).trim(), t(pair.slice(idx + 1).trim()));
    }
  }
  document.documentElement.lang = current;
  for (const btn of document.querySelectorAll("[data-lang]")) {
    btn.setAttribute("aria-pressed", btn.dataset.lang === current ? "true" : "false");
  }
}

export function onLangChange(fn) {
  listeners.push(fn);
}

/** Switch language; `persist` stores the preference (only this value is ever stored). */
export async function setLang(next, { persist = true } = {}) {
  const l = normalise(next) || "en";
  try {
    dict = await loadDict(l);
    current = l;
  } catch (err) {
    console.warn(`[i18n] ${err.message}; falling back to English`);
    dict = base;
    current = "en";
  }
  if (persist) storeLang(current);
  applyI18n(document);
  for (const fn of listeners) {
    try {
      fn(current);
    } catch (err) {
      console.error(err);
    }
  }
  return current;
}

/**
 * Load English (fallback for any missing key) and the preferred language:
 * explicit (URL hash) > stored preference > browser language > English.
 */
export async function initI18n(explicit) {
  base = await loadDict("en");
  const nav = typeof navigator !== "undefined" ? normalise(navigator.language) : null;
  const initial = normalise(explicit) || storedLang() || nav || "en";
  // Only an explicit click on the toggle stores the preference; the URL hash does not.
  await setLang(initial, { persist: false });
  return current;
}

/** Wire the EN / 中文 toggle buttons. */
export function wireLangToggle() {
  for (const btn of document.querySelectorAll("[data-lang]")) {
    btn.addEventListener("click", () => {
      if (btn.dataset.lang !== current) setLang(btn.dataset.lang);
    });
  }
}
