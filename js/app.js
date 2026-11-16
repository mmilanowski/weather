import * as api from './api.js';
import * as store from './store.js';
import { icon, describe, GPS_ARROW, ALERT_ICON } from './icons.js';
import { initRadarControls, openRadar, closeRadar } from './radar.js';

const STALE_MS = 10 * 60_000;      // refresh data older than this
const GPS_MOVE_KM = 1.5;           // refetch "My location" if moved this far

let settings = store.loadSettings();
const entries = new Map();         // cacheKey -> { fetchedAt, lat, lon, forecast, aqi, alerts, error }
const inflight = new Set();
let gpsState = 'idle';             // idle | locating | ok | denied | error
let currentId = null;

const $ = (id) => document.getElementById(id);
const pager = $('pager');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const imperial = () => settings.units === 'imperial';
const deg = (n) => (n == null || Number.isNaN(n) ? '--' : `${Math.round(n)}°`);

function hourLabel(iso) {
  const h = Number(iso.slice(11, 13));
  if (!imperial()) return `${String(h).padStart(2, '0')}`;
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}

function clockLabel(iso) {
  if (!iso) return '--';
  const h = Number(iso.slice(11, 13));
  const m = iso.slice(14, 16);
  if (!imperial()) return `${String(h).padStart(2, '0')}:${m}`;
  return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

function dayLabel(isoDate, i) {
  if (i === 0) return 'Today';
  const d = new Date(`${isoDate}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

function compass(degrees) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16];
}

function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

function uvLevel(uv) {
  if (uv < 3) return 'Low';
  if (uv < 6) return 'Moderate';
  if (uv < 8) return 'High';
  if (uv < 11) return 'Very high';
  return 'Extreme';
}

function aqiLevel(aqi) {
  if (aqi <= 50) return ['Good', '#3BB273'];
  if (aqi <= 100) return ['Moderate', '#E8C120'];
  if (aqi <= 150) return ['Unhealthy for sensitive groups', '#F08A24'];
  if (aqi <= 200) return ['Unhealthy', '#E5484D'];
  if (aqi <= 300) return ['Very unhealthy', '#8E4EC6'];
  return ['Hazardous', '#7A1F2B'];
}

function distanceKm(a, b) {
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ------------------------------------------------------------------ */
/* Places & data                                                       */
/* ------------------------------------------------------------------ */

function pageList() {
  const list = [];
  if (settings.useGps && (settings.gpsPlace || gpsState === 'locating')) {
    list.push({ id: 'gps', isGps: true, ...(settings.gpsPlace || {}) });
  }
  return list.concat(settings.places);
}

const cacheKey = (place) => `${place.id}:${settings.units}`;

function getEntry(place) {
  const key = cacheKey(place);
  if (!entries.has(key)) {
    const cached = store.loadData(key);
    if (cached) entries.set(key, cached);
  }
  return entries.get(key) || null;
}

async function refresh(place, { force = false } = {}) {
  if (place.lat == null) return;
  const key = cacheKey(place);
  const prev = getEntry(place);
  const moved = prev && distanceKm(prev, place) > GPS_MOVE_KM;
  if (!force && !moved && prev && !prev.error && Date.now() - prev.fetchedAt < STALE_MS) return;
  if (inflight.has(key)) return;
  inflight.add(key);
  renderStatus(place);
  try {
    const [f, a, al] = await Promise.allSettled([
      api.getForecast(place.lat, place.lon, settings.units),
      api.getAirQuality(place.lat, place.lon),
      api.getAlerts(place.lat, place.lon),
    ]);
    if (f.status === 'rejected') throw f.reason;
    const entry = {
      fetchedAt: Date.now(),
      lat: place.lat,
      lon: place.lon,
      forecast: f.value,
      aqi: a.status === 'fulfilled' ? a.value : prev?.aqi ?? null,
      alerts: al.status === 'fulfilled' ? al.value : prev?.alerts ?? [],
      error: null,
    };
    entries.set(key, entry);
    store.saveData(key, entry);
  } catch (e) {
    const failed = { ...(prev || {}), error: navigator.onLine === false ? 'offline' : 'failed' };
    entries.set(key, failed);
  } finally {
    inflight.delete(key);
    renderPage(place);
    if ($('sheet-places').open) renderPlacesList();
  }
}

function refreshAll(opts) {
  const list = pageList();
  // Current page first so it's ready soonest.
  list.sort((a, b) => (a.id === currentId ? -1 : b.id === currentId ? 1 : 0));
  list.forEach((p) => refresh(p, opts));
}

function locate({ prompt = false } = {}) {
  if (!('geolocation' in navigator)) {
    gpsState = 'error';
    syncPages();
    return;
  }
  if (gpsState === 'locating') return;
  gpsState = 'locating';
  if (!settings.gpsPlace || prompt) syncPages();
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      const old = settings.gpsPlace;
      const needName = !old || !old.name || distanceKm(old, here) > GPS_MOVE_KM;
      let name = old && !needName ? { name: old.name, region: old.region } : null;
      settings.gpsPlace = { ...here, name: name?.name || old?.name || 'My location', region: name?.region || old?.region || '' };
      gpsState = 'ok';
      saveSettings();
      syncPages();
      refresh(pageList().find((p) => p.id === 'gps'));
      if (needName) {
        name = await api.getPlaceName(here.lat, here.lon);
        settings.gpsPlace = { ...settings.gpsPlace, name: name?.name || 'My location', region: name?.region || '' };
        saveSettings();
        renderPage(pageList().find((p) => p.id === 'gps'));
        renderDots();
      }
    },
    (err) => {
      gpsState = err.code === 1 ? 'denied' : 'error';
      if (err.code === 1) {
        // Permission denied: forget the old position so we don't show stale "My location".
        settings.gpsPlace = null;
        saveSettings();
      }
      syncPages();
    },
    { enableHighAccuracy: false, timeout: 20000, maximumAge: 10 * 60_000 },
  );
}

function saveSettings() {
  store.saveSettings(settings);
}

/* ------------------------------------------------------------------ */
/* Rendering: pages                                                    */
/* ------------------------------------------------------------------ */

function syncPages() {
  const list = pageList();
  const existing = new Map([...pager.children].map((el) => [el.dataset.id, el]));
  const wanted = list.map((p) => {
    let el = existing.get(p.id);
    if (!el) {
      el = document.createElement('section');
      el.className = 'page';
      el.dataset.id = p.id;
    }
    return el;
  });

  if (!list.length) {
    let empty = existing.get('__empty');
    if (!empty) {
      empty = document.createElement('section');
      empty.className = 'page';
      empty.dataset.id = '__empty';
    }
    renderEmpty(empty);
    wanted.push(empty);
  }

  const same = wanted.length === pager.children.length && wanted.every((el, i) => pager.children[i] === el);
  if (!same) pager.replaceChildren(...wanted);

  list.forEach(renderPage);

  const ids = wanted.map((el) => el.dataset.id);
  if (!ids.includes(currentId)) currentId = ids[0];
  scrollToPage(currentId, false);
  renderDots();
}

function scrollToPage(id, smooth = true) {
  const i = [...pager.children].findIndex((el) => el.dataset.id === id);
  if (i < 0) return;
  pager.scrollTo({ left: i * pager.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
  currentId = id;
  renderDots();
}

function renderDots() {
  const dots = $('dots');
  const list = pageList();
  if (list.length < 2) {
    dots.innerHTML = '';
    return;
  }
  dots.innerHTML = list
    .map((p) => (p.isGps
      ? `<span class="dot gps${p.id === currentId ? ' on' : ''}">${GPS_ARROW}</span>`
      : `<span class="dot${p.id === currentId ? ' on' : ''}"></span>`))
    .join('');
}

function pageEl(id) {
  return [...pager.children].find((el) => el.dataset.id === id);
}

function renderEmpty(el) {
  const denied = gpsState === 'denied';
  el.innerHTML = `
    <div class="page-inner">
      <div class="state">
        ${icon(2, true)}
        <h2>Welcome</h2>
        <p>${denied
          ? 'Location access is blocked. Allow it in your browser’s site settings, or add a city instead.'
          : gpsState === 'error'
            ? 'Couldn’t find your location. Try again or add a city.'
            : 'Show the weather where you are, or add cities you care about.'}</p>
        <button class="btn" data-act="locate">Use my location</button>
        <button class="btn secondary" data-act="add">Add a city</button>
      </div>
    </div>`;
}

function renderPage(place) {
  if (!place) return;
  const el = pageEl(place.id);
  if (!el) return;
  const entry = place.lat != null ? getEntry(place) : null;
  const f = entry?.forecast;

  if (!f) {
    const failed = entry?.error;
    el.innerHTML = `
      <div class="page-inner">
        <header class="hero">
          <h1 class="place-name">${place.isGps ? GPS_ARROW : ''}<span class="name">${esc(place.name || 'My location')}</span></h1>
        </header>
        <div class="state" style="min-height:40vh">
          ${failed
            ? `<p>${failed === 'offline' ? 'You’re offline.' : 'Couldn’t load the weather.'}</p><button class="btn" data-act="retry">Try again</button>`
            : `<div class="spinner" role="status" aria-label="Loading"></div><p>${place.lat == null ? 'Finding your location…' : 'Loading weather…'}</p>`}
        </div>
      </div>`;
    return;
  }

  const hourlyScroll = el.querySelector('.hourly-scroll')?.scrollLeft || 0;
  const c = f.current;
  const d = f.daily;
  const h = f.hourly;
  const now = c.time;
  let hi = h.time.findIndex((t) => t > now) - 1;
  if (hi < 0) hi = 0;

  const alerts = (entry.alerts || []).filter((a) => !a.ends || new Date(a.ends) > new Date());

  el.innerHTML = `
    <div class="page-inner">
      ${alerts.length ? alertBanner(alerts) : ''}
      <header class="hero">
        <h1 class="place-name">${place.isGps ? GPS_ARROW : ''}<span class="name">${esc(place.name)}</span></h1>
        ${icon(c.weather_code, c.is_day === 1, 'hero-icon')}
        <div class="hero-temp">${deg(c.temperature_2m)}</div>
        <div class="hero-cond">${describe(c.weather_code)}</div>
        <div class="hero-sub">H ${deg(d.temperature_2m_max[0])} · L ${deg(d.temperature_2m_min[0])} · Feels like ${deg(c.apparent_temperature)}</div>
      </header>
      ${hourlyCard(f, hi)}
      ${dailyCard(f)}
      ${tiles(f, entry, hi)}
      <button class="status${entry.error ? ' err' : ''}" data-act="retry">${statusText(place, entry)}</button>
    </div>`;

  const hs = el.querySelector('.hourly-scroll');
  if (hs && hourlyScroll) hs.scrollLeft = hourlyScroll;
}

function statusText(place, entry) {
  if (inflight.has(cacheKey(place))) return 'Updating…';
  if (entry.error === 'offline') return `Offline · updated ${ago(entry.fetchedAt)}`;
  if (entry.error) return `Couldn’t refresh · updated ${ago(entry.fetchedAt)} · tap to retry`;
  return `Updated ${ago(entry.fetchedAt)}`;
}

function renderStatus(place) {
  const el = pageEl(place.id);
  const s = el?.querySelector('.status');
  if (s) s.textContent = 'Updating…';
}

function alertBanner(alerts) {
  const sev = alerts[0].severity;
  const cls = sev === 'Moderate' ? 'sev-moderate' : sev === 'Minor' || sev === 'Unknown' ? 'sev-minor' : '';
  const more = alerts.length > 1 ? `<small>+${alerts.length - 1} more alert${alerts.length > 2 ? 's' : ''}</small>` : '<small>Tap for details</small>';
  return `<button class="alert-banner ${cls}" data-act="alerts">${ALERT_ICON}<span class="t">${esc(alerts[0].event)}${more}</span></button>`;
}

function hourlyCard(f, hi) {
  const h = f.hourly;
  const c = f.current;
  const end = Math.min(h.time.length, hi + 48);
  let cells = `
    <div class="hour now">
      <span class="h">Now</span>
      ${icon(c.weather_code, c.is_day === 1)}
      <span class="t">${deg(c.temperature_2m)}</span>
      <span class="p${(h.precipitation_probability[hi] ?? 0) < 10 ? ' zero' : ''}">${h.precipitation_probability[hi] ?? 0}%</span>
    </div>`;
  for (let i = hi + 1; i < end; i++) {
    const p = h.precipitation_probability[i] ?? 0;
    const label = h.time[i].slice(11, 13) === '00'
      ? new Date(`${h.time[i].slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
      : hourLabel(h.time[i]);
    cells += `
      <div class="hour${label.length === 3 && !/\d/.test(label) ? ' daybreak' : ''}">
        <span class="h">${label}</span>
        ${icon(h.weather_code[i], h.is_day[i] === 1)}
        <span class="t">${deg(h.temperature_2m[i])}</span>
        <span class="p${p < 10 ? ' zero' : ''}">${p}%</span>
      </div>`;
  }
  return `<section class="card"><h2 class="card-title">Next 48 hours</h2><div class="hourly-scroll">${cells}</div></section>`;
}

function dailyCard(f) {
  const d = f.daily;
  const lows = d.temperature_2m_min.filter((v) => v != null);
  const highs = d.temperature_2m_max.filter((v) => v != null);
  const min = Math.min(...lows), max = Math.max(...highs);
  const span = Math.max(1, max - min);
  const cur = f.current.temperature_2m;
  const rows = d.time.map((t, i) => {
    const lo = d.temperature_2m_min[i], hi = d.temperature_2m_max[i];
    const p = d.precipitation_probability_max[i] ?? 0;
    const left = ((lo - min) / span) * 100;
    const width = ((hi - lo) / span) * 100;
    const dot = i === 0 && cur != null
      ? `<span class="cur" style="left:${Math.min(100, Math.max(0, ((cur - min) / span) * 100)).toFixed(1)}%"></span>`
      : '';
    return `
      <li class="day">
        <span class="d">${dayLabel(t, i)}</span>
        ${icon(d.weather_code[i], true)}
        <span class="p">${p >= 10 ? `${p}%` : ''}</span>
        <span class="lo">${deg(lo)}</span>
        <span class="range"><span class="bar" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span>${dot}</span>
        <span class="hi">${deg(hi)}</span>
      </li>`;
  }).join('');
  return `<section class="card"><h2 class="card-title">${d.time.length}-day forecast</h2><ul class="daily-list">${rows}</ul></section>`;
}

function tiles(f, entry, hi) {
  const c = f.current;
  const d = f.daily;
  const u = f.current_units || {};
  const imp = imperial();
  const windUnit = imp ? 'mph' : 'km/h';
  const out = [];

  // Wind
  const dir = c.wind_direction_10m ?? 0;
  out.push(`
    <div class="tile">
      <h3 class="card-title">Wind</h3>
      <div class="v">${Math.round(c.wind_speed_10m)}<small>${windUnit}</small>
        <svg class="wind-arrow" viewBox="0 0 24 24" style="transform:rotate(${(dir + 180) % 360}deg)" aria-hidden="true"><path d="M12 2 19 21 12 17 5 21z"/></svg>
      </div>
      <div class="s">From ${compass(dir)}${c.wind_gusts_10m != null ? `<br>Gusts ${Math.round(c.wind_gusts_10m)} ${windUnit}` : ''}</div>
    </div>`);

  // Humidity
  out.push(`
    <div class="tile">
      <h3 class="card-title">Humidity</h3>
      <div class="v">${Math.round(c.relative_humidity_2m)}%</div>
      <div class="s">Dew point ${deg(c.dew_point_2m)}</div>
    </div>`);

  // UV
  const uvNow = f.hourly.uv_index?.[hi];
  if (uvNow != null || d.uv_index_max?.[0] != null) {
    const uv = uvNow ?? 0;
    out.push(`
      <div class="tile">
        <h3 class="card-title">UV index</h3>
        <div class="v">${Math.round(uv)}</div>
        <div class="lvl">${uvLevel(uv)}</div>
        <div class="s">Today’s max ${Math.round(d.uv_index_max[0] ?? 0)}</div>
      </div>`);
  }

  // Air quality
  const aqi = entry.aqi?.us_aqi;
  if (aqi != null) {
    const [label, color] = aqiLevel(aqi);
    out.push(`
      <div class="tile">
        <h3 class="card-title">Air quality</h3>
        <div class="v">${Math.round(aqi)}<small>AQI</small></div>
        <div class="s"><span class="aqi-dot" style="background:${color}"></span>${label}</div>
      </div>`);
  }

  // Sun
  out.push(`
    <div class="tile">
      <h3 class="card-title">${c.is_day === 1 ? 'Sunset' : 'Sunrise'}</h3>
      <div class="v small-v">${clockLabel(c.is_day === 1 ? d.sunset[0] : nextSunrise(f))}</div>
      <div class="s">
        <div class="sun-row"><span>Sunrise</span><span>${clockLabel(d.sunrise[0])}</span></div>
        <div class="sun-row"><span>Sunset</span><span>${clockLabel(d.sunset[0])}</span></div>
      </div>
    </div>`);

  // Precipitation
  const sum = d.precipitation_sum?.[0];
  if (sum != null) {
    out.push(`
      <div class="tile">
        <h3 class="card-title">Precipitation</h3>
        <div class="v">${imp ? sum.toFixed(2) : sum.toFixed(1)}<small>${imp ? 'in' : 'mm'}</small></div>
        <div class="s">Expected today<br>${d.precipitation_probability_max[0] ?? 0}% chance</div>
      </div>`);
  }

  // Pressure
  if (c.pressure_msl != null) {
    const p = imp ? (c.pressure_msl * 0.02953).toFixed(2) : Math.round(c.pressure_msl);
    out.push(`
      <div class="tile">
        <h3 class="card-title">Pressure</h3>
        <div class="v">${p}<small>${imp ? 'inHg' : 'hPa'}</small></div>
        <div class="s">At sea level</div>
      </div>`);
  }

  // Visibility
  if (c.visibility != null) {
    const unit = u.visibility || 'm';
    const meters = /ft/.test(unit) ? c.visibility * 0.3048 : c.visibility;
    const val = imp ? meters / 1609.34 : meters / 1000;
    const shown = val >= 10 ? Math.round(val) : val.toFixed(1);
    out.push(`
      <div class="tile">
        <h3 class="card-title">Visibility</h3>
        <div class="v">${shown}<small>${imp ? 'mi' : 'km'}</small></div>
        <div class="s">${val >= (imp ? 6 : 10) ? 'Clear view' : val >= (imp ? 2 : 3) ? 'Somewhat hazy' : 'Poor visibility'}</div>
      </div>`);
  }

  return `<section class="tiles">${out.join('')}</section>`;
}

function nextSunrise(f) {
  const d = f.daily;
  const now = f.current.time;
  return d.sunrise.find((s) => s > now) || d.sunrise[0];
}

/* ------------------------------------------------------------------ */
/* Sheets (dialogs) with Android back-button support                   */
/* ------------------------------------------------------------------ */

const sheetStack = [];

function openSheet(id) {
  const dlg = $(id);
  if (dlg.open) return;
  dlg.showModal();
  sheetStack.push(id);
  history.pushState({ depth: sheetStack.length }, '');
}

function closeSheet(id) {
  const dlg = $(id);
  if (dlg.open) dlg.close();
}

document.querySelectorAll('dialog.sheet').forEach((dlg) => {
  dlg.addEventListener('close', () => {
    if (dlg.id === 'sheet-radar') closeRadar();
    if (dlg.id === 'sheet-places') resetSearch();
    const i = sheetStack.lastIndexOf(dlg.id);
    if (i < 0) return; // closed by the back button; history already moved
    sheetStack.splice(i, 1);
    history.back();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeSheet(dlg.id);
  });
});

window.addEventListener('popstate', (e) => {
  const depth = e.state?.depth || 0;
  while (sheetStack.length > depth) {
    const id = sheetStack.pop();
    closeSheet(id);
  }
});

/* ------------------------------------------------------------------ */
/* Places sheet                                                        */
/* ------------------------------------------------------------------ */

function placeRow(place, { saved }) {
  const entry = getEntry(place);
  const c = entry?.forecast?.current;
  const temp = c
    ? `<span class="row-temp">${icon(c.weather_code, c.is_day === 1)}${deg(c.temperature_2m)}</span>`
    : '';
  const sub = place.isGps
    ? (place.name && place.name !== 'My location' ? 'My location' : (gpsState === 'denied' ? 'Location access blocked' : 'Current position'))
    : place.region;
  return `
    <li data-id="${esc(place.id)}">
      <button class="row-main" data-act="goto">
        <span class="row-text">
          <strong>${place.isGps ? GPS_ARROW : ''}${esc(place.name || 'My location')}</strong>
          ${sub ? `<small>${esc(sub)}</small>` : ''}
        </span>
        ${temp}
      </button>
      ${saved ? `
        <button class="row-btn" data-act="remove" aria-label="Remove ${esc(place.name)}">
          <svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>
        </button>
        <button class="row-btn handle" aria-label="Drag to reorder">
          <svg viewBox="0 0 24 24"><path d="M5 9h14M5 15h14"/></svg>
        </button>` : ''}
    </li>`;
}

function renderPlacesList() {
  const gpsPlace = pageList().find((p) => p.isGps);
  $('gps-list').innerHTML = gpsPlace ? placeRow(gpsPlace, { saved: false }) : '';
  $('saved-list').innerHTML = settings.places.map((p) => placeRow(p, { saved: true })).join('');
  let hint = '';
  if (!settings.places.length) hint = 'Search above to add cities. You can swipe between them on the main screen.';
  else if (settings.places.length > 1) hint = 'Drag ☰ to reorder.';
  if (!settings.useGps) hint += (hint ? ' ' : '') + 'Your location is turned off in Settings.';
  $('places-hint').textContent = hint;
}

let searchTimer = null;
let searchSeq = 0;

function resetSearch() {
  $('search-input').value = '';
  $('search-results').hidden = true;
  $('search-results').innerHTML = '';
  $('places-lists').hidden = false;
}

async function runSearch(q) {
  const seq = ++searchSeq;
  const box = $('search-results');
  if (q.trim().length < 2) {
    resetSearch();
    $('search-input').value = q;
    return;
  }
  box.hidden = false;
  $('places-lists').hidden = true;
  box.innerHTML = '<li class="search-msg">Searching…</li>';
  let results;
  try {
    results = await api.searchPlaces(q);
  } catch {
    if (seq === searchSeq) box.innerHTML = '<li class="search-msg">Search failed. Check your connection.</li>';
    return;
  }
  if (seq !== searchSeq) return;
  if (!results.length) {
    box.innerHTML = '<li class="search-msg">No places found.</li>';
    return;
  }
  // US results first, since that's where this app is mostly used.
  results.sort((a, b) => (a.country === 'US' ? 0 : 1) - (b.country === 'US' ? 0 : 1));
  box.innerHTML = results.map((r) => {
    const already = settings.places.some((p) => p.id === r.id);
    return `
      <li data-result='${esc(JSON.stringify(r))}'>
        <button class="row-main" data-act="${already ? 'goto-result' : 'add-result'}">
          <span class="row-text"><strong>${esc(r.name)}</strong><small>${esc(r.region || r.country || '')}</small></span>
        </button>
        <span class="row-btn ${already ? 'added' : 'add'}" aria-hidden="true">
          <svg viewBox="0 0 24 24">${already ? '<path d="M5 12l5 5 9-10"/>' : '<path d="M12 5v14M5 12h14"/>'}</svg>
        </span>
      </li>`;
  }).join('');
}

function addPlace(r) {
  const place = { id: r.id, name: r.name, region: r.region, lat: r.lat, lon: r.lon };
  if (!settings.places.some((p) => p.id === place.id)) {
    settings.places.push(place);
    saveSettings();
  }
  syncPages();
  refresh(place);
  closeSheet('sheet-places');
  scrollToPage(place.id, false);
}

function removePlace(id) {
  settings.places = settings.places.filter((p) => p.id !== id);
  saveSettings();
  store.removeDataFor(id);
  for (const k of entries.keys()) if (k.startsWith(`${id}:`)) entries.delete(k);
  syncPages();
  renderPlacesList();
}

function setupDragReorder() {
  const list = $('saved-list');
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.handle');
    if (!handle) return;
    e.preventDefault();
    const li = handle.closest('li');
    const startY = e.clientY;
    const startTop = li.getBoundingClientRect().top;
    li.classList.add('dragging');
    // Listen on window: moving the row in the DOM drops pointer capture.

    const move = (ev) => {
      const others = [...list.children].filter((x) => x !== li);
      const y = ev.clientY;
      const before = others.find((s) => {
        const r = s.getBoundingClientRect();
        return y < r.top + r.height / 2;
      });
      if (before) {
        if (li.nextElementSibling !== before) list.insertBefore(li, before);
      } else if (list.lastElementChild !== li) {
        list.appendChild(li);
      }
      const shift = ev.clientY - startY - (li.getBoundingClientRect().top - startTop);
      li.style.transform = `translateY(${shift}px)`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      li.classList.remove('dragging');
      li.style.transform = '';
      const order = [...list.children].map((x) => x.dataset.id);
      settings.places.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      saveSettings();
      syncPages();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

/* ------------------------------------------------------------------ */
/* Alerts sheet                                                        */
/* ------------------------------------------------------------------ */

function showAlerts(place) {
  const entry = getEntry(place);
  const alerts = (entry?.alerts || []).filter((a) => !a.ends || new Date(a.ends) > new Date());
  const fmt = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  $('alerts-body').innerHTML = alerts.map((a) => {
    const cls = a.severity === 'Moderate' ? 'sev-moderate' : a.severity === 'Minor' || a.severity === 'Unknown' ? 'sev-minor' : '';
    return `
      <article class="alert ${cls}">
        <h3>${esc(a.event)}</h3>
        <div class="meta">
          ${a.ends ? `Until ${esc(fmt(a.ends))}` : ''}${a.sender ? ` · ${esc(a.sender)}` : ''}
        </div>
        ${a.headline ? `<p class="headline">${esc(a.headline)}</p>` : ''}
        ${a.description ? `<p class="body">${esc(a.description.replace(/\n(?!\n)/g, ' '))}</p>` : ''}
        ${a.instruction ? `<h4>What to do</h4><p class="body">${esc(a.instruction.replace(/\n(?!\n)/g, ' '))}</p>` : ''}
      </article>`;
  }).join('') || '<p class="hint">No active alerts.</p>';
  openSheet('sheet-alerts');
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = settings.theme;
  const dark = isDark();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    if (settings.theme === 'system') {
      m.content = m.media.includes('dark') ? '#0B0F14' : '#F4F6F9';
    } else {
      m.content = dark ? '#0B0F14' : '#F4F6F9';
    }
  });
}

function isDark() {
  if (settings.theme === 'dark') return true;
  if (settings.theme === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function syncSettingsForm() {
  document.querySelector(`input[name="units"][value="${settings.units}"]`).checked = true;
  document.querySelector(`input[name="theme"][value="${settings.theme}"]`).checked = true;
  $('set-gps').checked = settings.useGps;
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function currentPlace() {
  return pageList().find((p) => p.id === currentId);
}

pager.addEventListener('scroll', () => {
  const i = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
  const el = pager.children[i];
  if (el && el.dataset.id !== currentId) {
    currentId = el.dataset.id;
    renderDots();
  }
}, { passive: true });

window.addEventListener('resize', () => scrollToPage(currentId, false));

pager.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const place = currentPlace();
  if (act === 'retry' && place) {
    if (place.isGps) locate();
    refresh(place, { force: true });
  } else if (act === 'alerts' && place) {
    showAlerts(place);
  } else if (act === 'locate') {
    settings.useGps = true;
    saveSettings();
    locate({ prompt: true });
  } else if (act === 'add') {
    openPlaces(true);
  }
});

function openPlaces(focusSearch = false) {
  renderPlacesList();
  openSheet('sheet-places');
  if (focusSearch) $('search-input').focus();
}

$('btn-places').addEventListener('click', () => openPlaces());

$('btn-radar').addEventListener('click', () => {
  const place = currentPlace() || settings.places[0];
  const fallback = { lat: 39.5, lon: -98.35 }; // middle of the US
  openSheet('sheet-radar');
  openRadar({ lat: place?.lat ?? fallback.lat, lon: place?.lon ?? fallback.lon, dark: isDark() });
});

$('btn-settings').addEventListener('click', () => {
  syncSettingsForm();
  openSheet('sheet-settings');
});

$('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value;
  searchTimer = setTimeout(() => runSearch(q), 300);
});

$('search-results').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const r = JSON.parse(btn.closest('li').dataset.result);
  if (btn.dataset.act === 'add-result') addPlace(r);
  else {
    closeSheet('sheet-places');
    scrollToPage(r.id, false);
  }
});

