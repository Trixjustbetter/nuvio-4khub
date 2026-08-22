// 4KHDHub resolver — Node server (deployable on Render.com free tier)
const http = require('http');

const TMDB_KEY = 'cd85a9c87eb793d68cbf5b492590e1de';
const BASE_URL = 'https://4khdhub.one';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BRAND = 'TrixPlay';
const PORT = process.env.PORT || 3000;

// Short-lived pipeline cache so /play (which follows /streams in the same UI
// flow) answers instantly instead of re-scraping while the player waits.
const resolveCache = {};
function cacheSet(k, v, ttl) { resolveCache[k] = { v: v, exp: Date.now() + ttl }; }
function cacheGet(k) {
  const e = resolveCache[k];
  if (!e || Date.now() > e.exp) { delete resolveCache[k]; return null; }
  return e.v;
}
const RESOLVE_TTL_MS = 120 * 1000;

function jres(res, obj, status) {
  res.writeHead(status || 200, Object.assign({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }));
  res.end(JSON.stringify(obj));
}

async function getText(url, referer) {
  const h = { 'User-Agent': UA };
  if (referer) h['Referer'] = referer;
  const res = await fetch(url, { headers: h });
  if (!res.ok && res.status !== 404) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function getJson(url) { return JSON.parse(await getText(url)); }

function stripTags(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, ''); }
function decodeEntities(s) {
  return String(s).replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function cleanText(s) { return decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim(); }
function normalizeTitle(t) { return String(t || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ''); }
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = [], i, j;
  for (j = 0; j <= b.length; j++) prev[j] = j;
  for (i = 1; i <= a.length; i++) {
    const curr = [i];
    for (j = 1; j <= b.length; j++) curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = curr;
  }
  return prev[b.length];
}
function titleScore(q, c) {
  const nq = normalizeTitle(q), nc = normalizeTitle(c);
  if (!nq || !nc) return 0;
  if (nq === nc) return 100;
  if (nc.indexOf(nq) === 0 || nq.indexOf(nc) === 0) return 90;
  if (nc.indexOf(nq) !== -1 || nq.indexOf(nc) !== -1) return 80;
  const ratio = 1 - levenshtein(nq, nc) / Math.max(nq.length, nc.length);
  return ratio >= 0.65 ? Math.round(ratio * 70) : 0;
}
function tierOf(t) {
  if (/2160p|\b4k\b|uhd/i.test(t)) return '4K';
  if (/1080p/i.test(t)) return '1080p';
  if (/720p/i.test(t)) return '720p';
  if (/480p/i.test(t)) return '480p';
  return '';
}
function prettyTags(text) {
  const t = String(text || '').toUpperCase();
  const tags = [];
  if (/REMUX/.test(t)) tags.push('REMUX'); else if (/WEB[\s-]?DL/.test(t)) tags.push('WEB-DL'); else if (/BLU-?RAY|BDRIP/.test(t)) tags.push('BluRay');
  if (/DOLBY.?VISION|\bDV\b|DOVI/.test(t)) tags.push('DV');
  if (/HDR10\+/.test(t)) tags.push('HDR10+'); else if (/\bHDR\b/.test(t)) tags.push('HDR');
  if (/\bAV1\b/.test(t)) tags.push('AV1'); else if (/HEVC|H\.?265/.test(t)) tags.push('HEVC'); else if (/X264|AVC|H\.?264\b/.test(t)) tags.push('x264');
  return tags.join(' ');
}
function detectLanguages(text) {
  const t = String(text || '').toUpperCase();
  const known = ['ENGLISH', 'HINDI', 'TAMIL', 'TELUGU', 'MALAYALAM', 'JAPANESE', 'SPANISH', 'FRENCH', 'GERMAN', 'ITALIAN'];
  const langs = known.filter(k => t.indexOf(k) !== -1);
  if (!langs.length) return '';
  langs.sort((a, b) => (a === 'ENGLISH' ? -1 : 0) - (b === 'ENGLISH' ? -1 : 0));
  return langs.map(k => k.charAt(0) + k.slice(1).toLowerCase()).join(' / ');
}

