// UHD Movies — movie/series source for the Zangetsu provider repo.
//
// HTML-scraped catalog (regex; no DOM parser in the runtime). Video chain:
//   page  →  maxbutton links  →  hrefli/unblockedgames SID bypass (3-step
//   form POST)  →  driveseed / driveleech  →  direct file (Instant Download /
//   Resume Cloud / Resume Worker Bot / Direct Links / Cloud Download).
// No host-side extractor needed.
//
// Domains rotate, so the live domain is fetched once from the shared upstream
// list and cached; everything falls back to sane defaults.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'uhdmovies';

var URLS = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';
var DEFAULT_MAIN = 'https://uhdmovies.food';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

var _dom = null;
function _domains() {
  if (_dom) return Promise.resolve(_dom);
  return fetch(URLS, { headers: { 'User-Agent': UA } }).then(function (r) {
    var j = {}; try { j = JSON.parse(r.body || '{}'); } catch (e) {}
    _dom = { main: String(j['uhdmovies'] || DEFAULT_MAIN).replace(/\/$/, '') };
    return _dom;
  }).catch(function () {
    _dom = { main: DEFAULT_MAIN };
    return _dom;
  });
}

function getInfo() {
  return {
    name: 'UHD Movies', lang: 'en', baseUrl: DEFAULT_MAIN,
    logo: DEFAULT_MAIN + '/favicon.ico', type: 'movie', version: '1.0.2'
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _quality(s) { var m = String(s || '').match(/(\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }
function _uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { if (!s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } } return o; }

// Strip "Download " + trailing "(year)/Season/quality" junk to a clean title.
function _cleanTitle(raw) {
  var t = htmlText(raw || '').replace(/^\s*download\s+/i, '');
  t = t.split(/\s*\(/)[0].split(/\bseason\b/i)[0].split(/\bS0?\d/)[0];
  return _trim(t) || _trim(htmlText(raw || ''));
}

// Parse `article.gridlove-post` cards out of raw HTML.
function _cards(html, main) {
  var out = [], seen = {};
  var parts = String(html || '').split(/<article[^>]*class="[^"]*gridlove-post/i);
  for (var i = 1; i < parts.length; i++) {
    var c = parts[i];
    var href = (c.match(/class="entry-image"[\s\S]*?<a[^>]+href="([^"]+)"/i) ||
                c.match(/<a[^>]+href="([^"]+)"/i) || [])[1];
    if (!href) continue;
    var url = absUrl(href, main);
    if (seen[url]) continue; seen[url] = 1;
    var rawTitle = (c.match(/<h1[^>]*class="[^"]*sanket[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
                    c.match(/<img[^>]+alt="([^"]+)"/i) ||
                    c.match(/<a[^>]+title="([^"]+)"/i) || [])[1] || '';
    var img = (c.match(/<img[^>]+(?:data-lazy-src|data-src|src)="([^"]+)"/i) || [])[1] || null;
    out.push({
      id: url, title: _cleanTitle(rawTitle) || 'Untitled',
      cover: img ? absUrl(img, main) : null, url: url, type: 'movie', sourceId: SOURCE_ID
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
    { title: 'Latest', path: '/' },
    { title: 'Movies', path: '/movies/' },
    { title: 'Web Series', path: '/web-series/' },
    { title: '4K HDR', path: '/4k-hdr/' },
    { title: 'Netflix', path: '/tv-shows/netflix/' }
  ];
  return _domains().then(function (d) {
    return Promise.all(rows.map(function (row) {
      return _get(d.main + row.path, d.main + '/').then(function (html) {
        return { title: row.title, items: _cards(html, d.main) };
      }).catch(function () { return { title: row.title, items: [] }; });
    }));
  }).catch(function () { return []; });
}

// Opaque episode url packing a list of redirector hrefs (resolved lazily).
function _epUrl(hrefs) { return 'uhd://' + encodeURIComponent(JSON.stringify(hrefs)); }
function _epHrefs(url) {
  try { return JSON.parse(decodeURIComponent(String(url).replace(/^uhd:\/\//, ''))); }
  catch (e) { return []; }
}

// ── TMDB enrichment (keyless proxy) — UHDMovies posts only expose release
// filenames, so plot/genres/poster + episode names/stills come from TMDB. ──
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
          var dt = (res[i].first_air_date || res[i].release_date || '');
          if (dt.slice(0, 4) === String(year)) return res[i].id;
        }
      }
      return res[0].id;
    });
}

// Anchors that point at a download redirector / file host (vs. nav/social).
function _isLink(h) {
  return /unblockedgames|hrefli|href\.li|driveseed|driveleech|drive\.|video-seed|video-leech|gdflix|gdtot|filepress|\?go=|\/go\b|maxbutton/i.test(h);
}

// Movie: bundle every quality's redirector href into one episode.
function _movieEpisode(html, title) {
  var hrefs = [], m;
  var re = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*maxbutton[^"]*"|<a[^>]+class="[^"]*maxbutton[^"]*"[^>]+href="([^"]+)"/gi;
  while ((m = re.exec(html)) !== null) { var h = m[1] || m[2]; if (h) hrefs.push(h); }
  if (!hrefs.length) {
    var re2 = /<a[^>]+href="([^"]+)"/gi;
    while ((m = re2.exec(html)) !== null) { if (_isLink(m[1])) hrefs.push(m[1]); }
  }
  hrefs = _uniq(hrefs);
  if (!hrefs.length) return [];
  return [{ id: 'movie', title: title || 'Movie', number: 1, url: _epUrl(hrefs) }];
}

