// 4K HDHub — movie/series source for the Zangetsu provider repo.
//
// HTML-scraped catalog (no DOM parser in the runtime → regex), with a
// self-contained video chain: download links → optional `id=` redirect
// resolver (triple-base64 + ROT13) → HubCloud → direct file links (FSL /
// Download / S3 / Pixeldrain / Buzzserver). No host-side extractor needed.
//
// Domains rotate, so the live domain map is fetched once from the upstream
// list and cached; everything falls back to sane defaults.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'fourkhdhub';

var DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

var _dom = null;
function _domains() {
  if (_dom) return Promise.resolve(_dom);
  return fetch(DOMAINS_URL, { headers: { 'User-Agent': UA } }).then(function (r) {
    var j = {}; try { j = JSON.parse(r.body || '{}'); } catch (e) {}
    _dom = {
      main: (j['4khdhub'] || 'https://4khdhub.link').replace(/\/$/, ''),
      hub: (j['hubcloud'] || 'https://hubcloud.foo').replace(/\/$/, '')
    };
    return _dom;
  }).catch(function () {
    _dom = { main: 'https://4khdhub.link', hub: 'https://hubcloud.foo' };
    return _dom;
  });
}

function getInfo() {
  return {
    name: '4K HDHub', lang: 'en', baseUrl: 'https://4khdhub.link',
    logo: 'https://4khdhub.link/favicon.ico', type: 'movie', version: '1.0.3'
  };
}