$('places-lists').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  if (btn.dataset.act === 'goto') {
    closeSheet('sheet-places');
    scrollToPage(id, false);
  } else if (btn.dataset.act === 'remove') {
    removePlace(id);
  }
});

document.querySelectorAll('input[name="units"]').forEach((r) => r.addEventListener('change', () => {
  settings.units = r.value;
  saveSettings();
  syncPages();
  refreshAll();
}));

document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => {
  settings.theme = r.value;
  saveSettings();
  applyTheme();
}));

$('set-gps').addEventListener('change', (e) => {
  settings.useGps = e.target.checked;
  if (!settings.useGps) {
    settings.gpsPlace = null;
    gpsState = 'idle';
    store.removeDataFor('gps');
    for (const k of entries.keys()) if (k.startsWith('gps:')) entries.delete(k);
  }
  saveSettings();
  if (settings.useGps) locate({ prompt: true });
  syncPages();
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// Coming back to the app: refresh anything stale and re-check location.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (settings.useGps) locate();
  refreshAll();
  pageList().forEach(renderPage); // update "Updated x min ago"
});
window.addEventListener('online', () => refreshAll());

// Keep the "Updated x min ago" labels honest.
setInterval(() => {
  if (document.visibilityState === 'visible') {
    pageList().forEach((p) => {
      const entry = getEntry(p);
      const s = pageEl(p.id)?.querySelector('.status');
      if (entry?.fetchedAt && s) s.textContent = statusText(p, entry);
    });
  }
}, 60_000);

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

applyTheme();
initRadarControls();
setupDragReorder();
syncPages();
if (settings.useGps) locate();
refreshAll();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