// Series: walk anchors in document order, tracking the current season from the
// nearest preceding "Season N" marker; group hrefs by (season, episode).
function _seriesEpisodes(html) {
  var seasons = [], sm, sre = /season\s*0*(\d{1,2})/gi;
  while ((sm = sre.exec(html)) !== null) seasons.push({ idx: sm.index, s: parseInt(sm[1], 10) });
  var map = {}, order = [], am, are = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((am = are.exec(html)) !== null) {
    var href = am[1], txt = htmlText(am[2]);
    if (!/episode/i.test(txt) || /\bzip\b/i.test(txt)) continue;
    var em = txt.match(/episode\s*0*(\d{1,3})/i); if (!em) continue;
    var ep = parseInt(em[1], 10);
    var season = 1;
    for (var i = 0; i < seasons.length; i++) { if (seasons[i].idx < am.index) season = seasons[i].s; else break; }
    var key = season + '|' + ep;
    if (!map[key]) { map[key] = { s: season, e: ep, hrefs: [] }; order.push(key); }
    if (map[key].hrefs.indexOf(href) === -1) map[key].hrefs.push(href);
  }
  order.sort(function (a, b) { var x = map[a], y = map[b]; return x.s !== y.s ? x.s - y.s : x.e - y.e; });
  var eps = order.map(function (key) {
    var o = map[key];
    return { id: 'S' + o.s + 'E' + o.e, number: o.e,
      title: 'S' + o.s + ' E' + o.e + ' - Episode ' + o.e, url: _epUrl(o.hrefs) };
  });
  if (!eps.length) return _movieEpisode(html, 'Full');
  return eps;
}

