// HDHub4u — movie/series source for the Zangetsu provider repo.
//
// HTML-scraped catalog (regex) + Typesense search + TMDB enrichment, and a
// self-contained video chain:
//   page links → optional `?id=` redirect resolver (triple-base64 + ROT13)
//   → hblinks (link list) / hubdrive → HubCloud → direct files (FSL / S3 /
//   Pixeldrain / Buzz / 10Gbps), plus hdstream4u and hubstream (the latter
//   AES-CBC decrypted in pure JS to an m3u8).
// Each direct file is labelled with its real quality/size/release tags parsed
// from the HubCloud filename (so the quality menu + source names populate).

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'hdhub4u';

var DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
    logo: 'https://new2.hdhub4u.limo/favicon.ico', type: 'movie', version: '1.2.1'
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
    var href = (c.match(/<figcaption[\s\S]*?<a[^>]+href="([^"]+)"/i) ||
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
        out.push({
          id: url, title: _cleanTitle(doc.post_title || doc.title || ''),
          cover: doc.post_thumbnail || doc.feature_img || doc.image || null,
          url: url, type: 'movie', sourceId: SOURCE_ID
        });
      }
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
function _isLink(h) {
  return /hdstream4u|hubstream|hubcloud|hubdrive|hblinks|pixeldra|gadgets|\?id=/i.test(String(h || ''));
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

function _movieEpisode(html, title) {
  var hrefs = [], m, re = /<a[^>]+href="([^"]+)"/gi;
  while ((m = re.exec(html)) !== null) { if (_isLink(m[1])) hrefs.push(m[1]); }
  hrefs = _uniq(hrefs);
  if (!hrefs.length) return [];
  return [{ id: 'movie', title: title || 'Movie', number: 1, url: _epUrl(hrefs) }];
}
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
    return fetch(url, { headers: { 'User-Agent': UA, 'Cookie': 'xla=s4t', 'Referer': d.main + '/' } }).then(function (r) {
      var html = r.body || '';
      // Title lives in the page-title's <span class="material-text"> — the
      // leading <i class="material-icons"> glyph must NOT be scraped (it renders
      // as a junk leading letter).
      var rawTitle = (html.match(/<span class="material-text">([\s\S]*?)<\/span>/i) ||
                      html.match(/<meta property="og:title" content="([^"]+)"/i) ||
                      html.match(/<h1[^>]*class="[^"]*page-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || 'Untitled';
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
        // TMDB id drives Simkl movie/series tracking in the app.
        base.tmdbId = parseInt(id, 10);
        base.tmdbIsTv = !!isSeries;
        var jobs = [_tj(_TMDB + '/' + (isSeries ? 'tv' : 'movie') + '/' + id)];
        if (isSeries) jobs.push(_tj(_TMDB + '/tv/' + id + '/season/1').then(function (j) { return { eps: (j && j.episodes) || [] }; }));
        return Promise.all(jobs).then(function (all) {
          var info = all[0];
          if (info) {
            if (info.overview) base.description = info.overview;
            if (info.genres && info.genres.length) base.genres = info.genres.map(function (g) { return g.name; });
            if (info.poster_path) base.cover = _POSTER + info.poster_path;
          }
          var meta = {};
          if (all[1]) for (var k = 0; k < all[1].eps.length; k++) { var ep = all[1].eps[k]; meta[ep.episode_number] = ep; }
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
function _src(url, quality, label) {
  var hls = /\.m3u8(\?|$)/i.test(url);
  return {
    url: url, quality: quality || 'auto', container: hls ? 'hls' : 'mp4',
    headers: { 'User-Agent': UA }, kind: 'sub', audioLang: '',
    subtitles: [], label: _trim(label || 'HDHub4u')
  };
}

// `?id=` redirect resolver (triple-base64 + ROT13). Returns the destination URL
// (often an hblinks page) or '' on failure.
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

// Parse a release filename into normalised tags (CloudStream-style).
function _releaseTags(title) {
  if (!title) return '';
  var U = (' ' + String(title).replace(/\.(mkv|mp4|avi|m4v)\s*$/i, '').replace(/[._]/g, ' ')
    .replace(/\bWEB[ -]?DL\b/ig, 'WEB-DL').replace(/\bWEB[ -]?RIP\b/ig, 'WEBRIP')
    .replace(/\bH[ .]?265\b/ig, 'H265').replace(/\bH[ .]?264\b/ig, 'H264')
    + ' ').toUpperCase();
  function has(re) { return re.test(U); }
  var out = [];
  var groups = [
    [['WEB-DL', /\bWEB-DL\b/], ['WEBRIP', /\bWEBRIP\b/], ['BLURAY', /\bBLU ?RAY\b|\bBDRIP\b/], ['HDRIP', /\bHDRIP\b/], ['HDTV', /\bHDTV\b/], ['HDTC', /\bHDTC\b/], ['HDCAM', /\bHDCAM\b/]],
    [['H265', /\bH265\b|\bHEVC\b/], ['X265', /\bX265\b/], ['H264', /\bH264\b/], ['X264', /\bX264\b/], ['AVC', /\bAVC\b/]],
    [['DDP5.1', /\bDDP5\.1\b/], ['DDP', /\bDDP\b/], ['DD5.1', /\bDD5\.1\b/], ['DTS', /\bDTS\b/], ['AAC', /\bAAC\b/], ['AC3', /\bAC3\b/]]
  ];
  for (var g = 0; g < groups.length; g++) for (var i = 0; i < groups[g].length; i++) if (has(groups[g][i][1])) { out.push(groups[g][i][0]); break; }
  if (has(/\bATMOS\b/)) out.push('ATMOS');
  if (has(/\bHDR10\+\b/) || has(/\bHDR10PLUS\b/)) out.push('HDR10+'); else if (has(/\bHDR\b/)) out.push('HDR');
  if (has(/\bDUAL\b/)) out.push('DUAL'); else if (has(/\bHINDI\b/)) out.push('HINDI');
  var seen = {}, res = [];
  for (var k = 0; k < out.length; k++) if (!seen[out[k]]) { seen[out[k]] = 1; res.push(out[k]); }
  return res.join(' ');
}
function _resLabel(q) { return /2160/.test(String(q || '')) ? '4K' : (q || ''); }
function _serverName(label) {
  var l = String(label || '').toLowerCase();
  if (l.indexOf('fsl') !== -1) return 'FSL Server';
  if (l.indexOf('buzz') !== -1) return 'Buzz Server';
  if (l.indexOf('pixeldra') !== -1 || l.indexOf('pixel') !== -1) return 'Pixeldrain';
  if (l.indexOf('s3') !== -1) return 'S3 Server';
  if (l.indexOf('10gb') !== -1) return '10Gbps';
  if (l.indexOf('download') !== -1) return 'Download';
  return 'HubCloud';
}
// "HDHub4u [FSL Server] [WEB-DL H265 DDP5.1] [2.1GB] 1080p"
function _name(server, info) {
  var n = 'HDHub4u [' + server + ']';
  if (info.tags) n += ' [' + info.tags + ']';
  if (info.size) n += ' [' + info.size + ']';
  if (info.res) n += ' ' + info.res;
  return n;
}

// ── HubCloud (direct files) ──────────────────────────────────────────────────
function _hubServer(link, label, info) {
  var server = _serverName(label);
  var name = _name(server, info);
  var q = info.quality;
  var l = String(label || '').toLowerCase();
  if (l.indexOf('buzz') !== -1) {
    return fetch(link + '/download', { headers: { 'Referer': link, 'User-Agent': UA }, followRedirects: false })
      .then(function (r) { var h = r.headers || {}; var dl = h['hx-redirect'] || h['HX-Redirect'] || ''; return dl ? _src(dl, q, name) : null; })
      .catch(function () { return null; });
  }
  if (l.indexOf('pixeldra') !== -1 || l.indexOf('pixel') !== -1) {
    var b = (link.match(/^(https?:\/\/[^/]+)/) || [])[1] || '';
    var fin = link.indexOf('download') !== -1 ? link : (b + '/api/file/' + link.replace(/\/$/, '').split('/').pop() + '?download');
    return Promise.resolve(_src(fin, q, name));
  }
  if (l.indexOf('fsl') !== -1 || l.indexOf('download') !== -1 || l.indexOf('s3') !== -1 || l.indexOf('10gb') !== -1) {
    return Promise.resolve(_src(link, q, name));
  }
  if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(link)) return Promise.resolve(_src(link, q, name));
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
      var title = htmlText((doc.match(/<div class="card-header[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
      var size = htmlText((doc.match(/id=["']size["'][^>]*>([\s\S]*?)<\//) || [])[1] || '');
      var quality = _quality(title) || '1080p';
      var info = { tags: _releaseTags(title), size: size, res: _resLabel(quality), quality: quality };
      var jobs = [], m, re = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<a[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re.exec(doc)) !== null) {
        var link = m[1] || m[3]; var text = htmlText(m[2] || m[4] || '').toLowerCase();
        if (link) jobs.push(_hubServer(link, text, info));
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
// hblinks → page of hubcloud/hubdrive links → resolve each.
function _hblinks(url) {
  return _get(url).then(function (html) {
    var links = [], m, re = /<a[^>]+href="([^"]+)"/g;
    while ((m = re.exec(html)) !== null) {
      var h = m[1].toLowerCase();
      if (h.indexOf('hubcloud') !== -1 || h.indexOf('hubdrive') !== -1) links.push(m[1]);
    }
    links = _uniq(links).slice(0, 5);
    return Promise.all(links.map(_dispatch)).then(function (ls) {
      return ls.reduce(function (a, b) { return a.concat(b || []); }, []);
    });
  }).catch(function () { return []; });
}

// hdstream4u (VidHide): packed-JS player at /v/{id} → m3u8 (best-effort).
function _vidhide(url) {
  var id = (url.match(/\/(?:file|v|e|d)\/([A-Za-z0-9]+)/) || [])[1] || '';
  var emb = id ? ((url.match(/^(https?:\/\/[^/]+)/) || [])[1] + '/v/' + id) : url;
  return _get(emb, (emb.match(/^(https?:\/\/[^/]+)/) || [])[1] + '/').then(function (body) {
    var unpacked = body;
    try { if (/eval\(function\(p,a,c,k,e/.test(body)) unpacked = unpackJs(body); } catch (e) {}
    var src = unpacked + '\n' + body;
    var m = src.match(/(?:file|source|src)\s*:\s*"([^"]+\.m3u8[^"]*)"/i) ||
            src.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/i);
    if (!m) return [];
    var hdr = { 'User-Agent': UA, 'Referer': (emb.match(/^(https?:\/\/[^/]+)/) || [])[1] + '/' };
    var out = _src(m[1], 'auto', 'HDHub4u [HdStream4u]'); out.headers = hdr;
    return [out];
  }).catch(function () { return []; });
}

// ── hubstream (VidStack): /api/v1/video?id= → AES-128-CBC (static key) → m3u8.
// The sandbox only exposes AES-CTR, so AES-CBC is implemented here in pure JS
// (verified byte-for-byte against openssl on the live endpoint).
var _SBOX=[0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];
var _ISBOX=[0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb,0x7c,0xe3,0x39,0x82,0x9b,0x2f,0xff,0x87,0x34,0x8e,0x43,0x44,0xc4,0xde,0xe9,0xcb,0x54,0x7b,0x94,0x32,0xa6,0xc2,0x23,0x3d,0xee,0x4c,0x95,0x0b,0x42,0xfa,0xc3,0x4e,0x08,0x2e,0xa1,0x66,0x28,0xd9,0x24,0xb2,0x76,0x5b,0xa2,0x49,0x6d,0x8b,0xd1,0x25,0x72,0xf8,0xf6,0x64,0x86,0x68,0x98,0x16,0xd4,0xa4,0x5c,0xcc,0x5d,0x65,0xb6,0x92,0x6c,0x70,0x48,0x50,0xfd,0xed,0xb9,0xda,0x5e,0x15,0x46,0x57,0xa7,0x8d,0x9d,0x84,0x90,0xd8,0xab,0x00,0x8c,0xbc,0xd3,0x0a,0xf7,0xe4,0x58,0x05,0xb8,0xb3,0x45,0x06,0xd0,0x2c,0x1e,0x8f,0xca,0x3f,0x0f,0x02,0xc1,0xaf,0xbd,0x03,0x01,0x13,0x8a,0x6b,0x3a,0x91,0x11,0x41,0x4f,0x67,0xdc,0xea,0x97,0xf2,0xcf,0xce,0xf0,0xb4,0xe6,0x73,0x96,0xac,0x74,0x22,0xe7,0xad,0x35,0x85,0xe2,0xf9,0x37,0xe8,0x1c,0x75,0xdf,0x6e,0x47,0xf1,0x1a,0x71,0x1d,0x29,0xc5,0x89,0x6f,0xb7,0x62,0x0e,0xaa,0x18,0xbe,0x1b,0xfc,0x56,0x3e,0x4b,0xc6,0xd2,0x79,0x20,0x9a,0xdb,0xc0,0xfe,0x78,0xcd,0x5a,0xf4,0x1f,0xdd,0xa8,0x33,0x88,0x07,0xc7,0x31,0xb1,0x12,0x10,0x59,0x27,0x80,0xec,0x5f,0x60,0x51,0x7f,0xa9,0x19,0xb5,0x4a,0x0d,0x2d,0xe5,0x7a,0x9f,0x93,0xc9,0x9c,0xef,0xa0,0xe0,0x3b,0x4d,0xae,0x2a,0xf5,0xb0,0xc8,0xeb,0xbb,0x3c,0x83,0x53,0x99,0x61,0x17,0x2b,0x04,0x7e,0xba,0x77,0xd6,0x26,0xe1,0x69,0x14,0x63,0x55,0x21,0x0c,0x7d];
function _xtime(a){a<<=1;if(a&0x100)a^=0x11b;return a&0xff;}
function _gmul(a,b){var p=0;for(var i=0;i<8;i++){if(b&1)p^=a;var hi=a&0x80;a=(a<<1)&0xff;if(hi)a^=0x1b;b>>=1;}return p&0xff;}
function _keyExp(key){
  var Nk=key.length/4,Nr=Nk+6,w=[],i;
  for(i=0;i<Nk;i++)w.push([key[4*i],key[4*i+1],key[4*i+2],key[4*i+3]]);
  var rcon=1;
  for(i=Nk;i<4*(Nr+1);i++){
    var t=w[i-1].slice();
    if(i%Nk===0){t=[t[1],t[2],t[3],t[0]];t=[_SBOX[t[0]],_SBOX[t[1]],_SBOX[t[2]],_SBOX[t[3]]];t[0]^=rcon;rcon=_xtime(rcon);}
    else if(Nk>6&&i%Nk===4){t=[_SBOX[t[0]],_SBOX[t[1]],_SBOX[t[2]],_SBOX[t[3]]];}
    w.push([w[i-Nk][0]^t[0],w[i-Nk][1]^t[1],w[i-Nk][2]^t[2],w[i-Nk][3]^t[3]]);
  }
  return {w:w,Nr:Nr};
}
function _invCipher(inb,ks){
  var w=ks.w,Nr=ks.Nr,s=[[],[],[],[]],r,c,i;
  for(i=0;i<16;i++)s[i%4][(i/4)|0]=inb[i];
  function ark(round){for(c=0;c<4;c++)for(r=0;r<4;r++)s[r][c]^=w[round*4+c][r];}
  function isub(){for(r=0;r<4;r++)for(c=0;c<4;c++)s[r][c]=_ISBOX[s[r][c]];}
  function ishift(){for(r=1;r<4;r++){var row=s[r].slice();for(c=0;c<4;c++)s[r][c]=row[(c-r+4)%4];}}
  function imix(){for(c=0;c<4;c++){var a0=s[0][c],a1=s[1][c],a2=s[2][c],a3=s[3][c];
    s[0][c]=_gmul(a0,14)^_gmul(a1,11)^_gmul(a2,13)^_gmul(a3,9);
    s[1][c]=_gmul(a0,9)^_gmul(a1,14)^_gmul(a2,11)^_gmul(a3,13);
    s[2][c]=_gmul(a0,13)^_gmul(a1,9)^_gmul(a2,14)^_gmul(a3,11);
    s[3][c]=_gmul(a0,11)^_gmul(a1,13)^_gmul(a2,9)^_gmul(a3,14);}}
  ark(Nr);
  for(var round=Nr-1;round>=1;round--){ishift();isub();ark(round);imix();}
  ishift();isub();ark(0);
  var out=[];for(i=0;i<16;i++)out[i]=s[i%4][(i/4)|0];return out;
}
function _aesCbcDecrypt(ct,key,iv){
  var ks=_keyExp(key),out=[],prev=iv.slice(),off,i;
  for(off=0;off+16<=ct.length;off+=16){
    var block=ct.slice(off,off+16),dec=_invCipher(block,ks);
    for(i=0;i<16;i++)out.push(dec[i]^prev[i]);
    prev=block;
  }
  var pad=out[out.length-1];
  if(pad>0&&pad<=16)out=out.slice(0,out.length-pad);
  return out;
}
function _hexBytes(h){var b=[];for(var i=0;i+1<h.length;i+=2)b.push(parseInt(h.substr(i,2),16));return b;}
function _strBytes(s){var b=[];for(var i=0;i<s.length;i++)b.push(s.charCodeAt(i)&0xff);return b;}
function _bytesToStr(b){var s='',i=0;while(i<b.length){var c=b[i++];if(c<0x80)s+=String.fromCharCode(c);else if(c<0xE0)s+=String.fromCharCode(((c&0x1f)<<6)|(b[i++]&0x3f));else if(c<0xF0)s+=String.fromCharCode(((c&0x0f)<<12)|((b[i++]&0x3f)<<6)|(b[i++]&0x3f));else{var cp=((c&0x07)<<18)|((b[i++]&0x3f)<<12)|((b[i++]&0x3f)<<6)|(b[i++]&0x3f);cp-=0x10000;s+=String.fromCharCode(0xD800+(cp>>10),0xDC00+(cp&0x3FF));}}return s;}

function _hubstream(url) {
  var host = (url.match(/^(https?:\/\/[^/#?]+)/) || [])[1] || 'https://hubstream.art';
  var tail = String(url).split('#').pop();
  var hash = tail.indexOf('/') !== -1 ? tail.split('/').pop() : tail;
  if (!hash) return Promise.resolve([]);
  return fetch(host + '/api/v1/video?id=' + hash, { headers: { 'User-Agent': UA, 'Referer': url } }).then(function (r) {
    var enc = _trim(r.body || '');
    if (!/^[0-9a-fA-F]+$/.test(enc) || enc.length % 32 !== 0) return [];
    var ct = _hexBytes(enc), key = _strBytes('kiemtienmua911ca'), ivs = ['1234567890oiuytr', '0123456789abcdef'];
    for (var i = 0; i < ivs.length; i++) {
      try {
        var pt = _bytesToStr(_aesCbcDecrypt(ct, key, _strBytes(ivs[i])));
        var m = pt.match(/"source":"([^"]+)"/);
        if (!m) continue;
        var file = m[1].replace(/\\\//g, '/');
        if (!/^https?:/i.test(file)) continue;
        var subs = [];
        var sm = pt.match(/"subtitle":\{([^}]*)\}/);
        if (sm) {
          var sp, sre = /"([^"]+)":"([^"]+)"/g;
          while ((sp = sre.exec(sm[1])) !== null) {
            var su = sp[2].replace(/\\\//g, '/').split('#')[0];
            if (!/\.(vtt|srt)/i.test(su)) continue;
            subs.push({ url: /^https?:/i.test(su) ? su : (host + su), lang: sp[1], label: sp[1], format: /\.srt/i.test(su) ? 'srt' : 'vtt' });
          }
        }
        var src = _src(file, _quality(file) || 'auto', 'HDHub4u [HubStream]');
        src.headers = { 'User-Agent': UA, 'Referer': host + '/', 'Origin': host };
        src.subtitles = subs;
        return [src];
      } catch (e) {}
    }
    return [];
  }).catch(function () { return []; });
}

function _dispatch(link) {
  var l = String(link).toLowerCase();
  if (l.indexOf('hblinks') !== -1) return _hblinks(link);
  if (l.indexOf('hubcloud') !== -1) return _hubcloud(link);
  if (l.indexOf('hubdrive') !== -1) return _hubdrive(link);
  if (l.indexOf('hdstream4u') !== -1) return _vidhide(link);
  if (l.indexOf('pixeldra') !== -1) {
    var b = (link.match(/^(https?:\/\/[^/]+)/) || [])[1] || '';
    var fin = link.indexOf('download') !== -1 ? link : (b + '/api/file/' + link.replace(/\/$/, '').split('/').pop() + '?download');
    return Promise.resolve([_src(fin, 'auto', 'HDHub4u [Pixeldrain]')]);
  }
  if (l.indexOf('hubstream') !== -1) return _hubstream(link);
  if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(l)) return Promise.resolve([_src(link, _quality(link), 'HDHub4u')]);
  return Promise.resolve([]);
}

function getVideoSources(episodeUrl) {
  var hrefs = _epHrefs(episodeUrl).slice(0, 12);
  if (!hrefs.length) return Promise.reject(new Error('HDHub4u: no download links'));
  var jobs = hrefs.map(function (raw) {
    var p = /\?id=|gadgets/i.test(raw) ? _resolveRedirect(raw) : Promise.resolve(raw);
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
