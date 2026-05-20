// Keyboard input → input frame. We diff against the last sent frame and only
// transmit when something changes, so light-traffic mode is "press W, send
// once; release W, send once".

const KEYS = {
  up:    new Set(['w', 'W', 'ArrowUp']),
  down:  new Set(['s', 'S', 'ArrowDown']),
  left:  new Set(['a', 'A', 'ArrowLeft']),
  right: new Set(['d', 'D', 'ArrowRight']),
  brake: new Set([' ']),
  useItem: new Set(['q', 'Q']),
};

export function createInputTracker(onChange, onUseItem) {
  const state = { up: 0, down: 0, left: 0, right: 0, brake: 0, useItem: 0 };
  const heldKeys = new Set();

  const emit = () => onChange({ ...state });

  const update = () => {
    let dirty = false;
    for (const dir of Object.keys(KEYS)) {
      if (dir === 'useItem') continue;
      let pressed = 0;
      for (const k of KEYS[dir]) if (heldKeys.has(k)) { pressed = 1; break; }
      if (state[dir] !== pressed) { state[dir] = pressed; dirty = true; }
    }
    if (dirty) emit();
  };

  window.addEventListener('keydown', (e) => {
    // Don't capture when focused in an input
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    // Use-item is a one-shot — fire on first down
    if (KEYS.useItem.has(e.key)) {
      if (!heldKeys.has(e.key)) onUseItem?.();
    }
    if (heldKeys.has(e.key)) return;
    heldKeys.add(e.key);
    update();
  });
  window.addEventListener('keyup', (e) => {
    heldKeys.delete(e.key);
    update();
  });
  // Lose focus = release all
  window.addEventListener('blur', () => {
    heldKeys.clear();
    update();
  });

  return { getState: () => state };
}
