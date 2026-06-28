// AnimeCube — Donghua (Chinese animation) source. Site: https://animecube.live
//
// Next.js App Router site: listings come from the server-rendered RSC payload
// (no clean list API) + the sitemap for search; episode streams come from a
// plaintext JSON API (`/api/anime/<slug>/episode/<epSlug>/sources`) that returns
// `{platform, videoId, privateId}` for Dailymotion (the primary host) / Rumble.
// Both resolve to a plain HLS m3u8: Dailymotion via its GEO endpoint with the
// animecube embedder + the privateId; Rumble via its embedJS API. Chinese audio
// + subs only — there is no dub on this site.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'animecube';

var SITE = 'https://animecube.live';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function getInfo() {
  return { name: 'AnimeCube', lang: 'zh', baseUrl: SITE,
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.0.2' };
}

function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || SITE + '/' } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _json(url, ref) {
  return _get(url, ref).then(function (b) {
    try { return JSON.parse(b); } catch (e) { return null; }
  });
}

// ── RSC helpers ──────────────────────────────────────────────────────────────
// The page data lives in `self.__next_f.push([1,"<escaped>"])` script chunks.
// Concatenate them and lightly un-escape so the embedded JSON can be regex-mined.
function _rsc(html) {
  var parts = [];
  var re = /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)/g;
  var m;
  while ((m = re.exec(html)) !== null) parts.push(m[1]);
  var s = parts.join('');
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function _field(obj, key) {
  var m = obj.match(new RegExp('"' + key + '":"((?:\\\\.|[^"\\\\])*)"'));
  return m ? m[1] : null;
}

// Pull every anime card object ({slug,title,coverImage,...}) out of an RSC blob.
function _cards(rsc) {
  var out = [];
  var seen = {};
  // Anime objects carry "slug" + "coverImage"; they contain only string/array
  // values (no nested objects), so a brace-balanced-free match is safe.
  var re = /\{[^{}]*?"slug":"[a-z0-9\-]+"[^{}]*?\}/g;
  var m;
  while ((m = re.exec(rsc)) !== null) {
    var o = m[0];
    var slug = _field(o, 'slug');
    if (!slug || seen[slug] || !/coverImage|title/.test(o)) continue;
    seen[slug] = 1;
    var genres = [];
    var gm = o.match(/"genres":\[([^\]]*)\]/);
    if (gm) genres = (gm[1].match(/"([^"]+)"/g) || []).map(function (x) { return x.replace(/"/g, ''); });
    var year = _field(o, 'year');
    var rm = o.match(/"rating":\s*([0-9.]+)/);
    var um = o.match(/"(?:lastEpisodeAddedAt|latestEpisodePublishedAt|updatedAt)":"([^"]+)"/);
    out.push({
      id: slug, title: _field(o, 'title') || _titleFromSlug(slug),
      cover: _field(o, 'coverImage') || null, url: slug,
      type: 'anime', sourceId: SOURCE_ID,
      genres: genres, year: year ? parseInt(year, 10) : null,
      rating: rm ? parseFloat(rm[1]) : 0, updatedAt: um ? um[1] : '',
    });
  }
  return out;
}

function _titleFromSlug(s) {
  return String(s).replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

// ── Listings ─────────────────────────────────────────────────────────────────
function getHome(opts) {
  return _get(SITE + '/').then(function (html) {
    var cards = _cards(_rsc(html));
    if (!cards.length) return [];
    // The app uses row[0] as the hero carousel, so a single row leaves no
    // content rows below it. Build a few rows from the catalog. The cards
    // carry rating + last-updated (ISO strings sort chronologically) for
    // ordering; we slice different sorts so the rows aren't identical.
    var updated = cards.slice().sort(function (a, b) {
      return (b.updatedAt || '') < (a.updatedAt || '') ? -1 : ((b.updatedAt || '') > (a.updatedAt || '') ? 1 : 0);
    });
    var rated = cards.slice().sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); });
    var rows = [
      { title: 'New Episodes', items: updated.slice(0, 24) },
      { title: 'Top Rated', items: rated.slice(0, 24) },
      { title: 'All Donghua', items: cards },
    ];
    return rows.filter(function (r) { return r.items.length; });
  }).catch(function () { return []; });
}

