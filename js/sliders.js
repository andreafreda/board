// ════════════════════════════════════════════════════════════════════
//   sliders.js — generic vertical pointer-driven slider
// ════════════════════════════════════════════════════════════════════
// Used for both pen size (drawToolbar) and font size (textToolbar).
// Returns a `render()` function so callers can refresh the visual
// position when the underlying value changes externally.

import { save } from './state.js';

export function makeVSlider({
  trackEl, fillEl, thumbEl, valEl,
  min, max, getValue, setValue, onUpdate,
}) {
  const pct = () => Math.max(0, Math.min(1, (getValue() - min) / (max - min)));

  function render() {
    const p = pct();
    fillEl.style.height = (p * 100) + '%';
    thumbEl.style.bottom = (p * 100) + '%';
    valEl.textContent = Math.round(getValue());
  }

  function setFromY(e, rect) {
    const y = Math.min(Math.max(0, e.clientY - rect.top), rect.height);
    const v = Math.max(min, Math.min(max, Math.round(max - (y / rect.height) * (max - min))));
    setValue(v);
    onUpdate();
    render();
  }

  let dragging = false, rect = null;
  trackEl.addEventListener('pointerdown', (e) => {
    dragging = true;
    rect = trackEl.getBoundingClientRect();
    trackEl.setPointerCapture(e.pointerId);
    setFromY(e, rect);
    e.stopPropagation();
  });
  trackEl.addEventListener('pointermove', (e) => { if (dragging) setFromY(e, rect); });
  trackEl.addEventListener('pointerup',   ()  => { dragging = false; save(); });

  render();
  return render;
}