function getDetail(url, opts) {
  return _domains().then(function (d) {
    return _get(url, d.main + '/').then(function (html) {
      var rawTitle = (html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
                      html.match(/<meta property="og:title" content="([^"]+)"/i) || [])[1] || 'Untitled';
      var title = _cleanTitle(rawTitle);
      var poster = (html.match(/<div class="entry-content"[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"/i) ||
                    html.match(/<meta property="og:image" content="([^"]+)"/i) || [])[1] || null;
      var description = htmlText((html.match(/<meta name="description" content="([^"]+)"/i) || [])[1] || '');
      var year = (htmlText(rawTitle).match(/\((19|20)(\d{2})\)/) || [])[0];
      year = year ? year.replace(/[()]/g, '') : ((html.match(/\b(19|20)\d{2}\b/) || [])[0] || null);
      var tags = [];
      var tm, tre = /class="[^"]*gridlove-cat[^"]*"[^>]*>([^<]+)</gi;
      while ((tm = tre.exec(html)) !== null) tags.push(_trim(htmlText(tm[1])));
      var isSeries = /\bseason\b|\bS0?\d+\b|episode/i.test(htmlText(rawTitle)) || /:contains|episode\s*0*\d/i.test(html) && /season/i.test(html);
      isSeries = /\bseason\b|\bS0?\d/i.test(htmlText(rawTitle));
      var episodes = isSeries ? _seriesEpisodes(html) : _movieEpisode(html, title);

      var base = {
        id: url, title: title, cover: poster, url: url, description: description,
        status: 'unknown', genres: _uniq(tags).slice(0, 6), studios: [],
        type: 'movie', sourceId: SOURCE_ID, episodes: episodes, year: year,
        subCount: episodes.length, dubCount: 0
      };

      return _tmdbFind(title, year, isSeries).then(function (id) {
        if (!id) return base;
        // TMDB id drives Simkl movie/series tracking in the app.
        base.tmdbId = parseInt(id, 10);
        base.tmdbIsTv = !!isSeries;
        var seasons = [];
        if (isSeries) {
          var seen = {};
          episodes.forEach(function (e) {
            var m = e.title.match(/^S(\d+)/); var s = m ? m[1] : '1';
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
            if (info.genres && info.genres.length) base.genres = info.genres.map(function (g) { return g.name; });
            if (info.poster_path) base.cover = _POSTER + info.poster_path;
          }
          var meta = {};
          for (var i = 1; i < all.length; i++) {
            var sd = all[i]; if (!sd) continue;
            for (var k = 0; k < sd.eps.length; k++) { var ep = sd.eps[k]; meta[sd.s + '|' + ep.episode_number] = ep; }
          }
          base.episodes = episodes.map(function (e) {
            var m = e.title.match(/^S(\d+) E(\d+)/); if (!m) return e;
            var md = meta[parseInt(m[1], 10) + '|' + parseInt(m[2], 10)]; if (!md) return e;
            return { id: e.id, number: e.number, url: e.url,
              title: 'S' + m[1] + ' E' + m[2] + ' - ' + (md.name || ('Episode ' + m[2])),
              thumbnail: md.still_path ? (_STILL + md.still_path) : (e.thumbnail || null),
              date: md.air_date || null };
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
    subtitles: [], label: _trim(label || 'UHD Movies')
  };
}

// hrefli / unblockedgames SID bypass (3-step landing-form POST → driveseed).
function _form(html) {
  var action = (html.match(/<form[^>]+id=["']landing["'][^>]*action=["']([^"']+)["']/i) ||
                html.match(/<form[^>]+action=["']([^"']+)["'][^>]*id=["']landing["']/i) ||
                html.match(/<form[^>]+action=["']([^"']+)["']/i) || [])[1] || '';
  var inputs = {}, m;
  var re = /<input[^>]+name=["']([^"']+)["'][^>]*value=["']([^"']*)["']|<input[^>]+value=["']([^"']*)["'][^>]*name=["']([^"']+)["']/gi;
  while ((m = re.exec(html)) !== null) { if (m[1]) inputs[m[1]] = m[2]; else if (m[4]) inputs[m[4]] = m[3]; }
  return { action: action, data: inputs };
}
function _postForm(url, data, ref) {
  var body = Object.keys(data).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(data[k]); }).join('&');
  return fetch(url, { method: 'POST', headers: {
    'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': ref || url
  }, body: body }).then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _bypassHrefli(url) {
  var host = (url.match(/^(https?:\/\/[^/]+)/) || [])[1] || '';
  return _get(url).then(function (h1) {
    var f1 = _form(h1);
    return _postForm(absUrl(f1.action, host) || url, f1.data, url).then(function (h2) {
      var f2 = _form(h2);
      return _postForm(absUrl(f2.action, host) || url, f2.data, url).then(function (h3) {
        var sk = (h3.match(/\?go=([^"'&\s]+)/) || [])[1] || '';
        if (!sk) return '';
        var wp = f2.data['_wp_http2'] || f1.data['_wp_http2'] || '';
        return fetch(host + '?go=' + sk, { headers: {
          'User-Agent': UA, 'Referer': url, 'Cookie': sk + '=' + wp
        } }).then(function (r) {
          var meta = (r.body || '').match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)["']/i);
          var driveUrl = meta ? meta[1] : '';
          if (!driveUrl) return '';
          return _get(driveUrl).then(function (t) {
            var path = (t.match(/replace\(["']([^"']+)["']\)/) || [])[1] || '';
            if (!path || path === '/404') return '';
            return absUrl(path, (driveUrl.match(/^(https?:\/\/[^/]+)/) || [])[1] || host);
          });
        });
      });
    });
  }).catch(function () { return ''; });
}

// driveseed / driveleech file page → direct links (multiple server buttons).
function _btnSuccess(html) {
  var m = html.match(/<a[^>]+class="[^"]*btn-success[^"]*"[^>]+href="([^"]+)"/i) ||
          html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*btn-success[^"]*"/i);
  return m ? m[1] : '';
}
function _dsInstant(href, q, label) {
  return fetch(href, { headers: { 'User-Agent': UA, 'Referer': href } }).then(function (r) {
    var fin = r.url || href;
    var direct = fin.indexOf('url=') !== -1 ? decodeURIComponent(fin.split('url=')[1]) : '';
    return direct ? [_src(direct, q, label + ' Instant')] : [];
  }).catch(function () { return []; });
}
function _dsResumeCloud(base, href, q, label) {
  return _get(absUrl(href, base)).then(function (h) {
    var u = _btnSuccess(h);
    return u && /^https?:/.test(u) ? [_src(u, q, label + ' ResumeCloud')] : [];
  }).catch(function () { return []; });
}
function _dsDirect(base, href, q, label) {
  return _get(absUrl(href, base) + '?type=1').then(function (h) {
    var out = [], m, re = /<a[^>]+class="[^"]*btn-success[^"]*"[^>]+href="([^"]+)"|<a[^>]+href="([^"]+)"[^>]*class="[^"]*btn-success[^"]*"/gi;
    while ((m = re.exec(h)) !== null) { var u = m[1] || m[2]; if (u && /^https?:/.test(u)) out.push(_src(u, q, label + ' Direct')); }
    return out;
  }).catch(function () { return []; });
}
function _dsResumeBot(url, q, label) {
  return fetch(url, { headers: { 'User-Agent': UA } }).then(function (r) {
    var doc = r.body || '';
    var ssid = '';
    var sc = (r.headers && (r.headers['set-cookie'] || r.headers['Set-Cookie'])) || '';
    var mm = String(sc).match(/PHPSESSID=([^;]+)/); if (mm) ssid = mm[1];
    var token = (doc.match(/formData\.append\(['"]token['"],\s*['"]([a-f0-9]+)['"]\)/) || [])[1] || '';
    var path = (doc.match(/fetch\(['"]\/download\?id=([a-zA-Z0-9\/+]+)['"]/) || [])[1] || '';
    var base = url.split('/download')[0];
    if (!token || !path) return [];
    return fetch(base + '/download?id=' + path, { method: 'POST', headers: {
      'Accept': '*/*', 'Origin': base, 'Referer': url,
      'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': 'PHPSESSID=' + ssid
    }, body: 'token=' + encodeURIComponent(token) }).then(function (r2) {
      var j; try { j = JSON.parse(r2.body || 'null'); } catch (e) { j = null; }
      var u = j && j.url;
      return (u && /^https?:/.test(u)) ? [_src(u, q, label + ' ResumeBot')] : [];
    });
  }).catch(function () { return []; });
}
function _driveseed(url) {
  var base = (url.match(/^(https?:\/\/[^/]+)/) || [])[1] || '';
  var pageP;
  if (url.indexOf('r?key=') !== -1) {
    pageP = _get(url).then(function (h) {
      var temp = (h.match(/replace\(["']([^"']+)["']\)/) || [])[1] || '';
      return temp ? _get(base + temp) : h;
    });
  } else { pageP = _get(url); }
  return pageP.then(function (doc) {
    var nameLine = htmlText((doc.match(/<li[^>]*class="[^"]*list-group-item[^"]*"[^>]*>([\s\S]*?)<\/li>/i) || [])[1] || '');
    var fileName = nameLine.replace(/^name\s*:\s*/i, '').trim();
    var quality = _quality(fileName) || _quality(url) || 'auto';
    var label = 'UHD Movies' + (fileName ? ' [' + fileName.slice(0, 80) + ']' : '');
    var jobs = [], m, re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re.exec(doc)) !== null) {
      var href = m[1], txt = htmlText(m[2]).toLowerCase();
      if (!href) continue;
      if (txt.indexOf('instant download') !== -1) jobs.push(_dsInstant(absUrl(href, base), quality, label));
      else if (txt.indexOf('resume cloud') !== -1) jobs.push(_dsResumeCloud(base, href, quality, label));
      else if (txt.indexOf('resume worker') !== -1 || txt.indexOf('worker bot') !== -1) jobs.push(_dsResumeBot(absUrl(href, base), quality, label));
      else if (txt.indexOf('direct links') !== -1) jobs.push(_dsDirect(base, href, quality, label));
      else if (txt.indexOf('cloud download') !== -1 && /^https?:/.test(href)) jobs.push(Promise.resolve([_src(href, quality, label + ' Cloud')]));
    }
    if (!jobs.length) {
      var direct = _btnSuccess(doc);
      if (direct && /^https?:/.test(direct)) jobs.push(Promise.resolve([_src(direct, quality, label)]));
    }
    return Promise.all(jobs).then(function (lists) {
      return lists.reduce(function (a, b) { return a.concat(b || []); }, []);
    });
  }).catch(function () { return []; });
}

function _resolveOne(link) {
  var l = String(link).toLowerCase();
  var p = /unblockedgames|hrefli|href\.li|\?go=|\/go\b/.test(l) ? _bypassHrefli(link) : Promise.resolve(link);
  return p.then(function (resolved) {
    if (!resolved) return [];
    var r = resolved.toLowerCase();
    if (/driveseed|driveleech/.test(r)) return _driveseed(resolved);
    if (/\.(mp4|mkv|m3u8)(\?|$)/.test(r)) return [_src(resolved, _quality(resolved), 'UHD Movies')];
    return _driveseed(resolved); // best-effort: most redirectors land on a driveseed-style page
  }).catch(function () { return []; });
}

function getVideoSources(episodeUrl) {
  var hrefs = _epHrefs(episodeUrl).slice(0, 12);
  if (!hrefs.length) return Promise.reject(new Error('UHD Movies: no download links'));
  return Promise.all(hrefs.map(_resolveOne)).then(function (lists) {
    var out = [], seen = {};
    for (var i = 0; i < lists.length; i++) {
      var arr = lists[i] || [];
      for (var k = 0; k < arr.length; k++) {
        var s = arr[k];
        if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); }
      }
    }
    if (!out.length) throw new Error('UHD Movies: no playable links resolved');
    return out;
  });
}