async function getMeta(imdb, tmdb, type) {
  const t = type === 'tv' ? 'tv' : 'movie';
  if (imdb && /^tt\d+$/i.test(imdb)) {
    const d = await getJson(`https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB_KEY}&external_source=imdb_id`);
    let bucket = d[t + '_results'] || [];
    if (!bucket.length) bucket = d.movie_results || d.tv_results || [];
    if (!bucket.length) throw new Error('find failed');
    const b = bucket[0];
    return { title: b.title || b.name, year: parseInt((b.release_date || b.first_air_date || '').slice(0, 4)) || 0, tmdbId: String(b.id), imdbId: imdb };
  }
  const d = await getJson(`https://api.themoviedb.org/3/${t}/${tmdb}?api_key=${TMDB_KEY}&append_to_response=external_ids`);
  return { title: d.title || d.name, year: parseInt((d.release_date || d.first_air_date || '').slice(0, 4)) || 0, tmdbId: String(d.id), imdbId: (d.external_ids && d.external_ids.imdb_id) || '' };
}

function parseCards(html) {
  const cards = [], positions = [], re = /<a\s+href="([^"]+)"\s+class="movie-card"/g;
  let m;
  while ((m = re.exec(html)) !== null) positions.push({ index: m.index, href: m[1] });
  for (let i = 0; i < positions.length; i++) {
    const chunk = html.substring(positions[i].index, i + 1 < positions.length ? positions[i + 1].index : Math.min(html.length, positions[i].index + 6000));
    const tm = /class="movie-card-title">\s*([\s\S]*?)\s*<\/h3>/i.exec(chunk);
    const mm = /class="movie-card-meta">\s*([\s\S]*?)\s*<\/p>/i.exec(chunk);
    if (!tm || !mm) continue;
    const ym = /(\d{4})/.exec(cleanText(mm[1]).slice(0, 12));
    const slug = /(movie|series)-\d+/.exec(positions[i].href);
    cards.push({ url: BASE_URL + positions[i].href, title: cleanText(tm[1]), year: ym ? parseInt(ym[1]) : 0, isSeries: slug ? slug[1] === 'series' : false });
  }
  return cards;
}

function classifyLinks(chunk) {
  const links = [], re = /href="(https?:\/\/[^"]+)"/g;
  let m;
  while ((m = re.exec(chunk)) !== null) {
    const href = m[1];
    if (/4khdhub\.one|image\.tmdb|googletagmanager|fonts\./i.test(href)) continue;
    links.push(href);
  }
  return [...new Set(links)];
}

function parseDownloadItems(html) {
  const items = [], marker = '<div class="download-item';
  const positions = [];
  let idx = html.indexOf(marker);
  while (idx !== -1) { positions.push(idx); idx = html.indexOf(marker, idx + marker.length); }
  for (let i = 0; i < positions.length; i++) {
    const chunk = html.substring(positions[i], i + 1 < positions.length ? positions[i + 1] : html.length);
    const hm = /font-semibold">\s*([\s\S]*?)\s*<br>/i.exec(chunk);
    const fm = /class="file-title">\s*([\s\S]*?)\s*<\/div>/i.exec(chunk);
    const sm = /<code>\s*<span class="badge"[^>]*>\s*([\d.,]+\s*[KMGT]?B)\s*</i.exec(chunk);
    if (!hm && !fm) continue;
    const fileName = fm ? cleanText(fm[1]) : cleanText(hm[1]);
    if (/\.zip\b/i.test(fileName)) continue;
    const links = classifyLinks(chunk);
    if (!links.length) continue;
    items.push({ label: hm ? cleanText(hm[1]) : '', fileName, size: sm ? cleanText(sm[1]) : '', links });
  }
  return items;
}

