// HDHub4u — movie/series source for the Zangetsu provider repo.
//
// Ported from the phisher CloudStream extension. HTML-scraped catalog (regex)
// with a Typesense search proxy, TMDB enrichment, and a multi-host video chain:
//   page links  →  optional `?id=` redirect resolver (triple-base64 + ROT13)
//   →  one of: hdstream4u (VidHide, packed-JS → m3u8) / hubdrive→hubcloud
//   (direct files) / pixeldrain (direct).
//
// NOTE: the `hubstream` (VidStack) host needs AES-CBC and is intentionally NOT
// resolved here yet — phase 2. HDHub4u offers hdstream4u per quality, so links
// still resolve without it.
//
// Domains rotate, so the live domain is fetched from the shared list and cached.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'hdhub4u';

var DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var SITE_HEADERS = { 'User-Agent': UA, 'Cookie': 'xla=s4t' };

var _dom = null;
function _domains() {
  if (_dom) return Promise.resolve(_dom);
  return fetch(DOMAINS_URL, { headers: { 'User-Agent': UA } }).then(function (r) {
    var j = {}; try { j = JSON.parse(r.body || '{}'); } catch (e) {}
    _dom = {
      main: (j['HDHUB4u'] || j['hdhub4u'] || 'https://new2.hdhub4u.limo').replace(/\/$/, ''),
      hub: (j['hubcloud'] || 'https://hubcloud.foo').replace(/\/$/, '')
    };
    return _dom;
  }).catch(function () {
    _dom = { main: 'https://new2.hdhub4u.limo', hub: 'https://hubcloud.foo' };
    return _dom;
  });
}

