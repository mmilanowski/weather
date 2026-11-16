// Settings and cached weather, kept in this phone's localStorage.

const SETTINGS_KEY = 'wx:settings';
const DATA_PREFIX = 'wx:data:';

const DEFAULTS = {
  places: [],          // [{ id, name, region, lat, lon }]
  useGps: true,
  gpsPlace: null,      // last known { lat, lon, name, region }
  units: 'imperial',
  theme: 'system',
};

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the app still works, it just won't remember.
  }
}

export function loadSettings() {
  return { ...DEFAULTS, ...(read(SETTINGS_KEY) || {}) };
}

export function saveSettings(settings) {
  write(SETTINGS_KEY, settings);
}

export function loadData(key) {
  return read(DATA_PREFIX + key);
}

export function saveData(key, entry) {
  write(DATA_PREFIX + key, entry);
}

export function removeDataFor(placeId) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(DATA_PREFIX + placeId + ':')) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}
