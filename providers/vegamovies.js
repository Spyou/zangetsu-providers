// VegaMovies — movie/series source for the Zangetsu provider repo.
//
// HTML-scraped catalog (regex; no DOM parser in the runtime) + a JSON search
// endpoint. Self-contained video chain:
//   page download buttons  ->  intermediate link page (nexdrive/…)
//   ->  V-Cloud link  ->  V-Cloud file page  ->  direct files
//   (FSL / Mega / Buzz / Pixeldrain / 10Gbps / Download).
// The live domain rotates, so it's fetched once from the upstream list and
// cached, with a sane fallback.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'vegamovies';

var DEFAULT_MAIN = 'https://vegamovies.mq';
var URLS = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

var _main = null;
function _domains() {
  if (_main) return Promise.resolve(_main);
  return fetch(URLS, { headers: { 'User-Agent': UA } }).then(function (r) {
    var j = {}; try { j = JSON.parse(r.body || '{}'); } catch (e) {}
    _main = String(j['vegamovies'] || DEFAULT_MAIN).replace(/\/$/, '');
    return _main;
  }).catch(function () { _main = DEFAULT_MAIN; return _main; });
}

function getInfo() {
  return {
    name: 'VegaMovies', lang: 'hi', baseUrl: DEFAULT_MAIN,
    logo: DEFAULT_MAIN + '/favicon.ico', type: 'movie', version: '1.0.4'
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
function _quality(s) { var m = String(s || '').match(/(\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }
function _uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { if (a[i] && !s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } } return o; }
// The sandbox has base64ToBytes but no atob.
function _b64(s) {
  try { var b = base64ToBytes(String(s || '')); var o = ''; for (var i = 0; i < b.length; i++) o += String.fromCharCode(b[i]); return o; }
  catch (e) { return ''; }
}
// Use the host absUrl — QuickJS has no URL constructor, so `new URL()` throws
// there and would silently leave relative hrefs (e.g. search.php permalinks)
// unresolved, breaking detail loads from search.
function _abs(href, base) { return absUrl(href, base); }
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _cleanTitle(raw) {
  var t = htmlText(raw || '').replace(/^\s*download\s+/i, '');
  t = t.split(/\s*\(/)[0].split(/\bseason\b/i)[0].split(/\bS0?\d/)[0];
  // Cutting at S01 can leave the opening bracket of "{S01E01 Added}" behind.
  t = _trim(t).replace(/[\s\-–:,\[{]+$/, '');
  return _trim(t) || _trim(htmlText(raw || ''));
}

// Cards live in `div.movies-grid > a`, each wrapping a lazy <img> whose real
// poster is in data-src and whose title is the alt text ("Download …").
function _cards(html, main) {
  var out = [], seen = {};
  var gi = html.indexOf('movies-grid');
  var block = gi >= 0 ? html.slice(gi) : html;
  var re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, m;
  while ((m = re.exec(block)) !== null) {
    var href = m[1], inner = m[2];
    if (!/<img/i.test(inner)) continue;
    var alt = (inner.match(/<img[^>]+alt="([^"]*)"/i) || [])[1] || '';
    var title = _trim(htmlText(alt).replace(/^download\s+/i, ''));
    if (!title) continue;
    var url = _abs(href, main);
    if (seen[url] || /\/(category|page|genre|tag|web-series|movies)\/?$/i.test(url)) continue;
    if (/\/(category|page|genre|tag)\//i.test(url)) continue;
    seen[url] = 1;
    var dsrc = (inner.match(/<img[^>]+data-src="([^"]+)"/i) || [])[1];
    var src = (inner.match(/<img[^>]+\bsrc="([^"]+)"/i) || [])[1];
    var img = (dsrc && dsrc.indexOf('http') === 0) ? dsrc
      : ((src && src.indexOf('http') === 0) ? src : null);
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
    // The /category/ prefix now 301s to the bare path — go straight there so a
    // row still fills when redirects aren't followed.
    { title: 'Netflix', path: '/web-series/netflix/' },
    { title: 'Amazon Prime', path: '/web-series/amazon-prime-video/' },
    { title: 'Anime Series', path: '/anime-series/' },
    { title: 'Korean Series', path: '/korean-series/' }
  ];
  return _domains().then(function (main) {
    return Promise.all(rows.map(function (row) {
      return _get(main + row.path, main + '/').then(function (html) {
        return { title: row.title, items: _cards(html, main) };
      }).catch(function () { return { title: row.title, items: [] }; });
    }));
  }).catch(function () { return []; });
}

// Search is a JSON endpoint: /search.php?q=&page= -> { hits: [{ document }] }.
function search(query, page, opts) {
  return _domains().then(function (main) {
    var u = main + '/search.php?q=' + encodeURIComponent(query || '') + '&page=' + (page || 1);
    return _get(u, main + '/').then(function (body) {
      var j = null; try { j = JSON.parse(body || 'null'); } catch (e) {}
      var hits = (j && j.hits) || [];
      var out = [];
      for (var i = 0; i < hits.length; i++) {
        var d = (hits[i] && hits[i].document) || {};
        var url = d.permalink; if (!url) continue;
        out.push({
          id: _abs(url, main), title: _cleanTitle(d.post_title || ''),
          cover: d.post_thumbnail || null, url: _abs(url, main),
          type: 'movie', sourceId: SOURCE_ID
        });
      }
      if (out.length) return out;
      // Fallback to the HTML search page.
      return _get(main + '/?s=' + encodeURIComponent(query || ''), main + '/')
        .then(function (h) { return _cards(h, main); });
    });
  }).catch(function () { return []; });
}

// ── episode url packing (a list of intermediate/V-Cloud links) ───────────────
function _epUrl(links) { return 'vega://' + encodeURIComponent(JSON.stringify(links)); }
function _epLinks(url) {
  try { return JSON.parse(decodeURIComponent(String(url).replace(/^vega:\/\//, ''))); }
  catch (e) { return []; }
}

// Anchors wrapping a `.dwd-button` point at the per-quality intermediate page.
function _movieLinks(html) {
  var out = [], m;
  var re = /<a[^>]+href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?dwd-button/gi;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return _uniq(out);
}

function getDetail(url, opts) {
  return _domains().then(function (main) {
    var u = _abs(url, main);
    return _get(u, main + '/').then(function (html) {
      var title = _cleanTitle(
        (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] ||
        (html.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || 'Untitled');
      var poster = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] ||
        (html.match(/<p[^>]*>\s*<img[^>]+src="([^"]+)"/i) || [])[1] || null;
      var description = htmlText(
        (html.match(/SYNOPSIS\/PLOT[\s\S]{0,80}?<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] ||
        (html.match(/<meta name="description" content="([^"]+)"/) || [])[1] || '');
      var year = ((title.match(/\((19|20)\d{2}\)/) || [])[0] || '').replace(/[()]/g, '') || null;

      var isSeries = /Series[\s-]*(?:Info|SYNOPSIS\/PLOT|synopsis)/i.test(html) ||
        /(?:Season|Episode)\s*0?\d/i.test(html) && /\bepisode\b/i.test(html);

      var base = {
        id: u, title: title, cover: poster, url: u, description: description,
        status: 'unknown', genres: [], studios: [], type: 'movie',
        sourceId: SOURCE_ID, year: year, subCount: 0, dubCount: 0, episodes: []
      };

      if (!isSeries) {
        var links = _movieLinks(html);
        base.episodes = links.length
          ? [{ id: 'movie', title: title, number: 1, url: _epUrl(links) }]
          : [];
        base.subCount = base.episodes.length;
        return base;
      }
      return _seriesEpisodes(html, main).then(function (eps) {
        base.type = 'movie'; // app type stays movie for non-anime sources
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

// Series: quality headers (h3/h5 with "Season N … 1080p") -> the intermediate
// link -> that page's V-Cloud links, one per episode in order. Group across
// qualities by (season, episodeIndex).
function _seriesEpisodes(html, main) {
  var tags = [], m;
  var re = /<h[35][^>]*>([\s\S]*?)<\/h[35]>/gi;
  var positions = [];
  while ((m = re.exec(html)) !== null) {
    var text = htmlText(m[1]);
    if (/\bzip\b/i.test(text)) continue;
    if (!/(4K|\d{3,4}p)/i.test(text)) continue;
    positions.push({ idx: m.index, end: re.lastIndex, text: text });
  }
  // For each quality header, the intermediate link is in the following <p>.
  var jobs = positions.map(function (p) {
    var after = html.slice(p.end, p.end + 1500);
    var season = (p.text.match(/(?:Season |S)0?(\d+)/i) || [])[1];
    season = season ? parseInt(season, 10) : 1;
    // Only the V-Cloud button's page lists one link per episode. G-Direct sits
    // above it and points at file lockers we can't play, so it's the fallback.
    var inter = '', alt = '';
    var am, are = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((am = are.exec(after)) !== null) {
      var t = htmlText(am[2]);
      if (/\bzip\b|batch/i.test(t)) continue;
      if (/V-?Cloud/i.test(t)) { inter = am[1]; break; }
      if (!alt && /Episode|Download|G-?Direct/i.test(t)) alt = am[1];
    }
    if (!inter) inter = alt;
    if (!inter) return Promise.resolve({ season: season, links: [] });
    return _get(_abs(inter, main), main + '/').then(function (doc) {
      var links = [], lm, lre = /<a[^>]+href="([^"]+)"/g;
      while ((lm = lre.exec(doc)) !== null) {
        if (/vcloud/i.test(lm[1])) links.push(lm[1]);
      }
      return { season: season, links: _uniq(links) };
    }).catch(function () { return { season: season, links: [] }; });
  });

  return Promise.all(jobs).then(function (groups) {
    var byEp = {}; // "s|e" -> [links]
    groups.forEach(function (g) {
      for (var i = 0; i < g.links.length; i++) {
        var key = g.season + '|' + (i + 1);
        (byEp[key] || (byEp[key] = [])).push(g.links[i]);
      }
    });
    var out = [];
    Object.keys(byEp).forEach(function (key) {
      var parts = key.split('|');
      var s = parseInt(parts[0], 10), e = parseInt(parts[1], 10);
      out.push({
        id: 'S' + s + 'E' + e, number: e,
        title: 'S' + s + ' E' + e, url: _epUrl(byEp[key])
      });
    });
    out.sort(function (a, b) {
      var as = a.id.match(/S(\d+)E(\d+)/), bs = b.id.match(/S(\d+)E(\d+)/);
      if (as && bs) {
        if (as[1] !== bs[1]) return as[1] - bs[1];
        return as[2] - bs[2];
      }
      return 0;
    });
    return out;
  });
}

// ── V-Cloud / HubCloud file resolution ───────────────────────────────────────
function _src(url, quality, label) {
  return {
    url: url, quality: quality || 'auto',
    container: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4',
    headers: { 'User-Agent': UA }, kind: 'sub', audioLang: '',
    subtitles: [], label: _trim(label || '')
  };
}
function _baseOf(url) { return (String(url).match(/^(https?:\/\/[^/]+)/) || [])[1] || ''; }
function _serverName(label) {
  if (label.indexOf('fsl') !== -1) return 'FSL Server';
  if (label.indexOf('buzz') !== -1) return 'Buzz Server';
  if (label.indexOf('pixeldra') !== -1 || label.indexOf('pixel') !== -1) return 'Pixeldrain';
  if (label.indexOf('s3') !== -1) return 'S3 Server';
  if (label.indexOf('10gb') !== -1) return '10Gbps';
  if (label.indexOf('mega') !== -1) return 'Mega';
  if (label.indexOf('download') !== -1) return 'Download';
  return 'V-Cloud';
}

// A V-Cloud (or HubCloud) page -> direct file links via its button list.
function _vcloud(url) {
  return _get(url).then(function (html) {
    var link = '';
    if (url.indexOf('/video/') !== -1) {
      link = (html.match(/<div class="vd">[\s\S]*?<a[^>]+href="([^"]+)"/i) || [])[1] || '';
    } else {
      // The landing page hands the tokenised file page over in `var url`, now
      // wrapped in atob(atob(…)). Plain strings still show up on older pages.
      var um = html.match(/var\s+url\s*=\s*(atob\(atob\()?\s*'([^']*)'/);
      link = um ? (um[1] ? _b64(_b64(um[2])) : um[2]) : '';
    }
    if (!link) return [];
    if (!/^https?:/i.test(link)) link = _baseOf(url) + link;
    return _get(link).then(function (doc) {
      var header = htmlText((doc.match(/<div class="card-header[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
      var size = htmlText((doc.match(/id=["']size["'][^>]*>([\s\S]*?)<\//) || [])[1] || '');
// No resolution in the title means we don't know it — say so rather than
      // claiming one. The player hides its quality menu for an unknown stream
      // instead of showing a number that isn't real.
      var quality = _quality(header) || _quality(url) || null;
      var suffix = (header ? (' [' + header.replace(/\s+/g, ' ').slice(0, 60) + ']') : '')
        + (size ? ' [' + size + ']' : '');
      // The Pixeldrain button ships a dead id in its href and a script swaps in
      // the live one, so take the script's value when it's there.
      var pxl = (doc.match(/var\s+pxl\s*=\s*"([^"]+)"/) || [])[1] || '';
      var jobs = [], m;
      var re = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<a[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re.exec(doc)) !== null) {
        var blink = m[1] || m[3]; var text = htmlText(m[2] || m[4] || '').toLowerCase();
        if (!blink) continue;
        if (pxl && /pixeldrain/i.test(blink)) blink = pxl;
        jobs.push(_server(blink, text, quality, suffix));
      }
      return Promise.all(jobs).then(function (lists) {
        var out = []; for (var i = 0; i < lists.length; i++) if (lists[i]) out.push(lists[i]);
        return out;
      });
    });
  }).catch(function () { return []; });
}

function _server(link, label, quality, suffix) {
  // Skip file-locker / folder hosts that aren't a direct, playable stream.
  // gpdl/gamerxyt is the 10Gbps button — it lands on a link-generator page,
  // so the player would be handed HTML instead of the file.
  if (/gofile\.io|megaup\.net|vikingfile|filebee|filepress|gdflix|gdtot|gpdl\d*\.|gamerxyt/i.test(link)) {
    return Promise.resolve(null);
  }
  var name = 'VegaMovies [' + _serverName(label) + ']' + suffix;
  if (label.indexOf('buzz') !== -1) {
    return fetch(link + '/download', {
      headers: { 'Referer': link, 'User-Agent': UA }, followRedirects: false
    }).then(function (r) {
      var h = r.headers || {};
      var dl = h['hx-redirect'] || h['HX-Redirect'] || '';
      return dl ? _src(_baseOf(link) + dl, quality, name) : null;
    }).catch(function () { return null; });
  }
  if (label.indexOf('pixeldra') !== -1 || label.indexOf('pixel') !== -1) {
    var b = _baseOf(link);
    var fin = link.indexOf('download') !== -1 ? link
      : (b + '/api/file/' + link.replace(/\/$/, '').split('/').pop() + '?download');
    return Promise.resolve(_src(fin, quality, name));
  }
  if (label.indexOf('fsl') !== -1 || label.indexOf('download') !== -1 ||
      label.indexOf('s3') !== -1 || label.indexOf('mega') !== -1 ||
      label.indexOf('10gb') !== -1) {
    return Promise.resolve(_src(link, quality, name));
  }
  if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(link)) return Promise.resolve(_src(link, quality, name));
  return Promise.resolve(null);
}

// An intermediate (nexdrive/…) page -> its V-Cloud link(s).
function _vcloudLinksFrom(html) {
  var out = [], m, re = /<a[^>]+href="([^"]+)"/g;
  while ((m = re.exec(html)) !== null) { if (/vcloud/i.test(m[1])) out.push(m[1]); }
  return _uniq(out);
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
  if (!links.length) return Promise.reject(new Error('VegaMovies: no links'));
  return _domains().then(function () {
    var jobs = links.map(function (link) {
      if (/vcloud/i.test(link)) return _vcloud(link);
      // Intermediate page → find its V-Cloud link(s) → resolve.
      return _get(link).then(function (html) {
        var vlinks = _vcloudLinksFrom(html);
        if (!vlinks.length) return [];
        return Promise.all(vlinks.map(_vcloud)).then(function (ls) {
          return ls.reduce(function (a, b) { return a.concat(b || []); }, []);
        });
      }).catch(function () { return []; });
    });
    return Promise.all(jobs).then(function (lists) {
      var out = [], seen = {};
      lists.forEach(function (l) {
        (l || []).forEach(function (s) {
          if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); }
        });
      });
      if (!out.length) throw new Error('VegaMovies: no playable sources');
      return _seekableFirst(out); // seekable mirrors first (range support)
    });
  });
}
