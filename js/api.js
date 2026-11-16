// All network calls. Every source here is free and needs no API key.

async function getJSON(url, { timeout = 15000, headers } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const coord = (n) => Number(n).toFixed(4);

// Open-Meteo forecast: current conditions, 48+ hours, 10 days.
export function getForecast(lat, lon, units) {
  const p = new URLSearchParams({
    latitude: coord(lat),
    longitude: coord(lon),
    current: [
      'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'dew_point_2m',
      'is_day', 'weather_code', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
      'pressure_msl', 'visibility', 'precipitation',
    ].join(','),
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day,uv_index',
    daily: [
      'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max',
      'precipitation_sum', 'sunrise', 'sunset', 'uv_index_max',
    ].join(','),
    timezone: 'auto',
    forecast_days: '10',
  });
  if (units === 'imperial') {
    p.set('temperature_unit', 'fahrenheit');
    p.set('wind_speed_unit', 'mph');
    p.set('precipitation_unit', 'inch');
  } else {
    p.set('wind_speed_unit', 'kmh');
  }
  return getJSON(`https://api.open-meteo.com/v1/forecast?${p}`);
}

// Open-Meteo air quality (US AQI).
export async function getAirQuality(lat, lon) {
  const p = new URLSearchParams({
    latitude: coord(lat),
    longitude: coord(lon),
    current: 'us_aqi,pm2_5,ozone',
    timezone: 'auto',
  });
  const data = await getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?${p}`);
  return data && data.current ? data.current : null;
}

const SEVERITY_RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };

// National Weather Service active alerts for a point (US only; elsewhere returns none).
export async function getAlerts(lat, lon) {
  try {
    const data = await getJSON(
      `https://api.weather.gov/alerts/active?point=${coord(lat)},${coord(lon)}`,
      { headers: { Accept: 'application/geo+json' } },
    );
    return (data.features || [])
      .map((f) => f.properties || {})
      .filter((a) => a.messageType !== 'Cancel' && a.status !== 'Test')
      .map((a) => ({
        id: a.id,
        event: a.event || 'Weather alert',
        headline: a.headline || '',
        description: a.description || '',
        instruction: a.instruction || '',
        severity: a.severity || 'Unknown',
        sender: a.senderName || '',
        area: a.areaDesc || '',
        onset: a.onset || a.effective || null,
        ends: a.ends || a.expires || null,
      }))
      .sort((x, y) => (SEVERITY_RANK[x.severity] ?? 4) - (SEVERITY_RANK[y.severity] ?? 4));
  } catch (e) {
    // 400/404 = point outside NWS coverage. Not an error worth showing.
    if (e.status === 400 || e.status === 404) return [];
    throw e;
  }
}

// Name for a GPS position, via NWS (US only). Returns null outside the US.
export async function getPlaceName(lat, lon) {
  try {
    const data = await getJSON(`https://api.weather.gov/points/${coord(lat)},${coord(lon)}`,
      { headers: { Accept: 'application/geo+json' }, timeout: 10000 });
    const rel = data?.properties?.relativeLocation?.properties;
    if (rel?.city) return { name: rel.city, region: rel.state || '' };
  } catch { /* fall through */ }
  return null;
}

// City / ZIP code search.
export async function searchPlaces(query) {
  const p = new URLSearchParams({ name: query.trim(), count: '10', language: 'en', format: 'json' });
  const data = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?${p}`, { timeout: 10000 });
  return (data.results || []).map((r) => ({
    id: `p${r.id}`,
    name: r.name,
    region: [r.admin1, r.country_code === 'US' ? '' : r.country].filter(Boolean).join(', '),
    country: r.country_code,
    lat: r.latitude,
    lon: r.longitude,
  }));
}

// RainViewer radar frame list.
export async function getRadarFrames() {
  const data = await getJSON('https://api.rainviewer.com/public/weather-maps.json', { timeout: 10000 });
  const frames = [...(data.radar?.past || []), ...(data.radar?.nowcast || [])];
  return { host: data.host || 'https://tilecache.rainviewer.com', frames };
}
