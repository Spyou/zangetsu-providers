// MoviesDrive — movie/series source for the Zangetsu provider repo.
//
// HTML-scraped catalog (regex) + a JSON search endpoint. Video chain:
//   page links (h5 > a)  ->  link-store page  ->  HubCloud / GDFlix
//   ->  file page  ->  direct files (FSL / Buzz / Pixeldrain / Cloud / 10Gbps).
// Domains (site + GDFlix) rotate, fetched once from the upstream list + cached.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'moviesdrive';

var DEFAULT_MAIN = 'https://moviesdrive.forum';
var URLS = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

var _urls = null;
function _loadUrls() {
  if (_urls) return Promise.resolve(_urls);
  return fetch(URLS, { headers: { 'User-Agent': UA } }).then(function (r) {
    try { _urls = JSON.parse(r.body || '{}'); } catch (e) { _urls = {}; }
    return _urls;
  }).catch(function () { _urls = {}; return _urls; });
}
function _main() {
  return _loadUrls().then(function (j) {
    return String(j['moviesdrive'] || DEFAULT_MAIN).replace(/\/$/, '');
  });
}

function getInfo() {
  return {
    name: 'MoviesDrive', lang: 'hi', baseUrl: DEFAULT_MAIN,
    logo: DEFAULT_MAIN + '/favicon.ico', type: 'movie', version: '1.0.1'
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
function _quality(s) { var m = String(s || '').match(/(\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }
function _uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { if (a[i] && !s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } } return o; }
// Use the host absUrl — QuickJS has no URL constructor, so `new URL()` throws
// there and would silently leave relative hrefs (e.g. search.php permalinks)
// unresolved, breaking detail loads from search.
function _abs(href, base) { return absUrl(href, base); }
function _baseOf(url) { return (String(url).match(/^(https?:\/\/[^/]+)/) || [])[1] || ''; }
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _cleanTitle(raw) {
  var t = htmlText(raw || '').replace(/^\s*download\s+/i, '');
  t = t.split(/\s*\(/)[0].split(/\bseason\b/i)[0].split(/\bS0?\d/)[0];
  return _trim(t) || _trim(htmlText(raw || ''));
}

// Cards: #moviesGridMain > a, each with a <p> title + <img> poster.
function _cards(html, main) {
  var out = [], seen = {};
  var gi = html.indexOf('moviesGridMain');
  var block = gi >= 0 ? html.slice(gi) : html;
  var re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, m;
  while ((m = re.exec(block)) !== null) {
    var href = m[1], inner = m[2];
    if (!/<img/i.test(inner)) continue;
    var title = _cleanTitle(
      (inner.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] ||
      (inner.match(/<img[^>]+alt="([^"]*)"/i) || [])[1] || '');
    if (!title) continue;
    var url = _abs(href, main);
    if (seen[url] || /\/(category|page|genre|tag)\//i.test(url)) continue; seen[url] = 1;
    var img = (inner.match(/<img[^>]+(?:data-src|data-lazy-src|src)="([^"]+)"/i) || [])[1] || null;
    out.push({
      id: url, title: title, cover: (img && img.indexOf('http') === 0) ? img : null,
      url: url, type: 'movie', sourceId: SOURCE_ID
    });
  }
  return out;
}

function getHome(opts) {
  var rows = [
    { title: 'Latest', path: '/page/1' },
    { title: 'Prime Video', path: '/category/amzn-prime-video/page/1' },
    { title: 'Netflix', path: '/category/netflix/page/1' },
    { title: 'Hotstar', path: '/category/hotstar/page/1' },
    { title: 'Anime', path: '/category/anime/page/1' },
    { title: 'K-Drama', path: '/category/k-drama/page/1' }
  ];
  return _main().then(function (main) {
    return Promise.all(rows.map(function (row) {
      return _get(main + row.path, main + '/').then(function (html) {
        return { title: row.title, items: _cards(html, main) };
      }).catch(function () { return { title: row.title, items: [] }; });
    }));
  }).catch(function () { return []; });
}

function search(query, page, opts) {
  return _main().then(function (main) {
    var u = main + '/search.php?q=' + encodeURIComponent(query || '') + '&page=' + (page || 1);
    return _get(u, main + '/').then(function (body) {
      var j = null; try { j = JSON.parse(body || 'null'); } catch (e) {}
      var hits = (j && j.hits) || [];
      var out = [];
      for (var i = 0; i < hits.length; i++) {
        var d = (hits[i] && hits[i].document) || {};
        var link = d.permalink; if (!link) continue;
        out.push({
          id: _abs(link, main), title: _cleanTitle(d.post_title || ''),
          cover: d.post_thumbnail || null, url: _abs(link, main),
          type: 'movie', sourceId: SOURCE_ID
        });
      }
      return out;
    });
  }).catch(function () { return []; });
}

// ── episode url packing (HubCloud/GDFlix or link-store hrefs) ────────────────
function _epUrl(links) { return 'mdrive://' + encodeURIComponent(JSON.stringify(links)); }
function _epLinks(url) {
  try { return JSON.parse(decodeURIComponent(String(url).replace(/^mdrive:\/\//, ''))); }
  catch (e) { return []; }
}
function _isHost(h) { return /hubcloud|gdflix|gdlink/i.test(String(h || '')); }

function getDetail(url, opts) {
  return _main().then(function (main) {
    var u = _abs(url, main);
    return _get(u, main + '/').then(function (html) {
      var title = _cleanTitle(
        (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] ||
        (html.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || 'Untitled');
      var poster = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] ||
        (html.match(/<main[^>]*>[\s\S]*?<p[^>]*>\s*<img[^>]+src="([^"]+)"/i) || [])[1] || null;
      var description = htmlText((html.match(/<meta name="description" content="([^"]+)"/) || [])[1] || '');
      var year = ((title.match(/\((19|20)\d{2}\)/) || [])[0] || '').replace(/[()]/g, '') || null;
      var isSeries = /season\s*\d+/i.test(title) || /\bseries\b/i.test(title) ||
        /\bEpisode\b/i.test(title) || /\bEp\d{2}\b/i.test(html);

      var base = {
        id: u, title: title, cover: poster, url: u, description: description,
        status: 'unknown', genres: [], studios: [], type: 'movie',
        sourceId: SOURCE_ID, year: year, subCount: 0, dubCount: 0, episodes: []
      };

      // h5 > a are the per-quality "link-store" pages.
      var h5 = [], m, re = /<h5[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((m = re.exec(html)) !== null) {
        if (/\bzip\b/i.test(htmlText(m[2]))) continue;
        var before = html.slice(Math.max(0, m.index - 300), m.index);
        var season = (before.match(/(?:Season |S)0?(\d+)(?![\s\S]*Season)/i) || [])[1];
        h5.push({ href: m[1], season: season ? parseInt(season, 10) : 1 });
      }

      if (!isSeries) {
        base.episodes = h5.length
          ? [{ id: 'movie', title: title, number: 1, url: _epUrl(h5.map(function (x) { return x.href; })) }]
          : [];
        base.subCount = base.episodes.length;
        return base;
      }
      return _seriesEpisodes(h5, main).then(function (eps) {
        base.episodes = eps;
        base.subCount = eps.length;
        return base;
      });
    });
  });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return d.episodes; });
}

// Each h5 link-store page lists episodes: "EpNN" markers followed by HubCloud /
// GDFlix anchors. Group by (season, episode).
function _seriesEpisodes(h5, main) {
  var jobs = h5.map(function (b) {
    return _get(b.href, main + '/').then(function (doc) {
      var eps = {}; // ep number -> [links]
      // Walk the doc, tracking the current "EpNN" then collecting host links.
      var tokens = doc.split(/(?=<a |<span |Ep\d{2})/i);
      var cur = 0;
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        var em = t.match(/Ep\s?(\d{1,3})/i);
        if (em) cur = parseInt(em[1], 10) || cur;
        var hm = t.match(/<a[^>]+href="([^"]+)"/i);
        if (hm && _isHost(hm[1])) {
          var n = cur || 1;
          (eps[n] || (eps[n] = [])).push(hm[1]);
        }
      }
      return { season: b.season, eps: eps };
    }).catch(function () { return { season: b.season, eps: {} }; });
  });
  return Promise.all(jobs).then(function (groups) {
    var byEp = {};
    groups.forEach(function (g) {
      Object.keys(g.eps).forEach(function (n) {
        var key = g.season + '|' + n;
        (byEp[key] || (byEp[key] = [])).push.apply(byEp[key], g.eps[n]);
      });
    });
    var out = [];
    Object.keys(byEp).forEach(function (key) {
      var p = key.split('|'); var s = parseInt(p[0], 10), e = parseInt(p[1], 10);
      out.push({ id: 'S' + s + 'E' + e, number: e, title: 'S' + s + ' E' + e, url: _epUrl(_uniq(byEp[key])) });
    });
    out.sort(function (a, b) {
      var as = a.id.match(/S(\d+)E(\d+)/), bs = b.id.match(/S(\d+)E(\d+)/);
      if (as && bs) { if (as[1] !== bs[1]) return as[1] - bs[1]; return as[2] - bs[2]; }
      return 0;
    });
    return out;
  });
}

// ── HubCloud + GDFlix resolution ──────────────────────────────────────────────
function _src(url, quality, label) {
  return {
    url: url, quality: quality || 'auto',
    container: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4',
    headers: { 'User-Agent': UA }, kind: 'sub', audioLang: '',
    subtitles: [], label: _trim(label || '')
  };
}
function _serverName(label) {
  if (label.indexOf('fsl') !== -1) return 'FSL Server';
  if (label.indexOf('buzz') !== -1) return 'Buzz Server';
  if (label.indexOf('pixeldra') !== -1 || label.indexOf('pixel') !== -1) return 'Pixeldrain';
  if (label.indexOf('s3') !== -1) return 'S3 Server';
  if (label.indexOf('10gb') !== -1) return '10Gbps';
  if (label.indexOf('mega') !== -1) return 'Mega';
  return 'Server';
}

// HubCloud: /drive page -> file page (card-header + btn buttons -> direct files).
function _hubcloud(url) {
  var base = _baseOf(url);
  var step1 = /hubcloud\.\w+\/(?:drive|video)/i.test(url) || url.indexOf('hubcloud.php') !== -1
    ? Promise.resolve(url)
    : _get(url).then(function (html) {
        var raw = (html.match(/id=["']download["'][^>]*href="([^"]+)"/i) ||
                   html.match(/href="([^"]+)"[^>]*id=["']download["']/i) ||
                   html.match(/<a[^>]+class="[^"]*btn[^"]*"[^>]+href="([^"]+)"/i) || [])[1] || '';
        return raw ? (/^https?:/i.test(raw) ? raw : base + '/' + raw.replace(/^\//, '')) : '';
      });
  return step1.then(function (href) {
    if (!href) return [];
    return _get(href).then(function (doc) {
      var header = htmlText((doc.match(/<div class="card-header[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
      var size = htmlText((doc.match(/id=["']size["'][^>]*>([\s\S]*?)<\//i) || [])[1] || '');
      var quality = _quality(header) || _quality(url) || '1080p';
      var suffix = (header ? ' [' + header.slice(0, 55) + ']' : '') + (size ? ' [' + size + ']' : '');
      var jobs = [], m, re = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<a[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re.exec(doc)) !== null) {
        var blink = m[1] || m[3]; var text = htmlText(m[2] || m[4] || '').toLowerCase();
        if (blink) jobs.push(_hubServer(blink, text, quality, suffix));
      }
      return Promise.all(jobs).then(function (ls) {
        var out = []; for (var i = 0; i < ls.length; i++) if (ls[i]) out.push(ls[i]); return out;
      });
    });
  }).catch(function () { return []; });
}
function _hubServer(link, label, quality, suffix) {
  if (/gofile|gdtot|filepress/i.test(link)) return Promise.resolve(null);
  var name = 'MoviesDrive [' + _serverName(label) + ']' + suffix;
  if (label.indexOf('buzz') !== -1) {
    return fetch(link + '/download', { headers: { 'Referer': link, 'User-Agent': UA }, followRedirects: false })
      .then(function (r) { var h = r.headers || {}; var dl = h['hx-redirect'] || h['HX-Redirect'] || ''; return dl ? _src(_baseOf(link) + dl, quality, name) : null; })
      .catch(function () { return null; });
  }
  if (label.indexOf('pixeldra') !== -1 || label.indexOf('pixel') !== -1) {
    var b = _baseOf(link);
    var fin = link.indexOf('download') !== -1 ? link : (b + '/api/file/' + link.replace(/\/$/, '').split('/').pop() + '?download');
    return Promise.resolve(_src(fin, quality, name));
  }
  if (label.indexOf('fsl') !== -1 || label.indexOf('download') !== -1 || label.indexOf('s3') !== -1 ||
      label.indexOf('mega') !== -1 || label.indexOf('10gb') !== -1) {
    return Promise.resolve(_src(link, quality, name));
  }
  if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(link)) return Promise.resolve(_src(link, quality, name));
  return Promise.resolve(null);
}

// GDFlix: file page with a `div.text-center` button list.
function _gdflixBase(url) {
  var base = _baseOf(url);
  return _loadUrls().then(function (j) {
    var latest = j['gdflix']; return (latest && latest.replace(/\/$/, '')) || base;
  }).catch(function () { return base; });
}
function _gdflix(url) {
  return _gdflixBase(url).then(function (latest) {
    var base = _baseOf(url);
    var newUrl = (latest && base && latest !== base) ? url.replace(base, latest) : url;
    var b = _baseOf(newUrl);
    return _get(newUrl).then(function (doc) {
      var fileName = _trim((doc.match(/list-group-item[^>]*>\s*Name\s*:\s*([\s\S]*?)<\//i) || [])[1] || '');
      var size = _trim((doc.match(/list-group-item[^>]*>\s*Size\s*:\s*([\s\S]*?)<\//i) || [])[1] || '');
      var quality = _quality(fileName) || _quality(url) || '1080p';
      var suffix = (fileName ? ' [' + fileName.slice(0, 55) + ']' : '') + (size ? ' [' + size + ']' : '');
      var jobs = [], m, re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re.exec(doc)) !== null) {
        var link = m[1], text = htmlText(m[2]);
        if (link && link !== '#') jobs.push(_gdServer(link, text, b, quality, suffix));
      }
      return Promise.all(jobs).then(function (ls) {
        var out = []; for (var i = 0; i < ls.length; i++) if (ls[i]) out.push(ls[i]); return out;
      });
    });
  }).catch(function () { return []; });
}
function _gdServer(link, text, base, quality, suffix) {
  var t = (text || '').toUpperCase();
  if (/gofile|gdtot|filepress/i.test(link)) return Promise.resolve(null);
  var name = function (srv) { return 'MoviesDrive [' + srv + ']' + suffix; };
  if (t.indexOf('FSL V2') !== -1) return Promise.resolve(_src(link, quality, name('FSL V2')));
  if (t.indexOf('DIRECT') !== -1) return Promise.resolve(_src(link, quality, name('Direct')));
  if (t.indexOf('CLOUD DOWNLOAD') !== -1 || t.indexOf('[R2]') !== -1) return Promise.resolve(_src(link, quality, name('Cloud')));
  if (/pixeldra/i.test(link)) {
    var pb = _baseOf(link);
    var fin = /download/i.test(link) ? link : (pb + '/api/file/' + link.replace(/\/$/, '').split('/').pop() + '?download');
    return Promise.resolve(_src(fin, quality, name('Pixeldrain')));
  }
  if (t.indexOf('FAST CLOUD') !== -1) {
    var fc = /^https?:/i.test(link) ? link : (base + link);
    return _get(fc).then(function (d2) {
      var dl = (d2.match(/<div class="card-body"[\s\S]*?<a[^>]+href="([^"]+)"/i) || [])[1] || '';
      return dl ? _src(dl, quality, name('Fast Cloud')) : null;
    }).catch(function () { return null; });
  }
  if (t.indexOf('INSTANT') !== -1) {
    var il = /^https?:/i.test(link) ? link : (base + link);
    return fetch(il, { headers: { 'User-Agent': UA }, followRedirects: false }).then(function (r) {
      var loc = (r.headers && (r.headers['location'] || r.headers['Location'])) || '';
      var fin2 = loc.indexOf('url=') !== -1 ? loc.split('url=').pop() : loc;
      return fin2 ? _src(fin2, quality, name('Instant')) : null;
    }).catch(function () { return null; });
  }
  return Promise.resolve(null);
}

function _resolve(link) {
  if (/hubcloud/i.test(link)) return _hubcloud(link);
  if (/gdflix|gdlink/i.test(link)) return _gdflix(link);
  return Promise.resolve([]);
}

// Hosts with no HTTP range support (seeking loops) → ordered last.
function _noRange(url) { return /googleusercontent|pages\.dev/i.test(String(url)); }

function getVideoSources(episodeUrl) {
  var links = _epLinks(episodeUrl).slice(0, 12);
  if (!links.length) return Promise.reject(new Error('MoviesDrive: no links'));
  return _loadUrls().then(function () {
    var jobs = links.map(function (link) {
      if (_isHost(link)) return _resolve(link);
      // A link-store page (movie case) → find HubCloud/GDFlix links → resolve.
      return _get(link).then(function (html) {
        var hosts = [], m, re = /<a[^>]+href="([^"]+)"/g;
        while ((m = re.exec(html)) !== null) { if (_isHost(m[1])) hosts.push(m[1]); }
        return Promise.all(_uniq(hosts).slice(0, 6).map(_resolve)).then(function (ls) {
          return ls.reduce(function (a, b) { return a.concat(b || []); }, []);
        });
      }).catch(function () { return []; });
    });
    return Promise.all(jobs).then(function (lists) {
      var out = [], seen = {};
      lists.forEach(function (l) { (l || []).forEach(function (s) { if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); } }); });
      // Drop HubCloud landing hosts (gamerxyt/winexch/etc.) — they serve HTML,
      // not a video — so only real direct files remain.
      out = out.filter(function (s) {
        return !/gamerxyt|winexch|hubcloud\.|hubdrive\.|gdflix\.\w+\/?$/i.test(s.url);
      });
      if (!out.length) throw new Error('MoviesDrive: no playable sources');
      var good = [], bad = [];
      for (var i = 0; i < out.length; i++) (_noRange(out[i].url) ? bad : good).push(out[i]);
      return good.concat(bad);
    });
  });
}
