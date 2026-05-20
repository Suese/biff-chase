// Garage upgrades — spent between races, persist across the match.
//
// Each upgrade has a cost function (level -> next cost) and an effect curve
// that physics.js reads when building/refreshing car stats.

export const UPGRADES = {
  engine: {
    icon: '⚙️',
    name: 'Engine',
    desc: 'Higher top speed and faster acceleration.',
    maxLevel: 5,
    costAt: (lvl) => 8 + lvl * 6,
  },
  tires: {
    icon: '🛞',
    name: 'Tires',
    desc: 'Better grip in corners.',
    maxLevel: 5,
    costAt: (lvl) => 6 + lvl * 5,
  },
  armor: {
    icon: '🛡️',
    name: 'Armor',
    desc: 'Less hurt by mines and rams.',
    maxLevel: 5,
    costAt: (lvl) => 7 + lvl * 5,
  },
  fuel: {
    icon: '⛽',
    name: 'Fuel Tank',
    desc: 'Longer nitro boosts.',
    maxLevel: 3,
    costAt: (lvl) => 10 + lvl * 6,
  },
};

// Resolve car stats from base + upgrade levels. All physics tuning lives here.
export function computeStats(upgrades = {}) {
  const eng = upgrades.engine || 0;
  const tir = upgrades.tires  || 0;
  const arm = upgrades.armor  || 0;
  const fue = upgrades.fuel   || 0;
  return {
    maxSpeed:   420 + eng * 50,    // pixels per second
    accel:      820 + eng * 140,
    brake:     1200 + eng * 40,
    reverse:    280 + eng * 28,
    grip:       0.55 + tir * 0.06,  // lower = more drift
    turnSpeed:  3.2 + tir * 0.35,   // rad/sec
    armor:      100 + arm * 35,
    nitroMul:   1.0 + fue * 0.25,
    nitroBoost: 1.55 + eng * 0.06,  // top-speed mul during nitro
  };
}