function parseEpisodes(html, season, episode) {
  const startIdx = html.indexOf('id="episodes"');
  if (startIdx === -1) return [];
  const region = html.slice(startIdx);
  const marker = '<div class="episode-download-item';
  const positions = [];
  let idx = region.indexOf(marker);
  while (idx !== -1) { positions.push(idx); idx = region.indexOf(marker, idx + marker.length); }

  const items = [];
  for (let i = 0; i < positions.length; i++) {
    const contextBefore = region.slice(Math.max(0, positions[i] - 3000), positions[i]);
    const chunk = region.substring(positions[i], i + 1 < positions.length ? positions[i + 1] : region.length);
    let itemSeason = 0;
    const sms = contextBefore.match(/class="episode-number"[^>]*>\s*S?(\d{1,2})\s*</g);
    if (sms && sms.length) {
      const lm = /(\d{1,2})\s*</.exec(sms[sms.length - 1]);
      if (lm) itemSeason = parseInt(lm[1]);
    }
    const em = /class="badge-psa"\s*>\s*Episode-(\d{1,3})\s*</i.exec(chunk);
    let itemEpisode = em ? parseInt(em[1]) : 0;
    const fm = /class="episode-file-title">\s*([\s\S]*?)\s*<\/div>/i.exec(chunk);
    const fileName = fm ? cleanText(fm[1]) : '';
    const fe = /S(\d{1,2})E(\d{1,3})/i.exec(fileName);
    if (fe) { itemSeason = parseInt(fe[1]); itemEpisode = parseInt(fe[2]); }
    const sm = /class="badge-size"[^>]*>\s*([^<]+?)\s*</i.exec(chunk);
    const links = classifyLinks(chunk);
    if (!links.length) continue;
    items.push({ label: fileName, fileName, season: itemSeason, episode: itemEpisode, size: sm ? cleanText(sm[1]) : '', links });
  }
  return items.filter(it => it.season === Number(season) && it.episode === Number(episode));
}

const AD_RE = /winexch|tinyurl|t\.me|telegram|adsboosters|cloudflareinsights|googletagmanager|doubleclick|google-analytics/i;

async function resolveMirrorChain(mirrorUrl) {
  const page = await getText(mirrorUrl, BASE_URL);
  const um = /var\s+url\s*=\s*'([^']+)'/i.exec(page);
  const finalPage = um ? await getText(um[1], mirrorUrl) : page;
  const links = [], re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/gi;
  let m;
  while ((m = re.exec(finalPage)) !== null) {
    const href = m[1];
    if (AD_RE.test(href)) continue;
    if (/gpdl\.|10gbps/i.test(href + finalPage.slice(m.index, m.index + 300))) continue;
    const ctx = finalPage.slice(m.index, m.index + 500);
    if (/r2\.cloudflarestorage\.com/i.test(href) || /fsl/i.test(ctx) || /download[- ]?file/i.test(ctx)) links.push(href);
    else {
      const pd = /pixeldrain\.(?:com|dev)\/u\/([A-Za-z0-9]+)/i.exec(href);
      if (pd) links.push('https://pixeldrain.com/api/file/' + pd[1] + '?download');
    }
  }
  return { links: [...new Set(links)], size: '' };
}

function rank(url) {
  if (/r2\.cloudflarestorage/i.test(url)) return 0;
  if (/pixeldrain/i.test(url)) return 2;
  return 1;
}

async function isPlayable(url, referer) {
  try {
    const h = { 'User-Agent': UA, Range: 'bytes=0-1023' };
    if (referer) h['Referer'] = referer;
    const res = await fetch(url, { headers: h });
    const ct = res.headers.get('content-type') || '';
    return res.status >= 200 && res.status < 400 && !/text\/html/i.test(ct);
  } catch (e) { return false; }
}

function container(f) {
  const m = /\.(mkv|mp4|avi)\b/i.exec(String(f || ''));
  return m ? m[1].toUpperCase() : '';
}