function popular(opts) {
  return getHome(opts).then(function (rows) {
    // Flatten all rows into a de-duped list for the "popular" surface.
    var seen = {}, out = [];
    for (var i = 0; i < rows.length; i++) {
      var items = rows[i].items;
      for (var j = 0; j < items.length; j++) {
        if (!seen[items[j].id]) { seen[items[j].id] = 1; out.push(items[j]); }
      }
    }
    return out;
  });
}

// Search: the site has no search API, but its sitemap lists every title (~50),
// so we fetch it once (cached) and substring-match the query against the slugs.
var _sitemap = null;
function _slugs() {
  if (_sitemap) return Promise.resolve(_sitemap);
  return _get(SITE + '/sitemap.xml').then(function (xml) {
    var slugs = [], seen = {}, re = /\/anime\/([a-z0-9\-]+)/g, m;
    while ((m = re.exec(xml)) !== null) { if (!seen[m[1]]) { seen[m[1]] = 1; slugs.push(m[1]); } }
    _sitemap = slugs;
    return slugs;
  }).catch(function () { return []; });
}

function search(query, page, opts) {
  var q = String(query || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!q) return Promise.resolve([]);
  var toks = q.split(' ');
  return _slugs().then(function (slugs) {
    var hits = slugs.filter(function (s) {
      var hay = s.replace(/-/g, ' ');
      for (var i = 0; i < toks.length; i++) if (hay.indexOf(toks[i]) === -1) return false;
      return true;
    });
    return hits.slice(0, 30).map(function (s) {
      return { id: s, title: _titleFromSlug(s), cover: null, url: s, type: 'anime', sourceId: SOURCE_ID };
    });
  });
}

// ── Detail + episodes ────────────────────────────────────────────────────────
function getDetail(url, opts) {
  var slug = String(url);
  return _get(SITE + '/anime/' + encodeURIComponent(slug)).then(function (html) {
    var rsc = _rsc(html);
    var card = null;
    var cards = _cards(rsc);
    for (var i = 0; i < cards.length; i++) if (cards[i].id === slug) { card = cards[i]; break; }
    card = card || {};

    // Episodes are `<slug>-tab-<T>-ep-<N>` slugs in the RSC. Collect uniques,
    // order by (tab, episode), and number them sequentially for the list.
    var seen = {}, eps = [];
    var re = new RegExp('"(' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-tab-(\\d+)-ep-(\\d+))"', 'g');
    var m;
    while ((m = re.exec(rsc)) !== null) {
      if (seen[m[1]]) continue;
      seen[m[1]] = 1;
      eps.push({ epSlug: m[1], tab: parseInt(m[2], 10), ep: parseInt(m[3], 10) });
    }
    eps.sort(function (a, b) { return a.tab - b.tab || a.ep - b.ep; });
    var episodes = [];
    for (var k = 0; k < eps.length; k++) {
      var n = k + 1;
      episodes.push({ id: eps[k].epSlug, number: n, title: 'Episode ' + n,
        url: 'animecube://' + slug + '|' + eps[k].epSlug });
    }

    return {
      id: slug, title: card.title || _titleFromSlug(slug), englishTitle: null,
      cover: card.cover || null, url: slug,
      description: 'Donghua (Chinese animation) — subbed.',
      status: 'unknown', genres: card.genres || [], studios: [], type: 'anime',
      sourceId: SOURCE_ID, year: card.year || null, malId: null,
      episodes: episodes, subCount: episodes.length, dubCount: 0,
    };
  });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return d.episodes; });
}

