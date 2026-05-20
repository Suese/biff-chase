// Stable per-player color assignment. Index in players[] picks a slot.

export const PLAYER_COLORS = [
  '#ff6a3d', // orange
  '#3dc8ff', // cyan
  '#ffce3d', // yellow
  '#a86dff', // purple
  '#7cf3a0', // green
  '#ff5d8e', // pink
  '#ffffff', // white
  '#9aa0ac', // gray
];

export function colorForPlayer(state, playerId) {
  if (!state || !state.players) return PLAYER_COLORS[0];
  const idx = state.players.findIndex(p => p.id === playerId);
  if (idx < 0) return PLAYER_COLORS[0];
  return PLAYER_COLORS[idx % PLAYER_COLORS.length];
}

export function colorHexForPlayer(state, playerId) {
  const c = colorForPlayer(state, playerId);
  // strip leading #
  return parseInt(c.replace('#', ''), 16);
}
