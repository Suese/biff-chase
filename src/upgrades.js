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
    // Stock car ≈ 4× the prior baseline. Walls are now genuinely dangerous.
    maxSpeed:   1700 + eng * 180,
    accel:      3000 + eng * 480,
    brake:      2600 + eng * 120,
    reverse:     520 + eng * 60,
    // Aggressively low grip + brisk turn rate so the car is twitchy from the
    // first race. Upgrade tires to tame it.
    grip:       0.55 + tir * 0.10,    // base grip when going straight; drift erodes it
    turnSpeed:  3.6 + tir * 0.40,
    armor:      400 + arm * 140,      // ~4× tougher; survives several scrapes

    nitroMul:   1.0 + fue * 0.25,
    nitroBoost: 1.45 + eng * 0.05,
  };
}