// ── helpers ────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
function _b64(s) {
  try {
    var b = base64ToBytes(String(s || '')); var o = '';
    for (var i = 0; i < b.length; i++) o += String.fromCharCode(b[i]);
    return o;
  } catch (e) { return ''; }
}
function _rot13(s) {
  return String(s || '').replace(/[a-zA-Z]/g, function (c) {
    var base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
  });
}
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _quality(s) { var m = String(s || '').match(/(\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }

// Parse `div.card-grid a` cards out of raw HTML.
function _cards(html, main) {
  var out = [], seen = {};
  var re = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, m;
  while ((m = re.exec(html)) !== null) {
    var href = m[1], inner = m[2];
    var t = (inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1];
    if (!t) continue;
    var url = absUrl(href, main);
    if (seen[url]) continue; seen[url] = 1;
    var img = (inner.match(/<img[^>]+(?:data-src|src)="([^"]+)"/) || [])[1] || null;
    out.push({
      id: url, title: htmlText(t), cover: img ? absUrl(img, main) : null,
      url: url, type: 'movie', sourceId: SOURCE_ID
    });
  }
  return out;
}

function search(query, page, opts) {
  return _domains().then(function (d) {
    return _get(d.main + '/?s=' + encodeURIComponent(query || ''), d.main + '/')
      .then(function (html) { return _cards(html, d.main); });
  }).catch(function () { return []; });
}

function getHome(opts) {
  var rows = [
    { title: 'Latest Movies', path: '/category/movies' },
    { title: 'Latest Episodes', path: '/category/series' },
    { title: '4K HDR', path: '/category/2160p-HDR' },
    { title: 'Hindi Movies', path: '/category/hindi-movies' },
    { title: 'Korean Series', path: '/category/korean-series' }
  ];
  return _domains().then(function (d) {
    return Promise.all(rows.map(function (row) {
      return _get(d.main + row.path, d.main + '/').then(function (html) {
        return { title: row.title, items: _cards(html, d.main) };
      }).catch(function () { return { title: row.title, items: [] }; });
    }));
  }).catch(function () { return []; });
}

// Encodes a list of download hrefs into an opaque episode url.
function _epUrl(hrefs) { return '4khd://' + encodeURIComponent(JSON.stringify(hrefs)); }
function _epHrefs(url) {
  try { return JSON.parse(decodeURIComponent(String(url).replace(/^4khd:\/\//, ''))); }
  catch (e) { return []; }
}

// ── TMDB enrichment (keyless proxy) — 4KHDHub itself only exposes release
// filenames, so episode names/stills + a clean plot/genres come from TMDB. ──
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
      var res = (j && j.results) || [];
      if (!res.length) return null;
      if (year) {
        for (var i = 0; i < res.length; i++) {
          var d = (res[i].first_air_date || res[i].release_date || '');
          if (d.slice(0, 4) === String(year)) return res[i].id;
        }
      }
      return res[0].id;
    });
}

function getDetail(url, opts) {
  return _domains().then(function (d) {
    return _get(url, d.main + '/').then(function (html) {
      var title = _trim((html.match(/<h1[^>]*class="page-title"[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '')
        .replace(/<[^>]*>/g, '').split('(')[0];
      title = _trim(title) || _trim((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || 'Untitled');
      var poster = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || null;
      var description = htmlText((html.match(/class="content-section"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) || [])[1]
        || (html.match(/<meta name="description" content="([^"]+)"/) || [])[1] || '')
        .replace(/^watch trailer\s*/i, '');
      var year = (html.match(/\b(19|20)\d{2}\b/) || [])[0] || null;
      var tags = [];
      var tm; var tre = /class="badge[^"]*"[^>]*>([^<]+)</g;
      while ((tm = tre.exec(html)) !== null) tags.push(_trim(tm[1]));
      var isSeries = /season-item|episode-download-item/i.test(html) || tags.join(' ').toLowerCase().indexOf('series') !== -1;
      var episodes = isSeries ? _seriesEpisodes(html) : _movieEpisode(html, title);
      // drop release-quality tokens from the scraped genre fallback
      var cleanTags = tags.filter(function (t) {
        return !/\b\d+(\.\d+)?\s*(GB|MB)\b|WEB-?DL|WEBRIP|BLU-?RAY|\b\d{3,4}p\b|HDR|H\.?26[45]|x26[45]|HEVC|DDP|DTS|AAC|ATMOS/i.test(t);
      });

      var base = {
        id: url, title: title, cover: poster, url: url, description: description,
        status: 'unknown', genres: cleanTags.slice(0, 6), studios: [],
        type: 'movie', sourceId: SOURCE_ID, episodes: episodes, year: year,
        subCount: episodes.length, dubCount: 0
      };

      return _tmdbFind(title, year, isSeries).then(function (id) {
        if (!id) return base;
        var seasons = [];
        if (isSeries) {
          var seen = {};
          episodes.forEach(function (e) {
            var m = e.title.match(/^S(\d+)/);
            var s = m ? m[1] : '1';
            if (!seen[s]) { seen[s] = 1; seasons.push(parseInt(s, 10)); }
          });
        }
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
            if (info.genres && info.genres.length) {
              base.genres = info.genres.map(function (g) { return g.name; });
            }
            if (info.poster_path) base.cover = _POSTER + info.poster_path;
          }
          var meta = {};
          for (var i = 1; i < all.length; i++) {
            var sd = all[i];
            if (!sd) continue;
            for (var k = 0; k < sd.eps.length; k++) {
              var ep = sd.eps[k];
              meta[sd.s + '|' + ep.episode_number] = ep;
            }
          }
          base.episodes = episodes.map(function (e) {
            var m = e.title.match(/^S(\d+) E(\d+)/);
            if (!m) return e;
            var md = meta[parseInt(m[1], 10) + '|' + parseInt(m[2], 10)];
            if (!md) return e;
            return {
              id: e.id, number: e.number, url: e.url,
              title: 'S' + m[1] + ' E' + m[2] + ' - ' + (md.name || ('Episode ' + m[2])),
              thumbnail: md.still_path ? (_STILL + md.still_path) : (e.thumbnail || null),
              date: md.air_date || null
            };
          });
          return base;
        });
      }).catch(function () { return base; });
    });
  });
}

function _movieEpisode(html, title) {
  var hrefs = [], m;
  var block = (html.match(/class="download-item"[\s\S]*$/) || [])[0] || html;
  var re = /<a[^>]+href="([^"]+)"/g;
  while ((m = re.exec(block)) !== null) {
    var h = m[1];
    if (/hubcloud|hubdrive|hblinks|hubcdn|id=|\/redirect|\/links/i.test(h)) hrefs.push(h);
  }
  hrefs = hrefs.filter(function (v, i, a) { return a.indexOf(v) === i; });
  if (!hrefs.length) return [];
  return [{ id: 'movie', title: title || 'Movie', number: 1, url: _epUrl(hrefs) }];
}

function _seriesEpisodes(html) {
  // Each episode is a `.season-item.episode-item` block holding an `S0NE0M`
  // tag (season+episode) and several `.episode-download-item` links (one per
  // quality/server). The same episode can appear under multiple resolution
  // lists, so dedup by (season, episode) and merge links. Titled "S<s> E<e> …"
  // so the app's season dropdown picks them up.
  // Each block is a season×quality group ("S05 2160p WEB-DL …"); its season
  // comes from the header, and each `.episode-download-item` inside is one
  // episode (badge "Episode-0N") with that quality's link.
  var map = {}, order = [];
  var parts = html.split(/class="season-item episode-item/);
  for (var pi = 1; pi < parts.length; pi++) {
    var chunk = parts[pi];
    var head = (chunk.match(/episode-(?:number|title)[^>]*>([\s\S]{0,80}?)</) || [])[1] || '';
    var sm = head.match(/S(\d{1,2})/i) || chunk.match(/S(\d{1,2})E\d/i);
    var season = sm ? parseInt(sm[1], 10) : 1;
    var items = chunk.match(/episode-download-item[\s\S]*?(?=episode-download-item|class="season-item episode-item|class="download-item|$)/g) || [];
    for (var ii = 0; ii < items.length; ii++) {
      var it = items[ii];
      var em = it.match(/Episode[-\s]0*([0-9]+)/i);
      if (!em) continue;
      var ep = parseInt(em[1], 10);
      var hrefs = [], hm, hre = /<a[^>]+href="([^"]+)"/g;
      while ((hm = hre.exec(it)) !== null) {
        if (/hubcloud|hubdrive|hblinks|hubcdn|id=/i.test(hm[1])) hrefs.push(hm[1]);
      }
      if (!hrefs.length) continue;
      var key = season + '|' + ep;
      if (!map[key]) { map[key] = { s: season, e: ep, hrefs: [] }; order.push(key); }
      for (var k = 0; k < hrefs.length; k++) {
        if (map[key].hrefs.indexOf(hrefs[k]) === -1) map[key].hrefs.push(hrefs[k]);
      }
    }
  }
  order.sort(function (a, b) {
    var x = map[a], y = map[b];
    return x.s !== y.s ? x.s - y.s : x.e - y.e;
  });
  var eps = order.map(function (key) {
    var o = map[key];
    return {
      id: 'S' + o.s + 'E' + o.e, number: o.e,
      title: 'S' + o.s + ' E' + o.e + ' - Episode ' + o.e, url: _epUrl(o.hrefs)
    };
  });
  // No per-episode blocks → fall back to season-pack links (one combined entry).
  if (!eps.length) return _movieEpisode(html, 'Full');
  return eps;
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return d.episodes; });
}

