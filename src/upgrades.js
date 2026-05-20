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
    maxSpeed:   240 + eng * 28,    // pixels per second
    accel:      520 + eng * 90,
    brake:      900 + eng * 30,
    reverse:    180 + eng * 20,
    grip:       0.85 + tir * 0.025, // lateral friction coefficient (caps near 1.0)
    turnSpeed:  3.0 + tir * 0.35,   // rad/sec
    armor:      100 + arm * 35,
    nitroMul:   1.0 + fue * 0.25,   // multiplies nitro duration
    nitroBoost: 1.55 + eng * 0.06,  // top-speed mul during nitro
  };
}
