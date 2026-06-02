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
    logo: 'https://4khdhub.link/favicon.ico', type: 'movie', version: '1.0.0'
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

function getDetail(url, opts) {
  return _domains().then(function (d) {
    return _get(url, d.main + '/').then(function (html) {
      var title = _trim((html.match(/<h1[^>]*class="page-title"[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '')
        .replace(/<[^>]*>/g, '').split('(')[0];
      title = _trim(title) || _trim((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || 'Untitled');
      var poster = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || null;
      var description = htmlText((html.match(/class="content-section"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) || [])[1]
        || (html.match(/<meta name="description" content="([^"]+)"/) || [])[1] || '');
      var year = (html.match(/\b(19|20)\d{2}\b/) || [])[0] || null;
      var tags = [];
      var tm; var tre = /class="badge[^"]*"[^>]*>([^<]+)</g;
      while ((tm = tre.exec(html)) !== null) tags.push(_trim(tm[1]));
      var isSeries = /season-item|episode-download-item/i.test(html) || tags.join(' ').toLowerCase().indexOf('series') !== -1;

      var episodes = isSeries ? _seriesEpisodes(html) : _movieEpisode(html, title);

      return {
        id: url, title: title, cover: poster, url: url, description: description,
        status: 'unknown', genres: tags.slice(0, 6), studios: [],
        type: 'movie', sourceId: SOURCE_ID, episodes: episodes, year: year,
        subCount: episodes.length, dubCount: 0
      };
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
  var eps = [], m;
  // Each episode-download-item: a badge "Episode-0N" + its download <a> hrefs.
  var re = /episode-download-item[\s\S]*?(?=episode-download-item|season-item|<\/div>\s*<\/div>\s*<\/div>|$)/g;
  var blocks = html.match(re) || [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    var num = (b.match(/Episode[-\s]0*([1-9][0-9]*)/i) || [])[1];
    if (!num) continue;
    var hrefs = [], hm; var hre = /<a[^>]+href="([^"]+)"/g;
    while ((hm = hre.exec(b)) !== null) {
      if (/hubcloud|hubdrive|hblinks|hubcdn|id=/i.test(hm[1])) hrefs.push(hm[1]);
    }
    hrefs = hrefs.filter(function (v, j, a) { return a.indexOf(v) === j; });
    if (hrefs.length) eps.push({ id: 'ep:' + num, title: 'Episode ' + num, number: parseFloat(num), url: _epUrl(hrefs) });
  }
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
      var header = htmlText((doc.match(/class="card-header"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
      var size = htmlText((doc.match(/id=["']size["'][^>]*>([\s\S]*?)<\//) || [])[1] || '');
      var quality = _quality(header) || '2160p';
      var label = (header ? ('[' + header + ']') : '') + (size ? ('[' + size + ']') : '');
      var jobs = [], m;
      var re = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<a[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re.exec(doc)) !== null) {
        var link = m[1] || m[3]; var text = htmlText(m[2] || m[4] || '').toLowerCase();
        if (!link) continue;
        jobs.push(_hubServer(link, text, quality, label));
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

function _hubServer(link, label, quality, extra) {
  if (label.indexOf('buzzserver') !== -1) {
    return fetch(link + '/download', {
      headers: { 'Referer': link, 'User-Agent': UA }, followRedirects: false
    }).then(function (r) {
      var h = (r.headers || {});
      var dl = h['hx-redirect'] || h['HX-Redirect'] || '';
      return dl ? _src(dl, quality, 'Buzz ' + extra) : null;
    }).catch(function () { return null; });
  }
  if (label.indexOf('pixeldra') !== -1 || label.indexOf('pixel') !== -1) {
    var b = (link.match(/^(https?:\/\/[^/]+)/) || [])[1] || '';
    var fin = link.indexOf('download') !== -1 ? link
      : (b + '/api/file/' + link.replace(/\/$/, '').split('/').pop() + '?download');
    return Promise.resolve(_src(fin, quality, 'Pixeldrain ' + extra));
  }
  if (label.indexOf('fsl') !== -1 || label.indexOf('download file') !== -1 ||
      label.indexOf('s3 server') !== -1 || label.indexOf('mega') !== -1 ||
      label.indexOf('pdl') !== -1 || label.indexOf('10gbps') !== -1) {
    return Promise.resolve(_src(link, quality, extra));
  }
  // Unknown button — only keep if it already looks like a direct media file.
  if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(link)) return Promise.resolve(_src(link, quality, extra));
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
  var hrefs = _epHrefs(episodeUrl).slice(0, 6);
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
