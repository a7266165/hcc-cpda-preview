// SVG survival chart in the style of the paper's Figure 1: x = 0..H months, y = 0-100 %,
// one line per menu treatment (colour + dash from config) on a white plot area, recessive solid
// gridlines, and a crosshair readout on hover or keyboard focus. Pure DOM; no inline styles.
//
// Accessibility: the plot sits in a focusable wrapper with role="slider". Its value is the month
// under the crosshair, and aria-valuetext gives that month and every treatment's projected
// survival, so screen readers announce each arrow-key step (sliders receive arrow keys in browse
// mode, which a focusable image does not). The SVG is presentational (aria-hidden); the table
// below the chart lists the same projections.

const SVGNS = "http://www.w3.org/2000/svg";
const controllers = new WeakMap();

const TICK_STEP = { 84: 12, 36: 6, 24: 6, 12: 3 };

export function tickStep(horizon) {
  if (TICK_STEP[horizon]) return TICK_STEP[horizon];
  const raw = horizon / 6;
  for (const s of [1, 2, 3, 6, 12, 24]) if (s >= raw) return s;
  return 24;
}

/** Chart height for a given width: 0.56 x width within 250-420 px, at least 320 px on narrow screens. */
export function chartHeight(width) {
  const floor = width < 560 ? 320 : 250;
  return Math.round(Math.min(420, Math.max(floor, width * 0.56)));
}

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined && v !== "") node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

/** Small line key (legend, table, readout): a stroke in the series colour and dash. */
export function makeSwatch(color, dash, { width = 30, height = 12, strokeWidth = 2.5 } = {}) {
  const svg = el("svg", {
    width, height, viewBox: `0 0 ${width} ${height}`, class: "swatch",
    "aria-hidden": "true", focusable: "false",
  });
  el("line", {
    x1: 1, x2: width - 1, y1: height / 2, y2: height / 2,
    stroke: color, "stroke-width": strokeWidth, "stroke-dasharray": dash || null,
    "stroke-linecap": "butt",
  }, svg);
  return svg;
}

/**
 * Render (or re-render) the chart into `host`.
 * spec = {
 *   horizon, highlight,
 *   rows: [{ treatment, label, curve, color, dash }],   // in display (RMST) order
 *   labelledBy: id of the visible chart caption (names the slider; optional),
 *   text: { title, desc, x, y, hint, tick(v), pct(v), readoutTitle(m), live(m, values) },
 * }
 */
