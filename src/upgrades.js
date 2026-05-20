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
// Scale reference: car length 56 px ≈ 4.5 m → 1 m ≈ 12.4 px.
// maxSpeed 720 px/sec ≈ 58 m/sec ≈ 210 km/h — realistic arcade top speed.

export function computeStats(upgrades = {}) {
  const eng = upgrades.engine || 0;
  const tir = upgrades.tires  || 0;
  const arm = upgrades.armor  || 0;
  const fue = upgrades.fuel   || 0;
  return {
    maxSpeed:   720 + eng * 90,
    accel:     1200 + eng * 220,
    brake:     1500 + eng * 80,
    reverse:    340 + eng * 40,
    grip:       0.55 + tir * 0.10,
    turnSpeed:  3.6 + tir * 0.40,
    armor:      400 + arm * 140,
    nitroMul:   1.0 + fue * 0.25,
    nitroBoost: 1.45 + eng * 0.05,
  };
}