function getInfo() {
  return {
    name: 'HDHub4u', lang: 'hi', baseUrl: 'https://new2.hdhub4u.limo',
    logo: 'https://new2.hdhub4u.limo/favicon.ico', type: 'movie', version: '1.0.0'
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
function _uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { if (a[i] && !s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } } return o; }
function _quality(s) { var m = String(s || '').match(/(\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }
function _b64(s) {
  try { var b = base64ToBytes(String(s || '')); var o = ''; for (var i = 0; i < b.length; i++) o += String.fromCharCode(b[i]); return o; }
  catch (e) { return ''; }
}
function _rot13(s) {
  return String(s || '').replace(/[a-zA-Z]/g, function (c) {
    var base = c <= 'Z' ? 65 : 97; return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
  });
}
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Cookie': 'xla=s4t', 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _cleanTitle(raw) {
  var t = htmlText(raw || '').replace(/^\s*download\s+/i, '');
  t = t.split(/\s*\(/)[0].split(/\bseason\b/i)[0].split(/\bS0?\d/)[0]
       .replace(/\b(480p|720p|1080p|2160p|4k|web[- ]?dl|hdrip|bluray|x264|x265|hevc|hindi|dual audio).*$/i, '');
  return _trim(t) || _trim(htmlText(raw || ''));
}

// `.recent-movies > li.thumb` cards (home/category listing).
function _cards(html, main) {
  var out = [], seen = {};
  var parts = String(html || '').split(/<li[^>]*class="[^"]*\bthumb\b/i);
  for (var i = 1; i < parts.length; i++) {
    var c = parts[i];
    var href = (c.match(/<figure[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>\s*(?:<\/a>|<figcaption)/i) ||
                c.match(/<a[^>]+href="([^"]+)"/i) || [])[1];
    if (!href) continue;
    var url = absUrl(href, main);
    if (seen[url] || /\/(category|page)\//i.test(url)) continue; seen[url] = 1;
    var rawTitle = (c.match(/<figcaption[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
                    c.match(/<img[^>]+alt="([^"]+)"/i) || [])[1] || '';
    var img = (c.match(/<img[^>]+(?:data-lazy-src|data-src|src)="([^"]+)"/i) || [])[1] || null;
    out.push({
      id: url, title: _cleanTitle(rawTitle) || 'Untitled',
      cover: img ? absUrl(img, main) : null, url: url, type: 'movie', sourceId: SOURCE_ID
    });
  }
  return out;
}

function getHome(opts) {
  var rows = [
    { title: 'Latest', path: '/' },
    { title: 'Bollywood', path: '/category/bollywood-movies/' },
    { title: 'Hollywood', path: '/category/hollywood-movies/' },
    { title: 'Hindi Dubbed', path: '/category/hindi-dubbed/' },
    { title: 'Web Series', path: '/category/web-series/' }
  ];
  return _domains().then(function (d) {
    return Promise.all(rows.map(function (row) {
      return _get(d.main + row.path, d.main + '/').then(function (html) {
        return { title: row.title, items: _cards(html, d.main) };
      }).catch(function () { return { title: row.title, items: [] }; });
    }));
  }).catch(function () { return []; });
}

// Search uses HDHub4u's Typesense proxy (no key needed; UA + referer only).
function search(query, page, opts) {
  return _domains().then(function (d) {
    var u = 'https://search.pingora.fyi/collections/post/documents/search'
      + '?q=' + encodeURIComponent(query || '')
      + '&query_by=post_title,category&query_by_weights=4,2'
      + '&sort_by=sort_by_date:desc&limit=20&highlight_fields=none&use_cache=true'
      + '&page=' + (page || 1);
    return fetch(u, { headers: { 'User-Agent': UA, 'Referer': d.main + '/' } }).then(function (r) {
      var j = null; try { j = JSON.parse(r.body || 'null'); } catch (e) {}
      var hits = (j && j.hits) || [];
      var out = [];
      for (var i = 0; i < hits.length; i++) {
        var doc = (hits[i] && hits[i].document) || {};
        var url = doc.permalink || doc.url; if (!url) continue;
        var cover = doc.post_thumbnail || doc.feature_img || doc.image ||
          (doc.images && doc.images[0]) || null;
        out.push({
          id: url, title: _cleanTitle(doc.post_title || doc.title || ''), cover: cover,
          url: url, type: 'movie', sourceId: SOURCE_ID
        });
      }
      // Fallback to on-site search if the proxy returns nothing.
      if (out.length) return out;
      return _get(d.main + '/?s=' + encodeURIComponent(query || ''), d.main + '/')
        .then(function (h) { return _cards(h, d.main); });
    }).catch(function () { return []; });
  }).catch(function () { return []; });
}

// ── episode url packing ──────────────────────────────────────────────────────
function _epUrl(hrefs) { return 'hdh://' + encodeURIComponent(JSON.stringify(hrefs)); }
function _epHrefs(url) {
  try { return JSON.parse(decodeURIComponent(String(url).replace(/^hdh:\/\//, ''))); }
  catch (e) { return []; }
}

// Links that point at a known download host / redirector.
function _isLink(h) {
  return /hdstream4u|hubstream|hubcloud|hubdrive|hblinks|pixeldra|\?id=/i.test(String(h || ''));
}

// ── TMDB enrichment (keyless proxy) ──────────────────────────────────────────
var _TMDB = 'https://jumpfreedom.com/3';
var _STILL = 'https://image.tmdb.org/t/p/w300';
var _POSTER = 'https://image.tmdb.org/t/p/w500';
function _tj(url) {
  return fetch(url, { headers: { 'User-Agent': UA }, timeoutMs: 7000 })
    .then(function (r) { try { return JSON.parse(r.body || 'null'); } catch (e) { return null; } })
    .catch(function () { return null; });
}
function _tmdbFind(title, year, isTv) {
  var q = String(title || '').replace(/\bseason\b.*$/i, '').replace(/\(.*$/, '').trim();
  return _tj(_TMDB + '/search/' + (isTv ? 'tv' : 'movie') + '?query=' + encodeURIComponent(q))
    .then(function (j) {
      var res = (j && j.results) || []; if (!res.length) return null;
      if (year) for (var i = 0; i < res.length; i++) {
        var dt = (res[i].first_air_date || res[i].release_date || '');
        if (dt.slice(0, 4) === String(year)) return res[i].id;
      }
      return res[0].id;
    });
}

// Movie: bundle every download href into one episode.
function _movieEpisode(html, title) {
  var hrefs = [], m, re = /<a[^>]+href="([^"]+)"/gi;
  while ((m = re.exec(html)) !== null) { if (_isLink(m[1])) hrefs.push(m[1]); }
  hrefs = _uniq(hrefs);
  if (!hrefs.length) return [];
  return [{ id: 'movie', title: title || 'Movie', number: 1, url: _epUrl(hrefs) }];
}

// Series: group download links by the nearest preceding "Episode N" heading.
function _seriesEpisodes(html) {
  var heads = [], hm, hre = /episode\s*0*(\d{1,3})/gi;
  while ((hm = hre.exec(html)) !== null) heads.push({ idx: hm.index, e: parseInt(hm[1], 10) });
  var map = {}, order = [], am, are = /<a[^>]+href="([^"]+)"/gi;
  while ((am = are.exec(html)) !== null) {
    var href = am[1]; if (!_isLink(href)) continue;
    var ep = 1;
    for (var i = 0; i < heads.length; i++) { if (heads[i].idx < am.index) ep = heads[i].e; else break; }
    var key = String(ep);
    if (!map[key]) { map[key] = { e: ep, hrefs: [] }; order.push(key); }
    if (map[key].hrefs.indexOf(href) === -1) map[key].hrefs.push(href);
  }
  order.sort(function (a, b) { return map[a].e - map[b].e; });
  var eps = order.map(function (key) {
    var o = map[key];
    return { id: 'E' + o.e, number: o.e, title: 'Episode ' + o.e, url: _epUrl(o.hrefs) };
  });
  if (!eps.length) return _movieEpisode(html, 'Full');
  return eps;
}

function getDetail(url, opts) {
  return _domains().then(function (d) {
    return fetch(url, { headers: SITE_HEADERS }).then(function (r) {
      var html = r.body || '';
      var rawTitle = (html.match(/<h1[^>]*class="[^"]*page-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
                      html.match(/<meta property="og:title" content="([^"]+)"/i) || [])[1] || 'Untitled';
      var title = _cleanTitle(rawTitle);
      var poster = (html.match(/<meta property="og:image" content="([^"]+)"/i) || [])[1] || null;
      var description = htmlText((html.match(/<meta name="description" content="([^"]+)"/i) || [])[1] || '');
      var year = (htmlText(rawTitle).match(/\((19|20)\d{2}\)/) || [])[0];
      year = year ? year.replace(/[()]/g, '') : ((html.match(/\b(19|20)\d{2}\b/) || [])[0] || null);
      var isSeries = /\bseason\b|\bS0?\d|web[- ]?series|episode\s*0*\d/i.test(htmlText(rawTitle)) ||
        ((html.match(/episode\s*0*\d/gi) || []).length > 1);
      var episodes = isSeries ? _seriesEpisodes(html) : _movieEpisode(html, title);

      var base = {
        id: url, title: title, cover: poster, url: url, description: description,
        status: 'unknown', genres: [], studios: [], type: 'movie', sourceId: SOURCE_ID,
        episodes: episodes, year: year, subCount: episodes.length, dubCount: 0
      };

      return _tmdbFind(title, year, isSeries).then(function (id) {
        if (!id) return base;
        var seasons = isSeries ? [1] : [];
        var jobs = [_tj(_TMDB + '/' + (isSeries ? 'tv' : 'movie') + '/' + id)];
        seasons.forEach(function (s) {
          jobs.push(_tj(_TMDB + '/tv/' + id + '/season/' + s).then(function (j) {
            return { s: s, eps: (j && j.episodes) || [] };
          }));
        });
        return Promise.all(jobs).then(function (all) {
          var info = all[0];
          if (info) {
            if (info.overview) base.description = info.overview;
            if (info.genres && info.genres.length) base.genres = info.genres.map(function (g) { return g.name; });
            if (info.poster_path) base.cover = _POSTER + info.poster_path;
          }
          var meta = {};
          for (var i = 1; i < all.length; i++) {
            var sd = all[i]; if (!sd) continue;
            for (var k = 0; k < sd.eps.length; k++) { var ep = sd.eps[k]; meta[ep.episode_number] = ep; }
          }
          base.episodes = episodes.map(function (e) {
            var md = meta[e.number]; if (!md) return e;
            return { id: e.id, number: e.number, url: e.url,
              title: 'Episode ' + e.number + ' - ' + (md.name || ('Episode ' + e.number)),
              thumbnail: md.still_path ? (_STILL + md.still_path) : null, date: md.air_date || null };
          });
          return base;
        });
      }).catch(function () { return base; });
    });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// ── stream resolution ────────────────────────────────────────────────────────
function _src(url, quality, label, hlsHeaders) {
  var hls = /\.m3u8(\?|$)/i.test(url);
  return {
    url: url, quality: quality || 'auto', container: hls ? 'hls' : 'mp4',
    headers: hlsHeaders || { 'User-Agent': UA }, kind: 'sub', audioLang: '',
    subtitles: [], label: _trim(label || 'HDHub4u')
  };
}

// `?id=` redirect resolver (triple-base64 + ROT13), same as 4KHDHub.
function _resolveRedirect(url) {
  return _get(url).then(function (html) {
    var combined = '', m, re = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
    while ((m = re.exec(html)) !== null) combined += (m[1] || m[2] || '');
    if (!combined) return '';
    var decoded; try { decoded = _b64(_rot13(_b64(_b64(combined)))); } catch (e) { return ''; }
    var json; try { json = JSON.parse(decoded); } catch (e) { return ''; }
    var o = _b64(json.o || ''); if (o && _trim(o)) return _trim(o);
    var data = _b64(json.data || ''), wp = json.blog_url || '';
    if (!wp || !data) return '';
    return _get(wp + '?re=' + data).then(function (t) { return htmlText(t); });
  }).catch(function () { return ''; });
}

// hdstream4u (VidHide): packed-JS embed → m3u8.
function _vidhide(url) {
  var emb = url.replace(/\/(d|download)\//, '/').replace(/\/f\//, '/e/');
  return fetch(emb, { headers: { 'User-Agent': UA, 'Referer': url } }).then(function (r) {
    var body = r.body || '';
    var unpacked = body;
    try { if (/eval\(function\(p,a,c,k,e/.test(body)) unpacked = unpackJs(body); } catch (e) {}
    var src = unpacked + '\n' + body;
    var m = src.match(/(?:file|source|src)\s*:\s*"([^"]+\.m3u8[^"]*)"/i) ||
            src.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/i);
    if (!m) return [];
    var hdr = { 'User-Agent': UA, 'Referer': (emb.match(/^(https?:\/\/[^/]+)/) || [])[1] + '/' };
    return [_src(m[1], 'auto', 'HDHub4u [HdStream4u]', hdr)];
  }).catch(function () { return []; });
}

// pixeldrain → direct file api.
function _pixeldrain(url) {
  var b = (url.match(/^(https?:\/\/[^/]+)/) || [])[1] || '';
  var id = url.replace(/\/$/, '').split('/').pop();
  var fin = url.indexOf('download') !== -1 ? url : (b + '/api/file/' + id + '?download');
  return Promise.resolve([_src(fin, 'auto', 'HDHub4u [Pixeldrain]')]);
}

// ── HubCloud chain (direct files), trimmed from 4KHDHub ──────────────────────
function _hubServer(link, label) {
  var l = String(label || '').toLowerCase();
  if (l.indexOf('buzz') !== -1) {
    return fetch(link + '/download', { headers: { 'Referer': link, 'User-Agent': UA }, followRedirects: false })
      .then(function (r) { var h = r.headers || {}; var dl = h['hx-redirect'] || h['HX-Redirect'] || ''; return dl ? _src(dl, 'auto', 'HDHub4u [Buzz]') : null; })
      .catch(function () { return null; });
  }
  if (l.indexOf('pixeldra') !== -1 || l.indexOf('pixel') !== -1) {
    var b = (link.match(/^(https?:\/\/[^/]+)/) || [])[1] || '';
    var fin = link.indexOf('download') !== -1 ? link : (b + '/api/file/' + link.replace(/\/$/, '').split('/').pop() + '?download');
    return Promise.resolve(_src(fin, 'auto', 'HDHub4u [Pixeldrain]'));
  }
  if (l.indexOf('fsl') !== -1 || l.indexOf('download') !== -1 || l.indexOf('s3') !== -1 ||
      l.indexOf('10gb') !== -1 || l.indexOf('pdl') !== -1) {
    return Promise.resolve(_src(link, 'auto', 'HDHub4u [HubCloud]'));
  }
  if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(link)) return Promise.resolve(_src(link, 'auto', 'HDHub4u [HubCloud]'));
  return Promise.resolve(null);
}
function _hubcloud(url) {
  var base = (url.match(/^(https?:\/\/[^/]+)/) || [])[1] || '';
  var step1 = url.indexOf('hubcloud.php') !== -1 ? Promise.resolve(url)
    : _get(url).then(function (html) {
        var raw = (html.match(/id=["']download["'][^>]*href="([^"]+)"/) ||
                   html.match(/href="([^"]+)"[^>]*id=["']download["']/) || [])[1] || '';
        if (!raw) return '';
        return /^https?:/i.test(raw) ? raw : (base + '/' + raw.replace(/^\//, ''));
      });
  return step1.then(function (href) {
    if (!href) return [];
    return _get(href).then(function (doc) {
      var jobs = [], m, re = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<a[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re.exec(doc)) !== null) {
        var link = m[1] || m[3]; var text = htmlText(m[2] || m[4] || '').toLowerCase();
        if (link) jobs.push(_hubServer(link, text));
      }
      return Promise.all(jobs).then(function (lists) { var out = []; for (var i = 0; i < lists.length; i++) if (lists[i]) out.push(lists[i]); return out; });
    });
  }).catch(function () { return []; });
}
function _hubdrive(url) {
  return _get(url).then(function (html) {
    var href = (html.match(/class="[^"]*btn-success1[^"]*"[^>]*href="([^"]+)"/) ||
                html.match(/href="([^"]+)"[^>]*class="[^"]*btn-success1/) ||
                html.match(/href="([^"]+)"[^>]*>[^<]*hubcloud/i) || [])[1] || '';
    if (href) return _hubcloud(href);
    return [];
  }).catch(function () { return []; });
}

function _dispatch(link) {
  var l = String(link).toLowerCase();
  if (l.indexOf('hdstream4u') !== -1) return _vidhide(link);
  if (l.indexOf('pixeldra') !== -1) return _pixeldrain(link);
  if (l.indexOf('hubdrive') !== -1) return _hubdrive(link);
  if (l.indexOf('hubcloud') !== -1) return _hubcloud(link);
  // hubstream (VidStack/AES-CBC): phase 2 — skip for now.
  if (l.indexOf('hubstream') !== -1) return Promise.resolve([]);
  if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(l)) return Promise.resolve([_src(link, _quality(link), 'HDHub4u')]);
  return Promise.resolve([]);
}

function getVideoSources(episodeUrl) {
  var hrefs = _epHrefs(episodeUrl).slice(0, 12);
  if (!hrefs.length) return Promise.reject(new Error('HDHub4u: no download links'));
  var jobs = hrefs.map(function (raw) {
    var p = raw.indexOf('?id=') !== -1 ? _resolveRedirect(raw) : Promise.resolve(raw);
    return p.then(function (resolved) { return resolved ? _dispatch(resolved) : []; }).catch(function () { return []; });
  });
  return Promise.all(jobs).then(function (lists) {
    var out = [], seen = {};
    for (var i = 0; i < lists.length; i++) {
      var arr = lists[i] || [];
      for (var k = 0; k < arr.length; k++) { var s = arr[k]; if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); } }
    }
    if (!out.length) throw new Error('HDHub4u: no playable links resolved');
    return out;
  });
}