// ── Streams ──────────────────────────────────────────────────────────────────
function getVideoSources(episodeUrl) {
  var raw = String(episodeUrl).replace('animecube://', '');
  var cut = raw.indexOf('|');
  if (cut < 0) return Promise.reject(new Error('AnimeCube: bad episode url'));
  var slug = raw.slice(0, cut);
  var epSlug = raw.slice(cut + 1);
  var tm = epSlug.match(/-tab-(\d+)-ep-(\d+)/);
  if (!tm) return Promise.reject(new Error('AnimeCube: bad episode slug'));
  var seasonId = 'tab-' + tm[1];

  // The per-season `v=` token rotates; it lives in the (plaintext) versions map.
  return _json(SITE + '/api/anime-sources-versions', SITE + '/anime/' + slug).then(function (reg) {
    var by = (reg && reg.bySeason && reg.bySeason[slug]) || {};
    var primaryId = null, token = null;
    for (var p in by) { if (by[p] && by[p][seasonId]) { primaryId = p; token = by[p][seasonId]; break; } }
    if (!token) throw new Error('AnimeCube: no version token');
    var su = SITE + '/api/anime/' + slug + '/episode/' + epSlug + '/sources'
      + '?v=' + encodeURIComponent(token)
      + '&primaryTabId=' + encodeURIComponent(primaryId)
      + '&seasonId=' + encodeURIComponent(seasonId);
    return _json(su, SITE + '/anime/' + slug).then(function (j) {
      var list = (j && j.sources) || [];
      var jobs = [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s || !s.platform) continue;
        if (s.platform === 'dailymotion' && (s.privateId || s.videoId)) {
          // Dailymotion videos are embed-restricted to animecube.live; the geo
          // endpoint serves the HLS manifest when the matching `embedder` is set.
          jobs.push(_dailymotion(s.privateId || s.videoId, s.quality, slug));
        } else if (s.platform === 'rumble' && s.videoId) {
          jobs.push(_rumble(s.videoId, s.quality));
        }
      }
      return Promise.all(jobs).then(function (arrs) {
        var out = [];
        for (var a = 0; a < arrs.length; a++) if (arrs[a] && arrs[a].length) out = out.concat(arrs[a]);
        if (!out.length) throw new Error('AnimeCube: no playable sources');
        return out;
      });
    });
  });
}

// Dailymotion: the site's primary host. Videos are restricted to the
// animecube.live embedder, so the public metadata API 403s (DM010); the GEO
// endpoint with the matching `embedder` returns the HLS manifest. Use the
// `privateId` (the embed key) as the video id.
function _dailymotion(privateId, quality, slug) {
  if (!privateId) return Promise.resolve([]);
  var u = 'https://geo.dailymotion.com/video/' + encodeURIComponent(privateId)
    + '.json?legacy=true&embedder=' + encodeURIComponent(SITE + '/anime/' + slug);
  return _json(u, 'https://geo.dailymotion.com/').then(function (j) {
    if (!j || j.error) return [];
    var ql = j.qualities || {};
    var hdr = { 'User-Agent': UA, 'Referer': 'https://geo.dailymotion.com/' };
    var out = [];
    for (var q in ql) {
      var arr = ql[q] || [];
      for (var i = 0; i < arr.length; i++) {
        var url = arr[i] && arr[i].url;
        if (!url) continue;
        var isHls = (arr[i].type && arr[i].type.indexOf('mpegURL') !== -1) || /\.m3u8/i.test(url);
        out.push({ url: url, quality: (q === 'auto' ? (quality || 'auto') : q + 'p'),
          container: isHls ? 'hls' : 'mp4', headers: hdr, kind: 'sub', audioLang: 'zh', subtitles: [] });
        if (q === 'auto') break; // the auto/HLS entry covers all renditions
      }
    }
    return out;
  }).catch(function () { return []; });
}

function _rumble(videoId, quality) {
  var u = 'https://rumble.com/embedJS/u3/?request=video&ver=2&v=' + encodeURIComponent(videoId);
  return _json(u, SITE + '/').then(function (j) {
    var ua = (j && j.ua) || {};
    var out = [];
    var hdr = { 'User-Agent': UA, 'Referer': 'https://rumble.com/' };
    var hls = ua.hls && ua.hls.auto && ua.hls.auto.url;
    if (hls) out.push({ url: hls, quality: quality || 'auto', container: 'hls',
      headers: hdr, kind: 'sub', audioLang: 'zh', subtitles: [] });
    // Progressive mp4 renditions as a fallback / explicit qualities.
    var mp4 = ua.mp4 || {};
    for (var q in mp4) {
      var mu = mp4[q] && mp4[q].url;
      if (mu) out.push({ url: mu, quality: (/^\d+$/.test(q) ? q + 'p' : q), container: 'mp4',
        headers: hdr, kind: 'sub', audioLang: 'zh', subtitles: [] });
    }
    return out;
  }).catch(function () { return []; });
}
