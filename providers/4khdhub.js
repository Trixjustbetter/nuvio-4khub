/*
 * Nuvio Provider — 4KHDHub (4khdhub.one)
 * Scrapes movie/series pages, resolves HubCloud/HubDrive links to direct URLs.
 * Written in ES2016 style (promise chains, no async/await) so it runs in the
 * Hermes sandbox WITHOUT needing the build/transpile step.
 *
 * Setup: paste a free TMDB v3 API key below (themoviedb.org -> Settings -> API).
 */
(function () {
  'use strict';

  // ------------------------- configuration -------------------------
  var BASE_URL = 'https://4khdhub.one';
  var TMDB_API_KEY = 'cd85a9c87eb793d68cbf5b492590e1de';

  var BRAND = 'TrixPlay';      // shown on every stream card
  var BRAND_ICON = '\uD83C\uDFAC'; // 🎬

  // Optional self-hosted resolver (Cloudflare Worker). When set, resolving and
  // mirror failover happen server-side with a fresh IP — far more stable than
  // client-side scraping. Deploy: see /worker/README.md, then paste your URL.
  var RESOLVER_URL = 'https://nuvio-4khub.onrender.com';

  var MAX_ITEMS_PER_REQUEST = 12;
  var SEARCH_TTL_MS = 6 * 60 * 60 * 1000;
  var DETAIL_TTL_MS = 20 * 60 * 1000;
  var STREAMS_TTL_MS = 3 * 60 * 60 * 1000;

  var DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  // ------------------------- small utils -------------------------
  function log() {
    var args = ['[4KHDHub]'].concat(Array.prototype.slice.call(arguments));
    console.log.apply(console, args);
  }

  // NOTE: the Nuvio JS sandbox provides fetch/console/module but NO setTimeout,
  // so we must not use timers anywhere in this file.
  function httpGet(url, referer, asJson) {
    var headers = Object.assign({}, DEFAULT_HEADERS);
    if (referer) headers['Referer'] = referer;
    if (asJson) headers['Accept'] = 'application/json';
    return fetch(url, { method: 'GET', headers: headers }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return asJson ? res.text().then(JSON.parse) : res.text();
    });
  }

  function stripTags(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, ''); }

  function decodeEntities(s) {
    return String(s)
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function cleanText(s) { return decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim(); }

  function normalizeTitle(t) {
    return String(t || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length || !b.length) return Math.max(a.length, b.length);
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var curr = [i];
      for (j = 1; j <= b.length; j++) {
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = curr;
    }
    return prev[b.length];
  }

  function titleScore(query, candidate) {
    var q = normalizeTitle(query), c = normalizeTitle(candidate);
    if (!q || !c) return 0;
    if (q === c) return 100;
    if (c.indexOf(q) === 0 || q.indexOf(c) === 0) return 90;
    if (c.indexOf(q) !== -1 || q.indexOf(c) !== -1) return 80;
    var dist = levenshtein(q, c);
    var ratio = 1 - dist / Math.max(q.length, c.length);
    return ratio >= 0.65 ? Math.round(ratio * 70) : 0;
  }

  function detectQuality(text) {
    var t = String(text || '');
    if (/2160p|\b4k\b|uhd/i.test(t)) return '4K';
    if (/1080p/i.test(t)) return '1080p';
    if (/720p/i.test(t)) return '720p';
    if (/480p/i.test(t)) return '480p';
    return '';
  }

  function qualityRank(q) {
    switch (q) {
      case '4K': return 0;
      case '1080p': return 1;
      case '720p': return 2;
      case '480p': return 3;
      default: return 9;
    }
  }

  function sizeToBytes(text) {
    var m = /([\d.]+)\s*(GB|MB|TB)/i.exec(String(text || ''));
    if (!m) return 0;
    var n = parseFloat(m[1]);
    if (/TB/i.test(m[2])) return n * 1024 * 1024 * 1024 * 1024;
    if (/GB/i.test(m[2])) return n * 1024 * 1024 * 1024;
    return n * 1024 * 1024;
  }

  function tierOf(text) {
    var t = String(text || '');
    if (/2160p|\b4k\b|uhd/i.test(t)) return '2160p';
    if (/1080p/i.test(t)) return '1080p';
    if (/720p/i.test(t)) return '720p';
    if (/480p/i.test(t)) return '480p';
    return '';
  }

  function prettyTags(text) {
    var t = String(text || '').toUpperCase();
    var tags = [];
    if (/REMUX/.test(t)) tags.push('REMUX');
    else if (/WEB[\s-]?DL/.test(t)) tags.push('WEB-DL');
    else if (/BLU-?RAY|BDRIP/.test(t)) tags.push('BluRay');
    if (/DOLBY.?VISION|\bDV\b|DOVI/.test(t)) tags.push('DV');
    if (/HDR10\+/.test(t)) tags.push('HDR10+');
    else if (/\bHDR\b/.test(t)) tags.push('HDR');
    if (/\bAV1\b/.test(t)) tags.push('AV1');
    else if (/HEVC|H\.?265/.test(t)) tags.push('HEVC');
    else if (/X264|AVC|H\.?264\b/.test(t)) tags.push('x264');
    return tags.join(' \u00b7 ');
  }

  function detectLanguages(text) {
    var t = String(text || '').toUpperCase();
    var langs = [];
    var known = ['ENGLISH', 'HINDI', 'TAMIL', 'TELUGU', 'MALAYALAM', 'JAPANESE', 'SPANISH', 'FRENCH', 'GERMAN', 'ITALIAN'];
    known.forEach(function (k) {
      if (t.indexOf(k) !== -1 && langs.indexOf(k) === -1) langs.push(k);
    });
    if (!langs.length && /DUAL|MULTI/.test(t)) return 'Multi';
    // English first — most releases here are dual audio with an English track
    langs.sort(function (a, b) { return (a === 'ENGLISH' ? -1 : 0) - (b === 'ENGLISH' ? -1 : 0); });
    return langs.map(function (k) { return k.charAt(0) + k.slice(1).toLowerCase(); }).join(' / ');
  }

  // One stream per resolution tier: prefer REMUX, then bigger size.
  function dedupeItems(items) {
    var best = {};
    items.forEach(function (it) {
      var tier = tierOf(it.label + ' ' + it.fileName);
      if (!tier) return;
      var cur = best[tier];
      if (!cur) { best[tier] = it; return; }
      var remuxNew = /REMUX/i.test(it.fileName) || /REMUX/i.test(it.label) ? 1 : 0;
      var remuxCur = /REMUX/i.test(cur.fileName) || /REMUX/i.test(cur.label) ? 1 : 0;
      if (remuxNew > remuxCur ||
          (remuxNew === remuxCur && sizeToBytes(it.size) > sizeToBytes(cur.size))) {
        best[tier] = it;
      }
    });
    var order = ['2160p', '1080p', '720p', '480p'];
    var out = [];
    order.forEach(function (t) { if (best[t]) out.push(best[t]); });
    return out;
  }

  // ------------------------- ttl cache -------------------------
  var cacheStore = {};
  function cacheSet(key, value, ttlMs) { cacheStore[key] = { v: value, exp: Date.now() + ttlMs }; }
  function cacheGet(key) {
    var e = cacheStore[key];
    if (!e) return null;
    if (Date.now() > e.exp) { delete cacheStore[key]; return null; }
    return e.v;
  }

  // ------------------------- tmdb -------------------------
  function getTmdbDetails(tmdbId, mediaType) {
    if (!TMDB_API_KEY) {
      return Promise.reject(new Error('TMDB_API_KEY is empty — paste your free key at the top of providers/4khdhub.js'));
    }
    var t = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
    var idStr = String(tmdbId || '').trim();
    var cacheKey = 'tmdb_' + t + '_' + idStr;
    var cached = cacheGet(cacheKey);
    if (cached) return Promise.resolve(cached);

    var toMeta = function (data) {
      var dateStr = data.release_date || data.first_air_date || '';
      var meta = {
        title: data.title || data.name || '',
        year: parseInt(dateStr.substring(0, 4), 10) || 0,
        tmdbId: String(data.id || ''),
        imdbId: ''
      };
      if (!meta.title) throw new Error('TMDB lookup returned no title for id ' + tmdbId);
      cacheSet(cacheKey, meta, 24 * 60 * 60 * 1000);
      return meta;
    };

    // NOTE: Nuvio passes IMDb ids ("tt1234567"), not TMDB numbers — resolve
    // them through the /find endpoint before doing anything else.
    if (/^tt\d+$/i.test(idStr)) {
      var findUrl = 'https://api.themoviedb.org/3/find/' + idStr +
                    '?api_key=' + TMDB_API_KEY + '&external_source=imdb_id';
      return httpGet(findUrl, null, true).then(function (res) {
        var bucket = res[t + '_results'] || [];
        if (!bucket.length) bucket = res.movie_results || res.tv_results || [];
        if (!bucket.length) throw new Error('TMDB find failed for IMDb id ' + idStr);
        var meta = toMeta(bucket[0]);
        meta.imdbId = idStr;
        return meta;
      });
    }

    var url = 'https://api.themoviedb.org/3/' + t + '/' + idStr +
              '?api_key=' + TMDB_API_KEY + '&append_to_response=external_ids';
    return httpGet(url, null, true).then(function (data) {
      var meta = toMeta(data);
      meta.imdbId = (data.external_ids && data.external_ids.imdb_id) || '';
      return meta;
    });
  }

  // ------------------------- search -------------------------
  function parseCards(html) {
    var cards = [];
    var positions = [];
    var re = /<a\s+href="([^"]+)"\s+class="movie-card"/g;
    var m;
    while ((m = re.exec(html)) !== null) positions.push({ index: m.index, href: m[1] });
    for (var i = 0; i < positions.length; i++) {
      var start = positions[i].index;
      var end = i + 1 < positions.length ? positions[i + 1].index : Math.min(html.length, start + 6000);
      var chunk = html.substring(start, end);

      var tm = /class="movie-card-title">\s*([\s\S]*?)\s*<\/h3>/i.exec(chunk);
      var mm = /class="movie-card-meta">\s*([\s\S]*?)\s*<\/p>/i.exec(chunk);
      if (!tm || !mm) continue;

      var title = cleanText(tm[1]);
      var metaRaw = mm[1];
      var ym = /(\d{4})/.exec(cleanText(metaRaw).slice(0, 12));
      var year = ym ? parseInt(ym[1], 10) : 0;

      var isSeries;
      var slugMatch = /(movie|series)-\d+/.exec(positions[i].href);
      if (slugMatch) isSeries = slugMatch[1] === 'series';

      cards.push({ url: positionHref(positions[i].href), title: title, year: year, isSeries: !!isSeries });
    }
    return cards;
  }

  function positionHref(href) {
    if (/^https?:\/\//i.test(href)) return href;
    return BASE_URL + (href.charAt(0) === '/' ? '' : '/') + href;
  }

  function searchSite(query, mediaType) {
    var wantSeries = mediaType === 'tv' || mediaType === 'series';
    var cacheKey = 'search_' + wantSeries + '_' + normalizeTitle(query);
    var cached = cacheGet(cacheKey);
    if (cached) return Promise.resolve(cached);

    var attempt = function (q) {
      return httpGet(BASE_URL + '/?s=' + encodeURIComponent(q)).then(parseCards);
    };
    return attempt(query).catch(function () { return []; }).then(function (results) {
      var filtered = results.filter(function (c) { return c.isSeries === wantSeries; });
      cacheSet(cacheKey, filtered, SEARCH_TTL_MS);
      return filtered;
    });
  }

  function findBestCard(cards, title, year) {
    var best = null, bestScore = 0;
    cards.forEach(function (c) {
      var score = titleScore(title, c.title);
      if (year && c.year && Math.abs(c.year - year) > 1) score -= 50;
      if (score > bestScore) { bestScore = score; best = c; }
    });
    return bestScore >= 40 ? best : (bestScore > 0 ? best : null);
  }

  // ------------------------- detail page parsing -------------------------
  function classifyLinks(chunk) {
    var links = { hubcloud: null, hubdrive: null, other: [] };
    var re = /href="(https?:\/\/[^"]+)"/g;
    var m;
    while ((m = re.exec(chunk)) !== null) {
      var href = m[1];
      if (/4khdhub\.one|image\.tmdb|googletagmanager|fonts\./i.test(href)) continue;
      if (/hubcloud\./i.test(href)) { if (!links.hubcloud) links.hubcloud = href; }
      else if (/hubdrive\./i.test(href)) { if (!links.hubdrive) links.hubdrive = href; }
      else if (/pixeldrain\.com\/u\//i.test(href)) { links.other.push(href); }
    }
    return links;
  }

  function parseDownloadItems(html) {
    var items = [];
    var marker = '<div class="download-item';
    var positions = [];
    var idx = html.indexOf(marker);
    while (idx !== -1) { positions.push(idx); idx = html.indexOf(marker, idx + marker.length); }
    for (var i = 0; i < positions.length; i++) {
      var chunk = html.substring(positions[i], i + 1 < positions.length ? positions[i + 1] : html.length);
      var hm = /font-semibold">\s*([\s\S]*?)\s*<br>/i.exec(chunk);
      var fm = /class="file-title">\s*([\s\S]*?)\s*<\/div>/i.exec(chunk);
      var sm = /<code>\s*<span class="badge"[^>]*>\s*([\d.,]+\s*[KMGT]?B)\s*</i.exec(chunk);
      if (!hm && !fm) continue;
      var headerText = hm ? cleanText(hm[1]) : '';
      var fileName = fm ? cleanText(fm[1]) : headerText;
      if (/\.zip\b/i.test(fileName)) continue;
      var links = classifyLinks(chunk);
      if (!links.hubcloud && !links.hubdrive && links.other.length === 0) continue;
      items.push({
        label: headerText,
        fileName: fileName,
        size: sm ? cleanText(sm[1]) : '',
        links: links
      });
    }
    return items;
  }

  function parseEpisodes(html, season, episode) {
    var startIdx = html.indexOf('id="episodes"');
    if (startIdx === -1) return [];
    var region = html.slice(startIdx);

    var items = [];
    var itemMarker = '<div class="episode-download-item';
    var positions = [];
    var idx = region.indexOf(itemMarker);
    while (idx !== -1) { positions.push(idx); idx = region.indexOf(itemMarker, idx + itemMarker.length); }

    for (var i = 0; i < positions.length; i++) {
      var backStart = Math.max(0, positions[i] - 3000);
      var contextBefore = region.slice(backStart, positions[i]);
      var chunk = region.substring(positions[i], i + 1 < positions.length ? positions[i + 1] : region.length + positions[i]);

      var seasonMatches = contextBefore.match(/class="episode-number"[^>]*>\s*S?(\d{1,2})\s*</g);
      var itemSeason = 0;
      if (seasonMatches && seasonMatches.length) {
        var lastM = /(\d{1,2})\s*</.exec(seasonMatches[seasonMatches.length - 1]);
        if (lastM) itemSeason = parseInt(lastM[1], 10);
      }

      var em = /class="badge-psa"\s*>\s*Episode-(\d{1,3})\s*</i.exec(chunk);
      var itemEpisode = em ? parseInt(em[1], 10) : 0;

      var fm = /class="episode-file-title">\s*([\s\S]*?)\s*<\/div>/i.exec(chunk);
      var fileName = fm ? cleanText(fm[1]) : '';

      var feMatch = /S(\d{1,2})E(\d{1,3})/i.exec(fileName);
      if (feMatch) {
        itemSeason = parseInt(feMatch[1], 10);
        itemEpisode = parseInt(feMatch[2], 10);
      }

      var sm = /class="badge-size"[^>]*>\s*([^<]+?)\s*</i.exec(chunk);
      var links = classifyLinks(chunk);
      if (!links.hubcloud && !links.hubdrive && links.other.length === 0) continue;

      items.push({
        label: fileName,
        fileName: fileName,
        season: itemSeason,
        episode: itemEpisode,
        size: sm ? cleanText(sm[1]) : '',
        links: links
      });
    }

    return items.filter(function (it) {
      return it.season === Number(season) && it.episode === Number(episode);
    });
  }

  // ------------------------- link resolvers -------------------------
  var AD_HOST_RE = /winexch|tinyurl|t\.me|telegram|adsboosters|cloudflareinsights|googletagmanager|doubleclick|google-analytics/i;

  function resolveHubCloud(driveUrl) {
    return httpGet(driveUrl, BASE_URL).then(function (page) {
      var um = /var\s+url\s*=\s*'([^']+)'/i.exec(page);
      var fetchFinal = um ? httpGet(um[1], driveUrl) : Promise.resolve(page);
      return fetchFinal.then(function (finalPage) {
        var links = [];
        var re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/gi;
        var m;
        while ((m = re.exec(finalPage)) !== null) {
          var href = m[1];
          if (AD_HOST_RE.test(href)) continue;
          var ctx = finalPage.slice(m.index, m.index + 500);
          var pdId;
          if (/r2\.cloudflarestorage\.com/i.test(href) || /fsl/i.test(ctx) || /download[- ]?file/i.test(ctx)) {
            links.push(href);
          } else if ((pdId = /pixeldrain\.(?:com|dev)\/u\/([A-Za-z0-9]+)/i.exec(href))) {
            // PixelServer button — rewrite the viewer link into a direct file URL
            links.push('https://pixeldrain.com/api/file/' + pdId[1] + '?download');
          }
          // NOTE: 'Server : 10Gbps' gpdl.* gateways return 500s — deliberately skipped
        }
        var unique = [];
        links.forEach(function (l) { if (unique.indexOf(l) === -1) unique.push(l); });
        var szm = /id="size"[^>]*>\s*([^<]+?)\s*</i.exec(finalPage);
        return { links: unique, size: szm ? cleanText(szm[1]) : '' };
      });
    });
  }

  function resolveHubDrive(fileUrl) {
    return httpGet(fileUrl, BASE_URL).then(function (page) {
      var m = /href="(https?:\/\/[^"]*hubcloud[^"]*)"/i.exec(page);
      if (!m) throw new Error('no nested hubcloud link on hubdrive page');
      return resolveHubCloud(m[1], fileUrl);
    });
  }

  function hostLabel(url) {
    if (/r2\.cloudflarestorage\.com/i.test(url)) return 'R2';
    if (/pixeldrain\.com/i.test(url)) return 'PixelDrain';
    if (/workers\.dev\//i.test(url)) return 'Stream';
    if (/hubdrive\./i.test(url)) return 'HubDrive';
    if (/hubcloud\./i.test(url)) return 'HubCloud';
    return 'Direct';
  }

  function containerTag(fileName) {
    var m = /\.(mkv|mp4|avi|mpeg|mov|webm)\b/i.exec(String(fileName || ''));
    return m ? m[1].toUpperCase() : '';
  }

  function pad2(n) { n = Number(n); return (n < 10 ? '0' : '') + n; }

  // Range-fetch a candidate and require an actual video/file response —
  // workers.dev hosts return quota 403s and PixelServer mirrors 404 dead ids.
  function isPlayable(url, referer) {
    var headers = { 'User-Agent': DEFAULT_HEADERS['User-Agent'], Range: 'bytes=0-1023' };
    if (referer) headers['Referer'] = referer;
    return fetch(url, { method: 'GET', headers: headers }).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var ok = res.status >= 200 && res.status < 400 && !/text\/html/i.test(ct);
      log('validate ' + (ok ? 'OK' : 'DEAD') + ' ' + res.status + ' ' + ct.slice(0, 30) + ' ' + url.slice(0, 70));
      return ok;
    }).catch(function (e) {
      log('validate error:', e && e.message);
      return false;
    });
  }

  function pickPlayable(links, referer) {
    var candidates = links.slice(0, 4);
    return candidates.reduce(function (chain, link) {
      return chain.then(function (found) {
        if (found) return found;
        return isPlayable(link, referer).then(function (ok) { return ok ? link : null; });
      });
    }, Promise.resolve(null));
  }

  function resolveItem(item, index, total, mediaTitle, season, episode) {
    log('resolving ' + (index + 1) + '/' + total + ': ' + (item.fileName || item.label));
    var useHubCloud = !!item.links.hubcloud;
    var job = useHubCloud
      ? resolveHubCloud(item.links.hubcloud)
      : (item.links.hubdrive ? resolveHubDrive(item.links.hubdrive) : Promise.resolve(null));

    return job.catch(function (e) {
      log('resolver failed:', e && e.message);
      return null;
    }).then(function (res) {
      // Harvest final links from BOTH mirrors — each dies independently.
      var jobs = [Promise.resolve((res && res.links) || [])];
      if (item.links.hubdrive) {
        jobs.push(resolveHubDrive(item.links.hubdrive).then(function (r) { return r.links; }).catch(function () { return []; }));
      }

      return Promise.all(jobs).then(function (lists) {
        var seen = [], merged = [];
        lists.forEach(function (list) {
          (list || []).forEach(function (l) {
            if (seen.indexOf(l) === -1) { seen.push(l); merged.push(l); }
          });
        });
        log('merged candidates: ' + merged.length);
        return pickPlayable(merged, useHubCloud ? item.links.hubcloud : BASE_URL).then(function (u) {
          return buildStream(u, res);
        });
      });

      function buildStream(url, r) {
        if (!url) { log('no playable link for item, dropping'); return null; }
        var tier = tierOf(item.label + ' ' + item.fileName);
        var tierLabel = tier === '2160p' ? '4K' : (tier || 'HD');
        var tags = prettyTags(item.label + ' ' + item.fileName);
        var lang = detectLanguages(item.fileName + ' ' + item.label);
        var base = String(mediaTitle || '').replace(/\s+/g, ' ').trim() || BRAND;
        var epTag = (season && episode) ? ' S' + pad2(season) + 'E' + pad2(episode) : '';
        var container = containerTag(item.fileName);

        var detailParts = [];
        detailParts.push(base + epTag);
        if (container) detailParts.push(container);
        if (tags) detailParts.push(tags);
        if (lang) detailParts.push(lang);
        if (item.size || (r && r.size)) detailParts.push(item.size || r.size);

        return {
          name: BRAND + ' #' + (index + 1) + ' - ' + tierLabel +
                ' - 4KHDHub - ' + hostLabel(url),
          title: detailParts.join(' - ') || tierLabel,
          url: url,
          quality: tierLabel,
          headers: {
            'User-Agent': DEFAULT_HEADERS['User-Agent'],
            'Referer': BASE_URL
          }
        };
      }
    });
  }

  function resolveItemsSequential(items, mediaTitle, season, episode) {
    var limited = items.slice(0, MAX_ITEMS_PER_REQUEST);
    return limited.reduce(function (chain, item, i) {
      return chain.then(function (acc) {
        return resolveItem(item, i, limited.length, mediaTitle, season, episode).then(function (stream) {
          if (stream) acc.push(stream);
          return acc;
        });
      });
    }, Promise.resolve([]));
  }

  // ------------------------- videasy fallback -------------------------
  var VIDEASY_SERVERS = [
    { name: 'Yoru',   path: 'cdn',               moviesOnly: true },
    { name: 'Neon',   path: 'myflixerzupcloud' },
    { name: 'Sage',   path: '1movies' },
    { name: 'Cypher', path: 'moviebox' },
    { name: 'Ghost',  path: 'primesrcme' },
    { name: 'Vyse',   path: 'hdmovie' },
    { name: 'Fade',   path: 'hdmovie', lang: 'hindi' },
    { name: 'Omen',   path: 'onionplay' }
  ];

  function postJson(url, bodyObj) {
    return fetch(url, {
      method: 'POST',
      headers: Object.assign({}, DEFAULT_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(bodyObj)
    }).then(function (res) { return res.text(); }).then(function (t) { return JSON.parse(t); });
  }

  function qualityFromUrl(url) {
    var m = /(\d{3,4})p/i.exec(String(url));
    if (m) return m[1] + 'p';
    if (/1080|1920/.test(url)) return '1080p';
    if (/720|1280/.test(url)) return '720p';
    if (/480|854/.test(url)) return '480p';
    return '';
  }

  function fetchVideasyServer(srv, meta, mediaType, season, episode) {
    if (mediaType === 'tv' && srv.moviesOnly) return Promise.resolve([]);
    var doubleTitle = encodeURIComponent(encodeURIComponent(meta.title).replace(/\+/g, '%20'));
    var params = {
      title: doubleTitle,
      mediaType: mediaType,
      year: meta.year,
      tmdbId: meta.tmdbId,
      imdbId: meta.imdbId
    };
    if (srv.lang) params.language = srv.lang;
    if (mediaType === 'tv' && season && episode) {
      params.seasonId = season;
      params.episodeId = episode;
    }
    var qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    var url = 'https://api.videasy.net/' + srv.path + '/sources-with-title?' + qs;

    return httpGet(url).then(function (encrypted) {
      if (!encrypted || !String(encrypted).trim()) throw new Error('empty response');
      return postJson('https://enc-dec.app/api/dec-videasy', { text: encrypted, id: Number(meta.tmdbId) });
    }).then(function (decrypted) {
      var out = [];
      var sources = (decrypted && decrypted.result && decrypted.result.sources) || [];
      sources.forEach(function (src, i) {
        if (!src.url) return;
        var q = src.quality || qualityFromUrl(src.url) ||
                (src.url.indexOf('.m3u8') !== -1 ? 'Auto' : 'Stream');
        var parts = [];
        parts.push(q);
        if (src.language) parts.push(src.language);
        out.push({
          name: BRAND + ' #' + (91 + i) + ' - ' + parts.join(' ') + ' - VideoEasy - ' + srv.name,
          title: (meta.title || '') + (mediaType === 'tv' && season && episode
            ? ' S' + pad2(season) + 'E' + pad2(episode) : '') +
            (src.url.indexOf('.m3u8') !== -1 ? ' - HLS' : ''),
          url: src.url,
          quality: q,
          headers: {
            'User-Agent': DEFAULT_HEADERS['User-Agent'],
            'Referer': 'https://api.videasy.net/',
            'Origin': 'https://player.videasy.net'
          }
        });
      });
      log('videasy[' + srv.name + '] -> ' + out.length + ' stream(s)');
      return out;
    }).catch(function (e) {
      log('videasy[' + srv.name + '] failed:', e && e.message);
      return [];
    });
  }

  function fetchVideasyFallback(meta, mediaType, season, episode) {
    return Promise.all(VIDEASY_SERVERS.map(function (srv) {
      return fetchVideasyServer(srv, meta, mediaType, season, episode);
    })).then(function (lists) {
      var merged = [], seen = [];
      lists.forEach(function (list) {
        list.forEach(function (s) {
          if (seen.indexOf(s.url) === -1) { seen.push(s.url); merged.push(s); }
        });
      });
      log('videasy total: ' + merged.length);
      return merged;
    });
  }

  // ------------------------- main entry -------------------------
  function getStreamsByMeta(title, year, mediaType, season, episode) {
    var cacheKey = 'streams_' + normalizeTitle(title) + '_' + (year || 0) + '_' + mediaType +
                   '_' + (season || 0) + '_' + (episode || 0);
    var cached = cacheGet(cacheKey);
    if (cached) { log('cache hit'); return Promise.resolve(cached); }

    var wantSeries = mediaType === 'tv' || mediaType === 'series';

    return searchSite(title, mediaType).then(function (cards) {
      log('search cards:', cards.length);
      var card = findBestCard(cards, title, year);
      if (!card) throw new Error('No 4KHDHub result for "' + title + '" (' + year + ')');
      log('matched page:', card.url);

      var detailKey = 'detail_' + card.url +
        (wantSeries ? '_s' + (season || 0) + '_e' + (episode || 0) : '');
      var detailCached = cacheGet(detailKey);
      var detail = detailCached
        ? Promise.resolve(detailCached)
        : httpGet(card.url).then(function (html) {
            var parsed = wantSeries
              ? parseEpisodes(html, season || 0, episode || 0)
              : parseDownloadItems(html);
            cacheSet(detailKey, parsed, DETAIL_TTL_MS);
            return parsed;
          });

      return detail.then(function (items) {
        if (!items.length) return [];
        var picked = dedupeItems(items);
        if (!picked.length) picked = items;
        return resolveItemsSequential(picked, title, season, episode).then(function (streams) {
          streams.sort(function (a, b) {
            var d = qualityRank(a.quality) - qualityRank(b.quality);
            if (d !== 0) return d;
            return sizeToBytes(b.title) - sizeToBytes(a.title);
          });
          if (streams.length) cacheSet(cacheKey, streams, STREAMS_TTL_MS);
          return streams;
        });
      });
    });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var mt = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
    log('getStreams', tmdbId, mt, season || '-', episode || '-');
    return getTmdbDetails(tmdbId, mt).then(function (meta) {
      log('tmdb meta:', JSON.stringify(meta));
      if (!meta || !meta.title) throw new Error('TMDB lookup failed for id ' + tmdbId);

      // Preferred path: self-hosted resolver worker (server-side, stable IPs)
      if (RESOLVER_URL) {
        var wq = 'type=' + mt +
                 '&imdb=' + encodeURIComponent(meta.imdbId || '') +
                 '&tmdb=' + encodeURIComponent(meta.tmdbId || '') +
                 '&s=' + (season || 0) + '&e=' + (episode || 0);
        return httpGet(RESOLVER_URL + '/streams?' + wq, null, true).then(function (res) {
          var out = (res.streams || []).map(function (s) {
            var playUrl = s.url;
            if (s.candidates && s.candidates.length) {
              var qs = s.candidates.map(function (c, ci) { return 'c' + ci + '=' + encodeURIComponent(c); }).join('&');
              try { qs += '&ref=' + btoa(s.referer || ''); } catch (e) {}
              playUrl = RESOLVER_URL + '/play?' + qs;
            }
            return { name: s.name, title: s.title, url: playUrl, quality: s.quality };
          });
          log('resolver returned ' + out.length + ' stream(s)');
          if (out.length) return out;
          // worker found nothing — fall through to local pipeline
          return getStreamsByMeta(meta.title, meta.year, mt, season, episode);
        }).catch(function (e) {
          log('resolver failed, using local pipeline:', e && e.message);
          return getStreamsByMeta(meta.title, meta.year, mt, season, episode);
        });
      }

      return getStreamsByMeta(meta.title, meta.year, mt, season, episode)
        .catch(function (e) {
          log('4khdhub pipeline failed:', e && e.message);
          return [];
        })
        .then(function (streams) {
          if (streams.length) return streams;
          // All 4KHDHub mirrors dead or no page match — VideoEasy fallback
          log('falling back to VideoEasy servers');
          return fetchVideasyFallback(meta, mt, season, episode);
        });
    }).catch(function (e) {
      log('FATAL in getStreams:', e && e.message);
      throw e;
    });
  }

  // ------------------------- exports -------------------------
  var api = {
    getStreams: getStreams,
    _internal: {
      configure: function (opts) {
        if (opts && typeof opts.tmdbApiKey === 'string') TMDB_API_KEY = opts.tmdbApiKey;
        if (opts && typeof opts.baseUrl === 'string') BASE_URL = opts.baseUrl;
      },
      clearCaches: function () { cacheStore = {}; },
      getStreamsByMeta: getStreamsByMeta,
      searchSite: searchSite,
      parseCards: parseCards,
      parseDownloadItems: parseDownloadItems,
      parseEpisodes: parseEpisodes,
      resolveHubCloud: resolveHubCloud,
      resolveHubDrive: resolveHubDrive
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    try {
      if (typeof globalThis !== 'undefined') globalThis.__NUVIO_4KHDHUB = api;
      else if (typeof global !== 'undefined') global.__NUVIO_4KHDHUB = api;
      else if (typeof window !== 'undefined') window.__NUVIO_4KHDHUB = api;
    } catch (e) { /* no accessible global */ }
  }
}).call(this);
