// HDHub4u — movie/series source for the Zangetsu provider repo.
//
// Ported from the phisher CloudStream extension. HTML-scraped catalog (regex) +
// Typesense search + TMDB enrichment, and a self-contained video chain:
//   page links → optional `?id=` redirect resolver (triple-base64 + ROT13)
//   → hblinks (link list) / hubdrive → HubCloud → direct files (FSL / S3 /
//   Pixeldrain / Buzz / 10Gbps), plus hdstream4u (VidHide, best-effort).
// Each direct file is labelled with its real quality/size/release tags parsed
// from the HubCloud filename (so the quality menu + source names populate).
//
// NOTE: the `hubstream` (VidStack) host needs AES-CBC and is still phase 2.
// HDHub4u offers hubcloud/hubdrive per quality, so links resolve without it.

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
    logo: 'https://new2.hdhub4u.limo/favicon.ico', type: 'movie', version: '1.1.0'
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
  if (l.indexOf('hubstream') !== -1) return Promise.resolve([]); // phase 2 (AES-CBC)
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
