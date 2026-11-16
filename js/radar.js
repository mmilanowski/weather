// Animated precipitation radar (RainViewer) on a Leaflet map.
import { getRadarFrames } from './api.js';

const FRAME_MS = 500;
const HOLD_LAST_MS = 1500;
// RainViewer's free tiles stop at zoom 7; Leaflet scales them up past that.
const RADAR_MAX_NATIVE_ZOOM = 7;

let map = null;
let baseLayer = null;
let baseDark = null;
let hereMarker = null;
let layers = [];
let frames = [];
let index = 0;
let timer = null;
let playing = true;
let loadedAt = 0;

const $ = (id) => document.getElementById(id);

function fmtTime(unix) {
  return new Date(unix * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function showMessage(text) {
  const el = $('radar-msg');
  el.textContent = text || '';
  el.hidden = !text;
}

function setBase(dark) {
  if (baseLayer && baseDark === dark) return;
  if (baseLayer) map.removeLayer(baseLayer);
  baseDark = dark;
  baseLayer = L.tileLayer(
    `https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`,
    {
      subdomains: 'abcd',
      maxZoom: 12,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a> · <a href="https://www.rainviewer.com/">RainViewer</a>',
    },
  ).addTo(map);
  baseLayer.bringToBack();
}

function showFrame(i) {
  if (!layers.length) return;
  index = (i + layers.length) % layers.length;
  layers.forEach((l, n) => l.setOpacity(n === index ? 0.75 : 0));
  $('radar-slider').value = String(index);
  const f = frames[index];
  const future = f.time * 1000 > Date.now() + 60_000;
  $('radar-time').textContent = (future ? '+' : '') + fmtTime(f.time);
}

function schedule() {
  clearTimeout(timer);
  if (!playing || layers.length < 2) return;
  const isLast = index === layers.length - 1;
  timer = setTimeout(() => {
    showFrame(index + 1);
    schedule();
  }, isLast ? HOLD_LAST_MS : FRAME_MS);
}

function setPlaying(p) {
  playing = p;
  const btn = $('radar-play');
  btn.classList.toggle('paused', !p);
  btn.setAttribute('aria-label', p ? 'Pause' : 'Play');
  schedule();
}

async function loadFrames() {
  showMessage('Loading radar…');
  try {
    const { host, frames: list } = await getRadarFrames();
    layers.forEach((l) => map.removeLayer(l));
    frames = list;
    layers = frames.map((f) =>
      L.tileLayer(`${host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
        opacity: 0,
        maxNativeZoom: RADAR_MAX_NATIVE_ZOOM,
        maxZoom: 12,
        zIndex: 10,
      }).addTo(map),
    );
    $('radar-slider').max = String(Math.max(0, layers.length - 1));
    // Start on the latest observed (not forecast) frame, then loop.
    const now = Date.now() / 1000;
    let latest = 0;
    frames.forEach((f, n) => { if (f.time <= now + 60) latest = n; });
    showFrame(latest);
    loadedAt = Date.now();
    showMessage(frames.length ? '' : 'No radar data right now');
    schedule();
  } catch {
    showMessage('Radar unavailable — check your connection');
  }
}

export function initRadarControls() {
  $('radar-play').addEventListener('click', () => setPlaying(!playing));
  $('radar-slider').addEventListener('input', (e) => {
    setPlaying(false);
    showFrame(Number(e.target.value));
  });
}

export function openRadar({ lat, lon, dark }) {
  if (typeof L === 'undefined') {
    showMessage('Map failed to load');
    return;
  }
  if (!map) {
    map = L.map('radar-map', {
      zoomControl: false,
      attributionControl: true,
      minZoom: 3,
      maxZoom: 12,
    });
  }
  setBase(dark);
  map.invalidateSize();
  map.setView([lat, lon], 7, { animate: false });
  if (hereMarker) hereMarker.setLatLng([lat, lon]);
  else {
    hereMarker = L.marker([lat, lon], {
      icon: L.divIcon({ className: '', html: '<div class="here-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
      interactive: false,
      keyboard: false,
    }).addTo(map);
  }
  if (!layers.length || Date.now() - loadedAt > 5 * 60_000) loadFrames();
  else showFrame(index);
  setPlaying(true);
}

export function closeRadar() {
  clearTimeout(timer);
}
