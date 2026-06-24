// BollyFlix — movie/series source for the Zangetsu provider repo.
//
// HTML-scraped catalog (regex; no DOM parser in the runtime). Video chain:
//   page download links (?id=)  ->  id-bypass (sidexfee)  ->  GDFlix / fastdl
//   ->  GDFlix file page  ->  direct files (FSL V2 / Direct / Cloud R2 /
//   Instant / Pixeldrain). Domains (site + GDFlix) rotate, fetched once from
//   the upstream list and cached.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'bollyflix';

var DEFAULT_MAIN = 'https://bollyflix.med';
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
    return String(j['bollyflix'] || DEFAULT_MAIN).replace(/\/$/, '');
  });
}

function getInfo() {
  return {
    name: 'BollyFlix', lang: 'hi', baseUrl: DEFAULT_MAIN,
    logo: DEFAULT_MAIN + '/favicon.ico', type: 'movie', version: '1.0.4'
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
function _quality(s) { var m = String(s || '').match(/(\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }
function _uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { if (a[i] && !s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } } return o; }
// Use the host absUrl — QuickJS has no URL constructor, so `new URL()` throws
// there and would silently leave relative hrefs unresolved.
function _abs(href, base) { return absUrl(href, base); }
function _baseOf(url) { return (String(url).match(/^(https?:\/\/[^/]+)/) || [])[1] || ''; }
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
// CF-gated GET — route through the native WebView solver (browser:true) for
// hosts behind Cloudflare bot-protection (fastdlserver, gdflix) that 403 a plain
// HTTP client while letting a real browser through. With browser:true we must
// NOT send our own User-Agent — the bridge uses the solver's UA, which the
// cf_clearance is bound to.
function _cfGet(url) {
  return fetch(url, { browser: true })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _b64decode(s) {
  try {
    var b = base64ToBytes(String(s || '')); var o = '';
    for (var i = 0; i < b.length; i++) o += String.fromCharCode(b[i]);
    return o;
  } catch (e) { return ''; }
}
function _cleanTitle(raw) {
  var t = htmlText(raw || '').replace(/^\s*download\s+/i, '');
  t = t.split(/\s*\(/)[0].split(/\bseason\b/i)[0].split(/\bS0?\d/)[0];
  return _trim(t) || _trim(htmlText(raw || ''));
}

// Cards: div.post-cards > article, each an <a title=… href=…> with an <img>.
function _cards(html, main) {
  var out = [], seen = {};
  var parts = String(html || '').split(/<article/i);
  for (var i = 1; i < parts.length; i++) {
    var c = parts[i];
    var href = (c.match(/<a[^>]+href="([^"]+)"/i) || [])[1];
    if (!href) continue;
    var title = _cleanTitle(
      (c.match(/<a[^>]+title="([^"]+)"/i) || [])[1] ||
      (c.match(/<img[^>]+alt="([^"]+)"/i) || [])[1] || '');
    if (!title) continue;
    var url = _abs(href, main);
    if (seen[url] || /\/(category|page|genre|tag)\//i.test(url)) continue; seen[url] = 1;
    var img = (c.match(/<img[^>]+(?:data-src|data-lazy-src|src)="([^"]+)"/i) || [])[1] || null;
    out.push({
      id: url, title: title, cover: img ? _abs(img, main) : null,
      url: url, type: 'movie', sourceId: SOURCE_ID
    });
  }
  return out;
}

function getHome(opts) {
  var rows = [
    { title: 'Latest', path: '/' },
    { title: 'Bollywood Movies', path: '/movies/bollywood/' },
    { title: 'Hollywood Movies', path: '/movies/hollywood/' },
    { title: 'Anime', path: '/anime/' }
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
    var u = main + '/search/' + encodeURIComponent(query || '') + '/page/' + (page || 1) + '/';
    return _get(u, main + '/').then(function (html) { return _cards(html, main); });
  }).catch(function () { return []; });
}

// ── episode url packing (final download urls: gdflix/fastdl/…) ────────────────
function _epUrl(links) { return 'bolly://' + encodeURIComponent(JSON.stringify(links)); }
function _epLinks(url) {
  try { return JSON.parse(decodeURIComponent(String(url).replace(/^bolly:\/\//, ''))); }
  catch (e) { return []; }
}

// `?id=` links go through the sidexfee id-bypass to a real download url.
function _bypass(href) {
  if (href.indexOf('fastdlserver') !== -1 || href.indexOf('?id=') === -1) {
    return Promise.resolve(href);
  }
  var id = href.split('id=').pop();
  return _get('https://web.sidexfee.com/?id=' + id, href).then(function (txt) {
    var enc = (txt.match(/"link":"([^"]+)"/) || [])[1] || '';
    var dec = _b64decode(enc.replace(/\\\//g, '/'));
    return dec || href;
  }).catch(function () { return href; });
}

function getDetail(url, opts) {
  return _main().then(function (main) {
    var u = _abs(url, main);
    return _get(u, main + '/').then(function (html) {
      var title = _cleanTitle(
        (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] ||
        (html.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || 'Untitled');
      var poster = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || null;
      var description = htmlText((html.match(/id=["']summary["'][^>]*>([\s\S]*?)<\//) || [])[1] || '');
      var year = ((title.match(/\((19|20)\d{2}\)/) || [])[0] || '').replace(/[()]/g, '') || null;
      var isSeries = /series/i.test(title) || /web-series/i.test(u) ||
        /(?:Season|Episode)\s*0?\d/i.test(html);

      var base = {
        id: u, title: title, cover: poster, url: u, description: description,
        status: 'unknown', genres: [], studios: [], type: 'movie',
        sourceId: SOURCE_ID, year: year, subCount: 0, dubCount: 0, episodes: []
      };

      if (!isSeries) {
        // Movie: a.dl links → bypass → final urls, packed into one episode.
        var dl = [], m, re = /<a[^>]+class="[^"]*\bdl\b[^"]*"[^>]+href="([^"]+)"|<a[^>]+href="([^"]+)"[^>]*class="[^"]*\bdl\b[^"]*"/g;
        while ((m = re.exec(html)) !== null) { var h = m[1] || m[2]; if (h) dl.push(h); }
        dl = _uniq(dl);
        return Promise.all(dl.map(_bypass)).then(function (finals) {
          base.episodes = finals.length
            ? [{ id: 'movie', title: title, number: 1, url: _epUrl(_uniq(finals)) }]
            : [];
          base.subCount = base.episodes.length;
          return base;
        });
      }
      return _seriesEpisodes(html, main).then(function (eps) {
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

// Series: each quality button (maxbutton/dl/btnn) → bypass → a season page
// whose `h3 > a` are the per-episode links (skip Zip). Group by (season, index).
function _seriesEpisodes(html, main) {
  var btns = [], m;
  var re = /<a[^>]+class="[^"]*(?:maxbutton-download-links|btnn|\bdl\b)[^"]*"[^>]+href="([^"]+)"|<a[^>]+href="([^"]+)"[^>]*class="[^"]*(?:maxbutton-download-links|btnn|\bdl\b)[^"]*"/g;
  // Capture each button + a slice of preceding html (for the season label).
  while ((m = re.exec(html)) !== null) {
    var href = m[1] || m[2]; if (!href) continue;
    var before = html.slice(Math.max(0, m.index - 400), m.index);
    var season = (before.match(/(?:Season |S)0?(\d+)(?![\s\S]*Season)/i) || [])[1];
    btns.push({ href: href, season: season ? parseInt(season, 10) : 1 });
  }
  var jobs = btns.map(function (b) {
    return _bypass(b.href).then(function (link) {
      return _get(link, main + '/').then(function (doc) {
        var eps = [], em, ere = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        while ((em = ere.exec(doc)) !== null) {
          if (/\bzip\b/i.test(htmlText(em[2]))) continue;
          eps.push(em[1]);
        }
        return { season: b.season, links: _uniq(eps) };
      }).catch(function () { return { season: b.season, links: [] }; });
    });
  });
  return Promise.all(jobs).then(function (groups) {
    var byEp = {};
    groups.forEach(function (g) {
      for (var i = 0; i < g.links.length; i++) {
        var key = g.season + '|' + (i + 1);
        (byEp[key] || (byEp[key] = [])).push(g.links[i]);
      }
    });
    var out = [];
    Object.keys(byEp).forEach(function (key) {
      var p = key.split('|'); var s = parseInt(p[0], 10), e = parseInt(p[1], 10);
      out.push({ id: 'S' + s + 'E' + e, number: e, title: 'S' + s + ' E' + e, url: _epUrl(byEp[key]) });
    });
    out.sort(function (a, b) {
      var as = a.id.match(/S(\d+)E(\d+)/), bs = b.id.match(/S(\d+)E(\d+)/);
      if (as && bs) { if (as[1] !== bs[1]) return as[1] - bs[1]; return as[2] - bs[2]; }
      return 0;
    });
    return out;
  });
}

// ── GDFlix / fastdl resolution ────────────────────────────────────────────────
function _src(url, quality, label) {
  return {
    url: url, quality: quality || 'auto',
    container: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4',
    headers: { 'User-Agent': UA }, kind: 'sub', audioLang: '',
    subtitles: [], label: _trim(label || '')
  };
}

function _gdflixBase(url) {
  var base = _baseOf(url);
  return _loadUrls().then(function (j) {
    var latest = j['gdflix'];
    return (latest && latest.replace(/\/$/, '')) || base;
  }).catch(function () { return base; });
}

function _gdflix(url) {
  return _gdflixBase(url).then(function (latest) {
    var base = _baseOf(url);
    var newUrl = (latest && base && latest !== base) ? url.replace(base, latest) : url;
    var b = _baseOf(newUrl);
    return _cfGet(newUrl).then(function (doc) {
      var fileName = _trim((doc.match(/list-group-item[^>]*>\s*Name\s*:\s*([\s\S]*?)<\//i) || [])[1] || '');
      var size = _trim((doc.match(/list-group-item[^>]*>\s*Size\s*:\s*([\s\S]*?)<\//i) || [])[1] || '');
      var quality = _quality(fileName) || _quality(url) || '1080p';
      var suffix = (fileName ? ' [' + fileName.slice(0, 55) + ']' : '') + (size ? ' [' + size + ']' : '');

      // Buttons live under div.text-center.
      var jobs = [], m;
      var re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re.exec(doc)) !== null) {
        var link = m[1], text = htmlText(m[2]);
        if (!link || link === '#') continue;
        jobs.push(_gdServer(link, text, b, quality, suffix));
      }
      return Promise.all(jobs).then(function (lists) {
        var out = []; for (var i = 0; i < lists.length; i++) if (lists[i]) out.push(lists[i]);
        return out;
      });
    });
  }).catch(function () { return []; });
}

function _gdServer(link, text, base, quality, suffix) {
  var t = (text || '').toUpperCase();
  var name = function (srv) { return 'BollyFlix [' + srv + ']' + suffix; };
  if (/gofile|gdtot|filepress/i.test(link)) return Promise.resolve(null);

  if (t.indexOf('FSL V2') !== -1) return Promise.resolve(_src(link, quality, name('FSL V2')));
  if (t.indexOf('DIRECT') !== -1) return Promise.resolve(_src(link, quality, name('Direct')));
  if (t.indexOf('CLOUD DOWNLOAD') !== -1 || t.indexOf('[R2]') !== -1) {
    return Promise.resolve(_src(link, quality, name('Cloud')));
  }
  if (/pixeldra/i.test(link)) {
    var pb = _baseOf(link);
    var fin = /download/i.test(link) ? link : (pb + '/api/file/' + link.replace(/\/$/, '').split('/').pop() + '?download');
    return Promise.resolve(_src(fin, quality, name('Pixeldrain')));
  }
  if (t.indexOf('FAST CLOUD') !== -1) {
    var fc = /^https?:/i.test(link) ? link : (base + link);
    return _cfGet(fc).then(function (d2) {
      var dl = (d2.match(/<div class="card-body"[\s\S]*?<a[^>]+href="([^"]+)"/i) || [])[1] || '';
      return dl ? _src(dl, quality, name('Fast Cloud')) : null;
    }).catch(function () { return null; });
  }
  if (t.indexOf('INSTANT') !== -1) {
    var il = /^https?:/i.test(link) ? link : (base + link);
    return fetch(il, { browser: true, followRedirects: false }).then(function (r) {
      var loc = (r.headers && (r.headers['location'] || r.headers['Location'])) || '';
      var fin2 = loc.indexOf('url=') !== -1 ? loc.split('url=').pop() : loc;
      return fin2 ? _src(fin2, quality, name('Instant')) : null;
    }).catch(function () { return null; });
  }
  return Promise.resolve(null);
}

function _fastdl(url) {
  // fastdlserver is behind Cloudflare bot-protection (403s a plain client) — go
  // through the WebView CF solver. browser:true ⇒ no manual User-Agent.
  return fetch(url, { browser: true, followRedirects: false }).then(function (r) {
    var loc = (r.headers && (r.headers['location'] || r.headers['Location'])) || '';
    if (!loc) return [];
    if (/gdflix|gdlink/i.test(loc)) return _gdflix(loc);
    if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(loc)) return [_src(loc, _quality(url) || '1080p', 'BollyFlix [Fast]')];
    return [];
  }).catch(function () { return []; });
}

// Hosts that serve the whole file with no HTTP range support (seeking loops).
function _noRange(url) { return /googleusercontent|pages\.dev/i.test(String(url)); }
function _seekableFirst(list) {
  var good = [], bad = [];
  for (var i = 0; i < list.length; i++) (_noRange(list[i].url) ? bad : good).push(list[i]);
  return good.concat(bad);
}

function getVideoSources(episodeUrl) {
  var links = _epLinks(episodeUrl).slice(0, 12);
  if (!links.length) return Promise.reject(new Error('BollyFlix: no links'));
  return _loadUrls().then(function () {
    var jobs = links.map(function (link) {
      if (/gdflix|gdlink/i.test(link)) return _gdflix(link);
      if (/fastdlserver/i.test(link)) return _fastdl(link);
      // Unknown — try as a GDFlix page (many bypassed links land there).
      if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(link)) return Promise.resolve([_src(link, '1080p', 'BollyFlix')]);
      return Promise.resolve([]);
    });
    return Promise.all(jobs).then(function (lists) {
      var out = [], seen = {};
      lists.forEach(function (l) {
        (l || []).forEach(function (s) {
          if (!s || !s.url || seen[s.url]) return;
          // Drop nav/footer links that slipped through (about-us, etc.).
          if (/\/(about|contact|dmca|disclaimer|privacy|terms)(-us)?\/?($|\?)/i.test(s.url)) return;
          seen[s.url] = 1; out.push(s);
        });
      });
      if (!out.length) throw new Error('BollyFlix: no playable sources');
      // Seekable mirrors first so the player defaults to one that supports HTTP
      // range requests (Google-download / *.pages.dev proxies serve the whole
      // file with no ranges → seeking loops forever). Order is otherwise kept,
      // and the player re-sorts by quality (stable), so the top quality lands
      // on a seekable host.
      return _seekableFirst(out);
    });
  });
}