export function renderChart(host, spec) {
  const prev = controllers.get(host);
  if (prev) prev.destroy();

  let lastWidth = 0;
  let month = null;      // crosshair position
  let focused = false;
  let ro = null;
  let rafId = 0;

  const draw = () => {
    host.textContent = "";
    const W = Math.max(280, Math.round(host.clientWidth || 640));
    lastWidth = W;
    const H = chartHeight(W);
    const m = { top: 30, right: 18, bottom: 46, left: 50 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;
    const horizon = spec.horizon;
    const sx = (t) => m.left + (t / horizon) * pw;
    const sy = (s) => m.top + (1 - s) * ph;

    const valueText = (mo) => spec.text.live(mo, spec.rows
      .map((row) => `${row.label} ${spec.text.pct(Number(row.curve[mo]) * 100)}`).join(", "));

    // Focusable slider wrapper (keyboard readout) around the presentational SVG.
    const frame = document.createElement("div");
    frame.className = "chart-frame";
    frame.tabIndex = 0;
    frame.setAttribute("role", "slider");
    frame.setAttribute("aria-orientation", "horizontal");
    if (spec.labelledBy) frame.setAttribute("aria-labelledby", spec.labelledBy);
    else frame.setAttribute("aria-label", spec.text.title);
    frame.setAttribute("aria-describedby", "chart-desc chart-hint");
    frame.setAttribute("aria-valuemin", "0");
    frame.setAttribute("aria-valuemax", String(horizon));
    const setValue = (mo) => {
      frame.setAttribute("aria-valuenow", String(mo));
      frame.setAttribute("aria-valuetext", valueText(mo));
    };
    setValue(month === null ? horizon : month);

    const svg = el("svg", {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart-svg",
      "aria-hidden": "true", focusable: "false",
    });
    frame.appendChild(svg);

    // White plot area: every series colour keeps at least 3:1 against it (WCAG 1.4.11).
    el("rect", { x: m.left, y: m.top, width: pw, height: ph, class: "plot-bg" }, svg);

    // Grid and axes (solid hairlines, recessive).
    const grid = el("g", { class: "grid" }, svg);
    for (let p = 0; p <= 100; p += 20) {
      const y = sy(p / 100);
      el("line", { x1: m.left, x2: m.left + pw, y1: y, y2: y, class: p === 0 ? "axis" : "gridline" }, grid);
      const lab = el("text", { x: m.left - 8, y: y + 4, class: "tick tick-y", "text-anchor": "end" }, grid);
      lab.textContent = spec.text.pct(p);
    }
    const step = tickStep(horizon);
    for (let t = 0; t <= horizon; t += step) {
      const x = sx(t);
      if (t > 0) el("line", { x1: x, x2: x, y1: m.top, y2: m.top + ph, class: "gridline gridline-v" }, grid);
      el("line", { x1: x, x2: x, y1: m.top + ph, y2: m.top + ph + 5, class: "axis" }, grid);
      const lab = el("text", { x, y: m.top + ph + 19, class: "tick tick-x", "text-anchor": "middle" }, grid);
      lab.textContent = spec.text.tick(t);
    }
    el("line", { x1: m.left, x2: m.left, y1: m.top, y2: m.top + ph, class: "axis" }, grid);
    const xTitle = el("text", { x: m.left + pw / 2, y: H - 6, class: "axis-title", "text-anchor": "middle" }, svg);
    xTitle.textContent = spec.text.x;
    const yTitle = el("text", { x: m.left - 42, y: 16, class: "axis-title", "text-anchor": "start" }, svg);
    yTitle.textContent = spec.text.y;

    // Series: non-highlighted first so the highlighted line sits on top.
    const series = el("g", { class: "series-group" }, svg);
    const ordered = [...spec.rows].sort((a, b) =>
      (a.treatment === spec.highlight) - (b.treatment === spec.highlight));
    for (const row of ordered) {
      const pts = [];
      for (let t = 0; t <= horizon; t += 1) {
        const v = Number(row.curve[t]);
        pts.push(`${sx(t).toFixed(2)},${sy(Math.min(1, Math.max(0, v))).toFixed(2)}`);
      }
      const cls = ["series"];
      if (spec.highlight) cls.push(row.treatment === spec.highlight ? "is-highlight" : "is-dim");
      el("polyline", {
        points: pts.join(" "), fill: "none", stroke: row.color,
        "stroke-dasharray": row.dash || null, class: cls.join(" "),
        "data-treatment": row.treatment,
      }, series);
    }

    // Hover / focus layer.
    const cross = el("line", { x1: 0, x2: 0, y1: m.top, y2: m.top + ph, class: "crosshair", visibility: "hidden" }, svg);
    const dots = el("g", { class: "dots", visibility: "hidden" }, svg);
    const dotNodes = spec.rows.map((row) =>
      el("circle", { r: 4.5, cx: 0, cy: 0, fill: row.color, class: "dot" }, dots));
    const hit = el("rect", { x: m.left, y: m.top, width: pw, height: ph, class: "hit", fill: "transparent" }, svg);

    // Readout bar below the plot: shows the hint until the crosshair is active, so it never covers
    // data. It is visual only; assistive technology reads the slider's aria-valuetext instead.
    const readout = document.createElement("div");
    readout.className = "readout";
    readout.setAttribute("aria-hidden", "true");
    const showHint = () => {
      readout.textContent = "";
      readout.classList.remove("is-active");
      const p = document.createElement("p");
      p.className = "readout-hint";
      p.textContent = spec.text.hint || "";
      readout.appendChild(p);
    };
    showHint();

    // Description and keyboard hint for the slider (visually hidden; the hint is also shown above).
    const desc = document.createElement("p");
    desc.id = "chart-desc";
    desc.className = "visually-hidden";
    desc.textContent = spec.text.desc;
    const hint = document.createElement("p");
    hint.id = "chart-hint";
    hint.className = "visually-hidden";
    hint.textContent = spec.text.hint || "";

    host.append(frame, readout, desc, hint);

    const show = (t) => {
      month = Math.max(0, Math.min(horizon, Math.round(t)));
      const x = sx(month);
      cross.setAttribute("x1", x.toFixed(2));
      cross.setAttribute("x2", x.toFixed(2));
      cross.setAttribute("visibility", "visible");
      dots.setAttribute("visibility", "visible");
      spec.rows.forEach((row, i) => {
        const v = Math.min(1, Math.max(0, Number(row.curve[month])));
        dotNodes[i].setAttribute("cx", x.toFixed(2));
        dotNodes[i].setAttribute("cy", sy(v).toFixed(2));
      });
      readout.textContent = "";
      readout.classList.add("is-active");
      const head = document.createElement("p");
      head.className = "readout-title";
      head.textContent = spec.text.readoutTitle(month);
      readout.appendChild(head);
      const list = document.createElement("ul");
      for (const row of spec.rows) {
        const li = document.createElement("li");
        if (spec.highlight === row.treatment) li.className = "is-highlight";
        li.appendChild(makeSwatch(row.color, row.dash, { width: 22, height: 10, strokeWidth: 2 }));
        const val = document.createElement("strong");
        val.textContent = spec.text.pct(Number(row.curve[month]) * 100);
        const lab = document.createElement("span");
        lab.textContent = row.label;
        li.append(val, lab);
        list.appendChild(li);
      }
      readout.appendChild(list);
      setValue(month);
    };
    const hide = () => {
      cross.setAttribute("visibility", "hidden");
      dots.setAttribute("visibility", "hidden");
      showHint();
    };
    const toMonth = (evt) => {
      const rect = svg.getBoundingClientRect();
      const scale = rect.width > 0 ? W / rect.width : 1;
      const px = (evt.clientX - rect.left) * scale;
      return ((px - m.left) / pw) * horizon;
    };

    hit.addEventListener("pointermove", (evt) => show(toMonth(evt)));
    hit.addEventListener("pointerdown", (evt) => show(toMonth(evt)));
    hit.addEventListener("pointerleave", () => { if (!focused) hide(); });
    frame.addEventListener("focus", () => {
      focused = true;
      show(month === null ? horizon : month);
    });
    frame.addEventListener("blur", () => { focused = false; hide(); });
    frame.addEventListener("keydown", (evt) => {
      const cur = month === null ? horizon : month;
      let next = null;
      if (evt.key === "ArrowLeft" || evt.key === "ArrowDown") next = cur - 1;
      else if (evt.key === "ArrowRight" || evt.key === "ArrowUp") next = cur + 1;
      else if (evt.key === "PageDown") next = cur - step;
      else if (evt.key === "PageUp") next = cur + step;
      else if (evt.key === "Home") next = 0;
      else if (evt.key === "End") next = horizon;
      else if (evt.key === "Escape") { hide(); return; }
      if (next !== null) {
        evt.preventDefault();
        show(next);
      }
    });
    if (focused && month !== null) show(month);
  };

  draw();

  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => {
      const w = Math.round(host.clientWidth || 0);
      if (w > 0 && Math.abs(w - lastWidth) > 1) {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          // Keep keyboard focus on the slider across a redraw.
          const hadFocus = host.contains(document.activeElement);
          draw();
          if (hadFocus) host.querySelector(".chart-frame")?.focus();
        });
      }
    });
    ro.observe(host);
  }

  const controller = {
    destroy() {
      if (ro) ro.disconnect();
      cancelAnimationFrame(rafId);
      controllers.delete(host);
    },
  };
  controllers.set(host, controller);
  return controller;
}
