# Weather

A clean, minimal weather app for my Android phone. It's a web app (PWA) that installs to the home screen from Chrome.

## Features
- Current conditions, the next 48 hours and a 10-day forecast
- "My location" from GPS, plus saved cities (search by name or ZIP). Swipe between them and drag to reorder.
- Animated rain/snow radar
- National Weather Service severe weather alerts, shown as a banner
- Wind, humidity, UV, air quality, sunrise/sunset, precipitation, pressure and visibility
- Works offline with the last forecast it loaded; light/dark follows the phone

## Data sources (free, no API keys)
- [Open-Meteo](https://open-meteo.com/): forecast, air quality, city search
- [api.weather.gov](https://www.weather.gov/documentation/services-web-api): alerts and the GPS place name
- [RainViewer](https://www.rainviewer.com/api.html): radar; [CARTO](https://carto.com/basemaps) / OpenStreetMap: base map

## Put it on the phone
1. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
   (On a free plan the repo has to be public for Pages.)
2. Re-run the **Deploy to GitHub Pages** workflow from the Actions tab, or push a commit.
3. On the phone, open `https://<your-username>.github.io/weather/` in Chrome, then
   **⋮ menu → Add to Home screen / Install app**. Allow location when asked.

## Develop
No build step. Serve the folder and open it:

```sh
python3 -m http.server 8000
# http://localhost:8000
```

When you change files, bump `VERSION` in `sw.js` so phones pick up the new version.

| File | What it does |
|---|---|
| `index.html`, `css/app.css` | Layout and styles |
| `js/app.js` | Screens, places, settings, refresh logic |
| `js/api.js` | All network calls |
| `js/icons.js` | Weather descriptions and icons |
| `js/radar.js` | Radar map |
| `js/store.js` | Settings and cached forecasts in localStorage |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and install |
| `vendor/leaflet/` | Map library (Leaflet 1.9.4, BSD-2) |
