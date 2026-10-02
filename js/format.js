// Pure display helpers for unrounded values: no DOM, no dependencies (used by app.js, tested in Node).
// The engine ranks and flags on unrounded values, as the paper does ("Calculations use unrounded
// values", appendix S4.2). These helpers stop a rounded number from contradicting the flag beside it,
// for example a difference of 2.0196 months shown as "2.0" without the "within 2 months" tag.

/** The number a fixed-decimal display shows (Number#toFixed and Intl.NumberFormat round alike). */
export function shownValue(value, digits) {
  return Number(Number(value).toFixed(digits));
}

/**
 * How to show a non-negative difference next to a "within `threshold`" flag.
 *
 * Returns {kind, digits}:
 *   "value": show the value with `digits` decimals. Decimals are added (from `digits` up to
 *            `maxDigits`) until the shown value lies on the same side of the threshold as the flag.
 *   "below": a positive value that rounds to zero; show "< 0.01" (for digits = 2).
 *   "above": a value above the threshold that still rounds onto it at `maxDigits`; show "> threshold".
 *   "invalid": not a finite number.
 * `within` defaults to `value <= threshold`, the engine's rule (withinTolerance).
 */
export function thresholdDisplay(value, threshold, { within, digits = 2, maxDigits = 6 } = {}) {
  const v = Number(value);
  if (!Number.isFinite(v)) return { kind: "invalid", digits };
  const flag = typeof within === "boolean" ? within : v <= threshold;
  if (v > 0 && shownValue(v, digits) === 0) return { kind: "below", digits };
  for (let d = digits; d <= maxDigits; d += 1) {
    if ((shownValue(v, d) <= threshold) === flag) return { kind: "value", digits: d };
  }
  return { kind: flag ? "value" : "above", digits };
}

/** How to show a non-negative value without a threshold: positive values that round to zero are "below". */
export function smallValueDisplay(value, digits = 2) {
  const v = Number(value);
  if (!Number.isFinite(v)) return { kind: "invalid", digits };
  if (v > 0 && shownValue(v, digits) === 0) return { kind: "below", digits };
  return { kind: "value", digits };
}
