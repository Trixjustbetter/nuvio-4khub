# Nuvio Provider — 4KHDHub

On-device Nuvio provider scraping https://4khdhub.one (movies + series) via HubCloud/HubDrive.

## Files
- `providers/4khdhub.js` — the provider (Hermes-safe, no transpile needed)
- `manifest.json` — repo manifest you point Nuvio at

## Setup
1. Paste a free TMDB API key into `TMDB_API_KEY` at the top of `providers/4khdhub.js`
   (themoviedb.org -> Settings -> API). Required for `tmdbId -> title/year` lookup.
2. Local test: `node test.js` (set `TMDB_KEY` env var to also test the full getStreams path).
3. In-app testing: use Nuvio's **debug APK** -> Settings -> Plugin Tester ->
   paste the raw URL of your hosted `providers/4khdhub.js` or the code itself.

## Publishing
1. Push this folder to a GitHub repo.
2. In Nuvio: Settings -> Plugins -> Add Provider, paste:
   `https://raw.githubusercontent.com/<user>/<repo>/main/manifest.json`

## Rate limits / hosting notes
- The provider runs **on each viewer's device** — every user scrapes from their own IP,
  so there is no central bottleneck or shared rate limit.
- You only host static files (GitHub raw is fine at any small-user scale).
- Built-in TTL caches cut repeat requests per device: search 6h, detail page 20min,
  final streams 3h.
- HubCloud final URLs are signed and expire (~8h), which is why stream results are
  cached for only 3h and re-resolved after that.
- Requests are sequential and capped (max 12 items) to stay polite.

## Maintenance
- If the site domain changes, update `BASE_URL` (or call `_internal.configure({baseUrl})` in tests).
- Selectors are regex-based on current markup (`download-item`, `episode-download-item`,
  `badge-psa Episode-NN`, HubCloud `var url = '...'` hop). Update those if the site redesigns.
