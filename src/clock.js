// Tick-driven scheduler shared across the client modules. Everything that
// would otherwise reach for setTimeout goes through scheduleAfter; the host's
// rAF loop calls tickClock once per frame to drain due actions. When the tab
// is unfocused and rAF pauses, scheduled actions pause with it.

const _timers = [];

export function scheduleAfter(delayMs, action) {
  _timers.push({ atTs: performance.now() + delayMs, action });
}

export function tickClock() {
  if (!_timers.length) return;
  const now = performance.now();
  let i = 0;
  const due = [];
  while (i < _timers.length) {
    if (_timers[i].atTs <= now) {
      due.push(_timers[i].action);
      _timers.splice(i, 1);
    } else {
      i++;
    }
  }
  for (const action of due) action();
}
