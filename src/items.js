// Power-ups & pickups. The 'spawn' kind dictates what dropping a pickup does:
//   resource: adds scrap to player wallet
//   item:     gives 1 charge of an active item (used with Q)

export const ITEMS = {
  scrap: {
    icon: '🔩',
    name: 'Scrap',
    desc: 'Spend in the garage between races.',
    kind: 'resource',
    weight: 5,
  },
  nitro: {
    icon: '🔥',
    name: 'Nitro',
    desc: 'Press Q for a 2-second boost.',
    kind: 'item',
    key: 'Q',
    weight: 3,
    duration: 2.0,
  },
  mine: {
    icon: '💣',
    name: 'Mine',
    desc: 'Press Q to drop a mine behind you.',
    kind: 'item',
    key: 'Q',
    weight: 2,
    duration: 0,
  },
  oil: {
    icon: '🟢',
    name: 'Oil',
    desc: 'Press Q to drop an oil slick behind you.',
    kind: 'item',
    key: 'Q',
    weight: 2,
    duration: 0,
  },
  repair: {
    icon: '🔧',
    name: 'Repair',
    desc: 'Press Q to restore armor.',
    kind: 'item',
    key: 'Q',
    weight: 1,
    duration: 0,
  },
  spikes: {
    icon: '🛞',
    name: 'Spike Strip',
    desc: 'Q drops a strip of spikes behind you.',
    kind: 'item',
    key: 'Q',
    weight: 2,
    duration: 0,
  },
};

// Weighted-random pickup choice for spawn slots.
export function rollPickupKind(rng) {
  const totalWeight = Object.values(ITEMS).reduce((s, it) => s + (it.weight || 1), 0);
  let r = rng() * totalWeight;
  for (const [id, it] of Object.entries(ITEMS)) {
    r -= it.weight || 1;
    if (r <= 0) return id;
  }
  return 'scrap';
}
