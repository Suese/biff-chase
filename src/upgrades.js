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
// All units are SI: metres, m/s, m/s², radians/second.
//   stock car  ≈ 33 m/s top speed = 120 km/h
//   fully eng  ≈ 83 m/s = 300 km/h
//   stock acc  ≈ 8 m/s²            (Tesla Performance territory)
//   fully acc  ≈ 23 m/s²            (arcade)

export function computeStats(upgrades = {}) {
  const eng = upgrades.engine || 0;
  const tir = upgrades.tires  || 0;
  const arm = upgrades.armor  || 0;
  const fue = upgrades.fuel   || 0;
  return {
    maxSpeed:   33   + eng * 10,    // m/s
    accel:      8.0  + eng * 3.0,   // m/s²
    brake:     16    + eng * 4,     // m/s²
    reverse:    6    + eng * 1.5,   // m/s
    grip:       0.40 + tir * 0.10,  // dimensionless; lower = tires slip more
    turnSpeed:  2.4  + tir * 0.30,  // rad/s (max yaw rate when going fast)
    armor:    400    + arm * 140,
    nitroMul:   1.0  + fue * 0.25,
    nitroBoost: 1.45 + eng * 0.05,
  };
}
