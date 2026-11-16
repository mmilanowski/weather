// Weather condition text + minimal SVG icons for WMO weather codes
// (the codes Open-Meteo returns).

const CODES = {
  0: ['Clear', 'clear'],
  1: ['Mostly clear', 'mostly-clear'],
  2: ['Partly cloudy', 'partly'],
  3: ['Cloudy', 'cloudy'],
  45: ['Fog', 'fog'],
  48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'drizzle'],
  53: ['Drizzle', 'drizzle'],
  55: ['Heavy drizzle', 'drizzle'],
  56: ['Freezing drizzle', 'sleet'],
  57: ['Freezing drizzle', 'sleet'],
  61: ['Light rain', 'rain'],
  63: ['Rain', 'rain'],
  65: ['Heavy rain', 'heavy-rain'],
  66: ['Freezing rain', 'sleet'],
  67: ['Freezing rain', 'sleet'],
  71: ['Light snow', 'snow'],
  73: ['Snow', 'snow'],
  75: ['Heavy snow', 'snow'],
  77: ['Snow grains', 'snow'],
  80: ['Light showers', 'showers'],
  81: ['Showers', 'showers'],
  82: ['Heavy showers', 'heavy-rain'],
  85: ['Snow showers', 'snow'],
  86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorms', 'thunder'],
  96: ['Thunderstorms with hail', 'thunder'],
  99: ['Thunderstorms with hail', 'thunder'],
};

export function describe(code) {
  return (CODES[code] || ['—', 'cloudy'])[0];
}

const CLOUD = 'M20 46h26a10 10 0 0 0 1-19.95A14 14 0 0 0 20.5 24 11 11 0 0 0 20 46z';

const sun = (cx = 32, cy = 32, r = 10, rays = true) => {
  let s = `<circle class="sun" cx="${cx}" cy="${cy}" r="${r}"/>`;
  if (rays) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const r1 = r + 5, r2 = r + 9;
      const f = (n) => n.toFixed(1);
      s += `<line class="ray" x1="${f(cx + Math.cos(a) * r1)}" y1="${f(cy + Math.sin(a) * r1)}" x2="${f(cx + Math.cos(a) * r2)}" y2="${f(cy + Math.sin(a) * r2)}"/>`;
    }
  }
  return s;
};

const moon = (tx = 0, ty = 0, sc = 1) =>
  `<path class="moon" transform="translate(${tx} ${ty}) scale(${sc})" d="M38 12a18 18 0 1 0 14 29A15 15 0 0 1 38 12z"/>`;

const cloud = (tx = 0, ty = 0, sc = 1, dark = false) =>
  `<path class="cloud${dark ? ' dark' : ''}" transform="translate(${tx} ${ty}) scale(${sc})" d="${CLOUD}"/>`;

const drops = (n, heavy = false) => {
  const xs = n === 2 ? [26, 38] : [22, 32, 42];
  return xs.map((x) => `<line class="drop" x1="${x}" y1="${heavy ? 49 : 50}" x2="${x - 3}" y2="${heavy ? 60 : 57}"/>`).join('');
};

const flakes = () => [22, 32, 42].map((x, i) => `<circle class="flake" cx="${x}" cy="${i % 2 ? 58 : 53}" r="2.8"/>`).join('');

const ICONS = {
  'clear': (day) => (day ? sun(32, 32, 11) : moon(2, 2, 0.95)),
  'mostly-clear': (day) => (day ? sun(28, 26, 10) : moon(-4, -4, 0.85)) + cloud(16, 18, 0.7),
  'partly': (day) => (day ? sun(23, 22, 9) : moon(-8, -8, 0.8)) + cloud(4, 6, 0.95),
  'cloudy': () => cloud(4, -6, 0.75, true) + cloud(0, 2),
  'fog': () => cloud(0, -6) + '<line class="fog" x1="14" y1="48" x2="50" y2="48"/><line class="fog" x1="20" y1="56" x2="44" y2="56"/>',
  'drizzle': () => cloud(0, -6) + drops(2),
  'rain': () => cloud(0, -6) + drops(3),
  'heavy-rain': () => cloud(0, -6, 1, true) + drops(3, true),
  'showers': (day) => (day ? sun(22, 18, 8) : moon(-10, -12, 0.7)) + cloud(2, -4, 0.95) + drops(2),
  'sleet': () => cloud(0, -6) + '<line class="drop" x1="24" y1="50" x2="21" y2="57"/><circle class="flake" cx="32" cy="56" r="2.8"/><line class="drop" x1="42" y1="50" x2="39" y2="57"/>',
  'snow': () => cloud(0, -6) + flakes(),
  'thunder': () => cloud(0, -8, 1, true) + '<path class="bolt" d="M34 38h-8l-4 12h7l-3 12 12-16h-7l3-8z"/>',
};

export function icon(code, isDay = true, cls = '') {
  const kind = (CODES[code] || [null, 'cloudy'])[1];
  return `<svg class="wx ${cls}" viewBox="0 0 64 64" aria-hidden="true">${ICONS[kind](isDay)}</svg>`;
}

export const GPS_ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3 3 10.5l7.5 3L13.5 21z"/></svg>';
export const ALERT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.01"/></svg>';
