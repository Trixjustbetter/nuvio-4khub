# Resolver Worker

Server-side stream resolver — this is what makes links stable. It runs the
whole 4KHDHub pipeline (TMDB lookup, site search, mirror extraction, link
validation) from Cloudflare's edge IPs instead of your device, and serves
playback through a `/play` endpoint that automatically fails over between
mirrors if one dies mid-request.

## Deploy (one time, ~5 minutes)

1. Create a free account at https://dash.cloudflare.com (Workers free tier is enough)
2. Install the CLI once:
   ```
   npm install -g wrangler
   ```
3. Log in:
   ```
   wrangler login
   ```
4. From this `worker/` folder:
   ```
   wrangler deploy
   ```
5. Note the printed URL, e.g. `https://nuvio-resolver.<yoursubdomain>.workers.dev`

Then tell me the URL — it gets baked into `RESOLVER_URL` in
`providers/4khdhub.js` and pushed. Done.

## Verify

- `https://<worker-url>/` → `{"ok":true,...}`
- `https://<worker-url>/streams?type=movie&tmdb=324786` → JSON with streams

## Notes

- Free tier: 100,000 requests/day. Each play = 2 requests (resolve + play proxy).
- The `/play` endpoint pipes video through the worker; Cloudflare does not meter
  bandwidth on Workers.