// Re-resolve the title live and return validated stream entries (with candidates).
// Used by both /streams (listing) and /play (fresh-at-play-time resolution).
async function collectStreams(params) {
  const type = params.get('type') === 'tv' ? 'tv' : 'movie';
  const imdb = params.get('imdb') || '';
  const tmdb = params.get('tmdb') || '';
  const season = parseInt(params.get('s') || '0');
  const episode = parseInt(params.get('e') || '0');

  const cacheKey = 'cs_' + type + '_' + imdb + '_' + tmdb + '_' + season + '_' + episode;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const meta = await getMeta(imdb, tmdb, type);
  const cards = parseCards(await getText(BASE_URL + '/?s=' + encodeURIComponent(meta.title)));

  let best = null, bestScore = 0;
  const wantSeries = type === 'tv';
  for (const c of cards) {
    if (c.isSeries !== wantSeries) continue;
    let score = titleScore(meta.title, c.title);
    if (meta.year && c.year && Math.abs(c.year - meta.year) > 1) score -= 50;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (!best) {
    const out = { streams: [], note: 'no site match', meta };
    cacheSet(cacheKey, out, 30 * 1000);
    return out;
  }

  const html = await getText(best.url);
  const items = wantSeries ? parseEpisodes(html, season, episode) : parseDownloadItems(html);
  const limited = items.slice(0, 6);

  const streams = [];
  for (const item of limited) {
    let candidates = [];
    for (const link of item.links) {
      try {
        if (/hubdrive\./i.test(link)) {
          const hp = await getText(link, BASE_URL);
          const nested = /href="(https?:\/\/[^"]*hubcloud[^"]*)"/i.exec(hp);
          if (!nested) continue;
          const r = await resolveMirrorChain(nested[1]);
          candidates.push(...r.links);
        } else if (/hubcloud\./i.test(link)) {
          const r = await resolveMirrorChain(link);
          candidates.push(...r.links);
        } else if (/pixeldrain\.com\/u\//i.test(link)) {
          const id = link.match(/u\/([A-Za-z0-9]+)/)[1];
          candidates.push('https://pixeldrain.com/api/file/' + id + '?download');
        }
      } catch (e) { /* skip */ }
    }
    candidates = [...new Set(candidates)].sort((a, b) => rank(a) - rank(b));

    // NOTE: no pre-validation here — every probe request burns these mirrors'
    // tiny per-file quotas before the actual play. /play proxies candidates
    // directly instead; its attempt IS the validity check.
    if (!candidates.length) continue;

    const tier = tierOf(item.label + ' ' + item.fileName) || 'HD';
    streams.push({
      name: `${BRAND} #${streams.length + 1} - ${tier} - 4KHDHub`,
      title: [meta.title + (wantSeries ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : ''), container(item.fileName), prettyTags(item.label + ' ' + item.fileName), detectLanguages(item.fileName)].filter(Boolean).join(' - ') + (item.size ? ' - ' + item.size : ''),
      url: candidates[0],
      quality: tier,
      candidates: candidates.slice(0, 5),
      referer: best.url
    });
  }
  const out = { streams, meta };
  cacheSet(cacheKey, out, RESOLVE_TTL_MS);
  return out;
}

async function handleStreams(params) {
  return collectStreams(params);
}

// /play — proxy candidates directly at play-time (no quota-burning probes).
// The proxy attempt itself is the validity check: video pipes through,
// 403/HTML candidates are skipped for the next one.
async function handlePlay(res, params, rangeHeader) {
  const idx = parseInt(params.get('idx') || '0');
  const { streams } = await collectStreams(params);
  const entry = streams[idx];
  if (!entry) return jres(res, { error: 'no such stream at play-time' }, 404);

  const referer = entry.referer;
  const tryUrls = [entry.url, ...entry.candidates.filter(c => c !== entry.url)];

  for (const url of tryUrls) {
    try {
      const h = { 'User-Agent': UA };
      if (referer) h['Referer'] = referer;
      if (rangeHeader) h['Range'] = rangeHeader;
      const upstream = await fetch(url, { headers: h });
      const ct = upstream.headers.get('content-type') || '';
      if (upstream.status >= 400 || /text\/html/i.test(ct)) {
        console.log('[play] skip', upstream.status, ct.slice(0, 30), url.slice(0, 70));
        continue;
      }

      const headers = {};
      ['content-type', 'content-length', 'content-disposition', 'accept-ranges', 'content-range'].forEach(hh => {
        const v = upstream.headers.get(hh);
        if (v) headers[hh] = v;
      });
      headers['Access-Control-Allow-Origin'] = '*';
      res.writeHead(upstream.status, headers);
      const { Readable } = require('stream');
      Readable.fromWeb(upstream.body).pipe(res);
      return;
    } catch (e) { /* try next candidate */ }
  }
  jres(res, { error: 'all mirrors dead at play time' }, 502);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.searchParams;
  try {
    if (url.pathname === '/streams') {
      const out = await handleStreams(p);
      jres(res, out);
    } else if (url.pathname === '/play') {
      await handlePlay(res, p, req.headers['range']);
    } else if (url.pathname === '/') {
      jres(res, { ok: true, endpoints: ['/streams', '/play'] });
    } else {
      jres(res, { error: 'not found' }, 404);
    }
  } catch (e) {
    jres(res, { error: String(e && e.message || e) }, 500);
  }
});

server.listen(PORT, () => console.log('resolver listening on :' + PORT));