// ── redirect resolver (Utils.getRedirectLinks) ──────────────────────────────
function _resolveRedirect(url) {
  return _get(url).then(function (html) {
    var combined = '', m;
    var re = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
    while ((m = re.exec(html)) !== null) combined += (m[1] || m[2] || '');
    if (!combined) return '';
    var decoded;
    try { decoded = _b64(_rot13(_b64(_b64(combined)))); } catch (e) { return ''; }
    var json; try { json = JSON.parse(decoded); } catch (e) { return ''; }
    var o = _b64(json.o || '');
    if (o && _trim(o)) return _trim(o);
    var data = _b64(json.data || '');
    var wp = json.blog_url || '';
    if (!wp || !data) return '';
    return _get(wp + '?re=' + data).then(function (t) { return htmlText(t); });
  }).catch(function () { return ''; });
}

// ── HubCloud ────────────────────────────────────────────────────────────────
function _hubcloud(url) {
  var base = (url.match(/^(https?:\/\/[^/]+)/) || [])[1] || '';
  var step1 = url.indexOf('hubcloud.php') !== -1
    ? Promise.resolve(url)
    : _get(url).then(function (html) {
        var raw = (html.match(/id=["']download["'][^>]*href="([^"]+)"/) ||
                   html.match(/href="([^"]+)"[^>]*id=["']download["']/) || [])[1] || '';
        if (!raw) return '';
        return /^https?:/i.test(raw) ? raw : (base + '/' + raw.replace(/^\//, ''));
      });
  return step1.then(function (href) {
    if (!href) return [];
    return _get(href).then(function (doc) {
      // The release filename lives in the (multi-class) card-header element.
      var title = htmlText((doc.match(/<div class="card-header[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
      var size = htmlText((doc.match(/id=["']size["'][^>]*>([\s\S]*?)<\//) || [])[1] || '');
      var quality = _quality(title) || '2160p';
      var info = { tags: _releaseTags(title), size: size, res: _resLabel(quality), quality: quality };
      var jobs = [], m;
      var re = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<a[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re.exec(doc)) !== null) {
        var link = m[1] || m[3]; var text = htmlText(m[2] || m[4] || '').toLowerCase();
        if (!link) continue;
        jobs.push(_hubServer(link, text, info));
      }
      return Promise.all(jobs).then(function (lists) {
        var out = []; for (var i = 0; i < lists.length; i++) if (lists[i]) out.push(lists[i]);
        return out;
      });
    });
  }).catch(function () { return []; });
}

function _src(url, quality, label) {
  var hls = /\.m3u8(\?|$)/i.test(url);
  return {
    url: url, quality: quality || 'auto', container: hls ? 'hls' : 'mp4',
    headers: { 'User-Agent': UA }, kind: 'sub', audioLang: '',
    subtitles: [], label: _trim(label || '')
  };
}

// Clean, human server name from a HubCloud button's text.
function _serverName(label) {
  if (label.indexOf('fsl') !== -1) return 'FSL Server';
  if (label.indexOf('buzz') !== -1) return 'Buzz Server';
  if (label.indexOf('pixeldra') !== -1 || label.indexOf('pixel') !== -1) return 'Pixeldrain';
  if (label.indexOf('s3') !== -1) return 'S3 Server';
  if (label.indexOf('10gb') !== -1) return '10Gbps';
  if (label.indexOf('mega') !== -1) return 'Mega';
  if (label.indexOf('pdl') !== -1) return 'PDL Server';
  if (label.indexOf('download') !== -1) return 'Download';
  return 'Server';
}

// Maps 2160p → "4K" for the trailing resolution badge (CloudStream-style).
function _resLabel(quality) {
  return /2160/.test(String(quality || '')) ? '4K' : (quality || '');
}

// Parse a release filename into normalised tags, CloudStream-style, e.g.
// "WEB-DL H265 DDP5.1 HDR10+ AMZN DUAL" / "BLURAY AVC DDP5 DTS-HD X264".
function _releaseTags(title) {
  if (!title) return '';
  var U = (' ' + String(title)
    .replace(/\.(mkv|mp4|avi|m4v)\s*$/i, '')
    .replace(/[._]/g, ' ')
    .replace(/\bWEB[ -]?DL\b/ig, 'WEB-DL')
    .replace(/\bWEB[ -]?RIP\b/ig, 'WEBRIP')
    .replace(/\bH[ .]?265\b/ig, 'H265')
    .replace(/\bH[ .]?264\b/ig, 'H264')
    .replace(/\bDDP[ .]?(\d(?:\.\d)?)\b/ig, 'DDP$1')
    .replace(/\bDD[ .]?(\d(?:\.\d)?)\b/ig, 'DD$1')
    + ' ').toUpperCase();
  function has(re) { return re.test(U); }
  var out = [];
  var groups = [
    [['WEB-DL', /\bWEB-DL\b/], ['WEBRIP', /\bWEBRIP\b/], ['BLURAY', /\bBLU ?RAY\b|\bBDRIP\b/], ['HDRIP', /\bHDRIP\b/], ['HDTV', /\bHDTV\b/], ['DVDRIP', /\bDVDRIP\b/], ['BRRIP', /\bBRRIP\b/], ['CAM', /\bCAM\b/]],
    [['H265', /\bH265\b|\bHEVC\b/], ['X265', /\bX265\b/], ['H264', /\bH264\b/], ['X264', /\bX264\b/], ['AVC', /\bAVC\b/]],
    [['DDP5.1', /\bDDP5\.1\b/], ['DDP5', /\bDDP5\b/], ['DDP', /\bDDP\b/], ['DD5.1', /\bDD5\.1\b/], ['DTS-HD', /\bDTS ?HD\b/], ['DTS', /\bDTS\b/], ['EAC3', /\bEAC3\b/], ['AC3', /\bAC3\b/], ['AAC', /\bAAC\b/], ['FLAC', /\bFLAC\b/]]
  ];
  for (var g = 0; g < groups.length; g++) {
    for (var i = 0; i < groups[g].length; i++) {
      if (has(groups[g][i][1])) { out.push(groups[g][i][0]); break; }
    }
  }
  if (has(/\bATMOS\b/)) out.push('ATMOS');
  if (has(/\bHDR10\+\b/) || has(/\bHDR10PLUS\b/)) out.push('HDR10+');
  else if (has(/\bHDR\b/)) out.push('HDR');
  if (has(/\bDV\b|\bDOLBY ?VISION\b/)) out.push('DV');
  var svc = ['AMZN', 'NF', 'DSNP', 'HMAX', 'ATVP', 'HULU', 'PCOK', 'CR'];
  for (var s = 0; s < svc.length; s++) {
    if (has(new RegExp('\\b' + svc[s] + '\\b'))) { out.push(svc[s]); break; }
  }
  if (has(/\bDUAL\b/)) out.push('DUAL');
  else if (has(/\bMULTI\b/)) out.push('MULTI');
  var seen = {}, res = [];
  for (var k = 0; k < out.length; k++) if (!seen[out[k]]) { seen[out[k]] = 1; res.push(out[k]); }
  return res.join(' ');
}

// Builds the Sources-sheet name, CloudStream-style:
//   "4K HDHub [FSL Server] [WEB-DL H265 DDP5.1 HDR10+ AMZN DUAL] [8.72 GB] 4K"
function _name(server, info) {
  var n = '4K HDHub [' + server + ']';
  if (info.tags) n += ' [' + info.tags + ']';
  if (info.size) n += ' [' + info.size + ']';
  if (info.res) n += ' ' + info.res;
  return n;
}

function _hubServer(link, label, info) {
  var server = _serverName(label);
  var name = _name(server, info);
  var q = info.quality;
  if (label.indexOf('buzzserver') !== -1 || label.indexOf('buzz') !== -1) {
    return fetch(link + '/download', {
      headers: { 'Referer': link, 'User-Agent': UA }, followRedirects: false
    }).then(function (r) {
      var h = (r.headers || {});
      var dl = h['hx-redirect'] || h['HX-Redirect'] || '';
      return dl ? _src(dl, q, name) : null;
    }).catch(function () { return null; });
  }
  if (label.indexOf('pixeldra') !== -1 || label.indexOf('pixel') !== -1) {
    var b = (link.match(/^(https?:\/\/[^/]+)/) || [])[1] || '';
    var fin = link.indexOf('download') !== -1 ? link
      : (b + '/api/file/' + link.replace(/\/$/, '').split('/').pop() + '?download');
    return Promise.resolve(_src(fin, q, name));
  }
  if (label.indexOf('fsl') !== -1 || label.indexOf('download file') !== -1 ||
      label.indexOf('s3 server') !== -1 || label.indexOf('mega') !== -1 ||
      label.indexOf('pdl') !== -1 || label.indexOf('10gbps') !== -1) {
    return Promise.resolve(_src(link, q, name));
  }
  // Unknown button — only keep if it already looks like a direct media file.
  if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(link)) return Promise.resolve(_src(link, q, name));
  return Promise.resolve(null);
}

// hubdrive → (hubcloud); hblinks → list → (hubcloud/hubdrive)
function _hubdrive(url) {
  return _get(url).then(function (html) {
    var href = (html.match(/class="[^"]*btn-success1[^"]*"[^>]*href="([^"]+)"/) ||
                html.match(/href="([^"]+)"[^>]*class="[^"]*btn-success1/) || [])[1] || '';
    if (href && href.toLowerCase().indexOf('hubcloud') !== -1) return _hubcloud(href);
    if (href) return _hubcloud(href);
    return [];
  }).catch(function () { return []; });
}
function _hblinks(url) {
  return _get(url).then(function (html) {
    var links = [], m; var re = /<a[^>]+href="([^"]+)"/g;
    while ((m = re.exec(html)) !== null) {
      var h = m[1].toLowerCase();
      if (h.indexOf('hubcloud') !== -1 || h.indexOf('hubdrive') !== -1) links.push(m[1]);
    }
    links = links.filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 4);
    return Promise.all(links.map(_dispatch)).then(function (ls) {
      return ls.reduce(function (a, b) { return a.concat(b || []); }, []);
    });
  }).catch(function () { return []; });
}

function _dispatch(link) {
  var l = String(link).toLowerCase();
  if (l.indexOf('hubcloud') !== -1) return _hubcloud(link);
  if (l.indexOf('hubdrive') !== -1) return _hubdrive(link);
  if (l.indexOf('hblinks') !== -1) return _hblinks(link);
  return Promise.resolve([]);
}

function getVideoSources(episodeUrl) {
  var hrefs = _epHrefs(episodeUrl).slice(0, 10);
  if (!hrefs.length) return Promise.reject(new Error('4K HDHub: no download links'));
  var jobs = hrefs.map(function (raw) {
    var p = raw.indexOf('id=') !== -1 ? _resolveRedirect(raw) : Promise.resolve(raw);
    return p.then(function (resolved) {
      if (!resolved) return [];
      return _dispatch(resolved);
    }).catch(function () { return []; });
  });
  return Promise.all(jobs).then(function (lists) {
    var out = [], seen = {};
    for (var i = 0; i < lists.length; i++) {
      var arr = lists[i] || [];
      for (var k = 0; k < arr.length; k++) {
        var s = arr[k];
        if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); }
      }
    }
    if (!out.length) throw new Error('4K HDHub: no playable links resolved');
    return out;
  });
}
