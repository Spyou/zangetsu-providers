// MultiMovies — movie/series source for the Zangetsu provider repo.
//
// Catalog is a DooPlay WordPress theme (regex-scraped). Video chain:
//   detail / episode page  ->  player option (GDMIRROR)  ->  doo_player_ajax
//   ->  iqsmartgames embed  ->  mymovieapi / myseriesapi (fileslug)
//   ->  embedhelper.php  (mresult = {server: fileId} + siteUrls host map)
//   ->  StreamWish-family embed  ->  packed-JS unpack  ->  master.m3u8.
// No JS execution / no decryption needed — the file ids arrive in plaintext
// via the base64 `mresult` blob. Domain rotates, fetched from the upstream list.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'multimovies';

var DEFAULT_MAIN = 'https://multimovies.homes';
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
    return String(j['multimovies'] || DEFAULT_MAIN).replace(/\/$/, '');
  });
}

function getInfo() {
  return {
    name: 'MultiMovies', lang: 'hi', baseUrl: DEFAULT_MAIN,
    logo: DEFAULT_MAIN + '/favicon.ico', type: 'movie', version: '1.0.0'
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
function _quality(s) { var m = String(s || '').match(/(\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }
function _uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { if (a[i] && !s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } } return o; }
function _abs(href, base) { try { return new URL(href, base).href; } catch (e) { return href; } }
function _baseOf(url) { return (String(url).match(/^(https?:\/\/[^/]+)/) || [])[1] || ''; }
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
// base64 -> JSON (mresult). The sandbox has base64ToBytes but no atob.
function _b64json(s) {
  try {
    var b = base64ToBytes(String(s || ''));
    var str = '';
    for (var i = 0; i < b.length; i++) str += String.fromCharCode(b[i]);
    return JSON.parse(str);
  } catch (e) { return null; }
}
function _cleanTitle(raw) {
  var t = htmlText(raw || '').replace(/^\s*(?:download|watch)\s+/i, '');
  t = t.replace(/^\s*multimovies\s*[|\-–:]\s*/i, '');
  return _trim(t);
}

// ── catalog cards ─────────────────────────────────────────────────────────────
function _cardFromBlock(inner, main) {
  var href = (inner.match(/<a[^>]+href=['"]([^'"]+)['"]/i) || [])[1];
  if (!href) return null;
  var url = _abs(href, main);
  if (!/\/(movies|tvshows)\//i.test(url)) return null;
  var title = _cleanTitle(
    (inner.match(/<img[^>]+alt=['"]([^'"]*)['"]/i) || [])[1] ||
    (inner.match(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] ||
    (inner.match(/class=['"]title['"][^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '');
  if (!title) return null;
  var img = (inner.match(/<img[^>]+(?:data-src|data-lazy-src|src)=['"]([^'"]+\.(?:jpg|jpeg|png|webp)[^'"]*)['"]/i) || [])[1] || null;
  return {
    id: url, title: title, cover: (img && img.indexOf('http') === 0) ? img : null,
    url: url, type: 'movie', sourceId: SOURCE_ID
  };
}
// Archive / home grids use <article class="item ...">.
function _cards(html, main) {
  var out = [], seen = {}, m;
  var re = /<article[^>]*\bitem\b[^>]*>([\s\S]*?)<\/article>/gi;
  while ((m = re.exec(html)) !== null) {
    var c = _cardFromBlock(m[1], main);
    if (c && !seen[c.url]) { seen[c.url] = 1; out.push(c); }
  }
  return out;
}
// Search results use <div class="result-item"> blocks (article.item is sidebar).
function _searchCards(html, main) {
  var out = [], seen = {};
  var parts = html.split(/<div class=['"]result-item['"]/i);
  for (var i = 1; i < parts.length; i++) {
    var c = _cardFromBlock(parts[i], main);
    if (c && !seen[c.url]) { seen[c.url] = 1; out.push(c); }
  }
  return out;
}

function getHome(opts) {
  var rows = [
    { title: 'Latest Movies', path: '/movies/' },
    { title: 'Latest TV Shows', path: '/tvshows/' },
    { title: 'Bollywood', path: '/genre/bollywood-movies/' },
    { title: 'Anime (Hindi)', path: '/genre/anime-hindi/' },
    { title: 'Action', path: '/genre/action/' },
    { title: 'Animation', path: '/genre/animation/' }
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
    var p = (page && page > 1) ? ('/page/' + page) : '';
    var u = main + p + '/?s=' + encodeURIComponent(query || '');
    return _get(u, main + '/').then(function (html) { return _searchCards(html, main); });
  }).catch(function () { return []; });
}

// ── detail / episodes ─────────────────────────────────────────────────────────
function _episodes(html, main) {
  var out = [], m;
  var re = /<div class=['"]numerando['"]>\s*(\d+)\s*-\s*(\d+)\s*<\/div>\s*<div class=['"]episodiotitle['"]>\s*<a href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = re.exec(html)) !== null) {
    var s = parseInt(m[1], 10) || 1, e = parseInt(m[2], 10) || 0;
    var url = _abs(m[3], main);
    var name = _trim(htmlText(m[4] || ''));
    var label = 'S' + s + ' E' + e + (name && !/^episode\s*\d+$/i.test(name) ? ' · ' + name : '');
    out.push({ id: 'S' + s + 'E' + e, number: e, title: label, url: url });
  }
  out.sort(function (a, b) {
    var as = a.id.match(/S(\d+)E(\d+)/), bs = b.id.match(/S(\d+)E(\d+)/);
    if (as && bs) { if (as[1] !== bs[1]) return as[1] - bs[1]; return as[2] - bs[2]; }
    return 0;
  });
  return out;
}

function getDetail(url, opts) {
  return _main().then(function (main) {
    var u = _abs(url, main);
    return _get(u, main + '/').then(function (html) {
      var isSeries = /\/tvshows\//i.test(u) || /class=['"]episodios['"]/i.test(html);
      var title = _cleanTitle(
        (html.match(/<div class="data[^"]*">\s*<h1>([\s\S]*?)<\/h1>/i) || [])[1] ||
        (html.match(/og:title" content="([^"]+)"/) || [])[1] || 'Untitled');
      var poster = (html.match(/<div class="poster">[\s\S]{0,200}?<img[^>]+(?:data-src|src)="([^"]+)"/i) || [])[1] ||
        (html.match(/og:image" content="([^"]+)"/) || [])[1] || null;
      var description = _trim(htmlText(
        (html.match(/<div[^>]*class="[^"]*wp-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
        (html.match(/itemprop="description"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
        (html.match(/og:description" content="([^"]+)"/) || [])[1] || ''))
        .replace(/^\s*synopsis\s*[:.]?\s*/i, '');
      var date = (html.match(/<span[^>]*class=['"]date['"][^>]*>([^<]+)/i) || [])[1] || '';
      var year = ((date.match(/(19|20)\d{2}/) || [])[0]) ||
        ((title.match(/(19|20)\d{2}/) || [])[0]) || null;

      var genres = [], gm;
      var gblock = (html.match(/<div class="sgeneros">([\s\S]*?)<\/div>/i) || [])[1] || '';
      var gre = /<a[^>]*>([^<]+)<\/a>/gi;
      while ((gm = gre.exec(gblock)) !== null) genres.push(_trim(htmlText(gm[1])));

      var base = {
        id: u, title: title, cover: (poster && poster.indexOf('http') === 0) ? poster : null,
        url: u, description: description, status: 'unknown', genres: genres, studios: [],
        type: 'movie', sourceId: SOURCE_ID, year: year, subCount: 0, dubCount: 0, episodes: []
      };

      if (isSeries) {
        var eps = _episodes(html, main);
        base.episodes = eps; base.subCount = eps.length;
      } else {
        base.episodes = [{ id: 'movie', number: 1, title: title, url: u }];
        base.subCount = 1;
      }

      // Tracker-sync ids (best-effort). The imdb/tmdb id lives ONLY in the
      // player embed URL, never in the page markup. A movie detail page IS the
      // player page (reuse its html); a series page isn't, so peek episode 1.
      var phP = isSeries
        ? (base.episodes.length ? _get(base.episodes[0].url, main + '/') : Promise.resolve(''))
        : Promise.resolve(html);
      return phP.then(function (ph) {
        return _syncIds(ph, isSeries, main);
      }).then(function (ids) {
        base.tmdbId = ids.tmdbId || null;
        base.imdbId = ids.imdbId || null;
        base.tmdbIsTv = !!ids.tmdbIsTv;
        return base;
      }).catch(function () { return base; });
    });
  });
}

// Pull the imdb/tmdb id out of the first player option's embed URL. Movies are
// keyed by imdb (tt…), series by tmdb (the GDMIRROR embed is /embed/tv/{tmdb}/…)
// — other embeds (Cineverse/Peachify/…) also carry tt/tmdb ids, so option 1 is
// enough and we don't need to single out GDMIRROR here.
function _syncIds(playerHtml, isSeries, main) {
  var opts = _playerOptions(playerHtml || '');
  if (!opts.length) return Promise.resolve({});
  return _dooAjax(main, opts[0]).then(function (embed) {
    if (!embed) return {};
    var imdb = (embed.match(/(tt\d{6,})/) || [])[1] || null;
    var tmdb = (embed.match(/\/(?:tv|movie)\/(\d+)/) ||
      embed.match(/[?&](?:id|tmdb|tmdbid)=(\d+)/i) || [])[1] || null;
    var res = {};
    if (isSeries) {
      res.tmdbIsTv = true;
      if (tmdb) res.tmdbId = parseInt(tmdb, 10);
      else if (imdb) res.imdbId = imdb;
    } else {
      if (imdb) res.imdbId = imdb;
      else if (tmdb) res.tmdbId = parseInt(tmdb, 10);
    }
    return res;
  }).catch(function () { return {}; });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return d.episodes; });
}

// ── video resolution (GDMIRROR / iqsmartgames chain) ──────────────────────────
function _playerOptions(html) {
  var out = [], m;
  var re = /<li[^>]*class=['"][^'"]*dooplay_player_option[^'"]*['"][^>]*>/gi;
  while ((m = re.exec(html)) !== null) {
    var tag = m[0];
    var post = (tag.match(/data-post=['"](\d+)/) || [])[1];
    var nume = (tag.match(/data-nume=['"]([^'"]+)/) || [])[1];
    var type = (tag.match(/data-type=['"]([^'"]+)/) || [])[1];
    if (post && nume && type) out.push({ post: post, nume: nume, type: type });
  }
  return out;
}

function _dooAjax(main, o) {
  return fetch(main + '/wp-admin/admin-ajax.php', {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded', 'Referer': main + '/'
    },
    body: 'action=doo_player_ajax&post=' + encodeURIComponent(o.post) +
      '&nume=' + encodeURIComponent(o.nume) + '&type=' + encodeURIComponent(o.type)
  }).then(function (r) {
    var t = r.body || '', j = null; try { j = JSON.parse(t); } catch (e) {}
    var embed = String((j && j.embed_url) || t).replace(/\\\//g, '/');
    return (embed.match(/SRC=["']([^"']+)/i) || embed.match(/src=["']([^"']+)/i) ||
      embed.match(/(https?:\/\/[^"'<> ]+)/) || [])[1] || '';
  }).catch(function () { return ''; });
}

// Find the GDMIRROR (iqsmartgames) embed among the player options.
function _findIq(main, opts) {
  var list = opts.slice(0, 6), i = 0;
  function next() {
    if (i >= list.length) return Promise.resolve('');
    return _dooAjax(main, list[i++]).then(function (src) {
      return (src && src.indexOf('iqsmartgames') !== -1) ? src : next();
    });
  }
  return next();
}

function _embedHelper(playerBase, slug) {
  return fetch(playerBase + '/embedhelper.php', {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Referer': playerBase + '/', 'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'sid=' + encodeURIComponent(slug)
  }).then(function (r) {
    var j = null; try { j = JSON.parse(r.body || 'null'); } catch (e) {}
    return j;
  }).catch(function () { return null; });
}

function _src(url, quality, label, referer) {
  return {
    url: url, quality: quality || 'auto',
    container: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4',
    headers: { 'User-Agent': UA, 'Referer': referer || '' },
    kind: 'sub', audioLang: '', subtitles: [], label: _trim(label || '')
  };
}

// StreamWish-family embed (StreamHG / EarnVids / etc.): packed JS -> master.m3u8.
function _resolveEmbed(embed, name, quality) {
  var ref = _baseOf(embed) + '/';
  return _get(embed, ref).then(function (html) {
    var unp = ''; try { unp = unpackJs(html) || ''; } catch (e) {}
    var hay = html + ' ' + unp;
    var m3 = (hay.match(/https?:\/\/[^"'\\ ]+\.m3u8[^"'\\ ]*/) || [])[0] ||
      (hay.match(/["']file["']\s*:\s*["']([^"']+\.m3u8[^"']*)/i) || [])[1] ||
      (hay.match(/["']hls\d?["']\s*:\s*["']([^"']+\.m3u8[^"']*)/i) || [])[1];
    if (!m3) return [];
    return [_src(m3, quality, 'MultiMovies [' + (name || 'Server') + ']', ref)];
  }).catch(function () { return []; });
}

// embed page (iqsmartgames) inline var, e.g.  api_url  = "https://...".
function _embedVar(html, name) {
  var m = html.match(new RegExp(name + '\\s*=\\s*[\'"]([^\'"]*)[\'"]'));
  return m ? m[1] : '';
}

function _iqChain(embedUrl, main) {
  return _get(embedUrl, main + '/').then(function (html) {
    var apiUrl = _embedVar(html, 'api_url') || _baseOf(embedUrl);
    var playerBase = _embedVar(html, 'player_base') ||
      _baseOf(embedUrl).replace('://streams.', '://pro.');
    var myKey = _embedVar(html, 'myKey');
    var finalId = _embedVar(html, 'FinalID');
    var idType = _embedVar(html, 'idType') || 'imdbid';
    var season = _embedVar(html, 'season');
    var isTv = /\/embed\/tv\//i.test(embedUrl);
    var epname = '';

    var pm = embedUrl.match(/\/embed\/(?:movie|tv)\/([^\/?]+)(?:\/(\d+)\/(\d+))?/);
    if (!finalId && pm) finalId = pm[1];
    if (isTv && pm) { season = season || pm[2] || '1'; epname = pm[3] || '1'; }
    if (!finalId || !myKey) return [];

    var apiPath = isTv
      ? '/myseriesapi?' + idType + '=' + encodeURIComponent(finalId) +
        '&season=' + encodeURIComponent(season || '1') +
        '&epname=' + encodeURIComponent(epname || '1') + '&key=' + encodeURIComponent(myKey)
      : '/mymovieapi?' + idType + '=' + encodeURIComponent(finalId) +
        '&key=' + encodeURIComponent(myKey);

    return _get(apiUrl + apiPath, apiUrl + '/').then(function (body) {
      var j = null; try { j = JSON.parse(body || 'null'); } catch (e) {}
      var data = (j && j.data) || [];
      if (!data.length) return [];
      var jobs = data.slice(0, 3).map(function (d) {
        var quality = _quality(d && d.filename) || 'auto';
        return _embedHelper(playerBase, d && d.fileslug).then(function (eh) {
          if (!eh || !eh.mresult) return [];
          var mr = _b64json(eh.mresult) || {};
          var su = eh.siteUrls || {}, names = eh.siteFriendlyNames || {};
          var embeds = [];
          Object.keys(mr).forEach(function (k) {
            if (su[k] && mr[k]) embeds.push({ url: su[k] + mr[k], name: names[k] || k });
          });
          return Promise.all(embeds.slice(0, 8).map(function (e) {
            return _resolveEmbed(e.url, e.name, quality);
          })).then(function (lists) {
            return lists.reduce(function (a, b) { return a.concat(b || []); }, []);
          });
        }).catch(function () { return []; });
      });
      return Promise.all(jobs).then(function (lists) {
        return lists.reduce(function (a, b) { return a.concat(b || []); }, []);
      });
    });
  }).catch(function () { return []; });
}

function getVideoSources(pageUrl) {
  return _main().then(function (main) {
    var u = _abs(pageUrl, main);
    return _get(u, main + '/').then(function (html) {
      var opts = _playerOptions(html);
      if (!opts.length) throw new Error('MultiMovies: no players');
      return _findIq(main, opts).then(function (embed) {
        if (!embed) throw new Error('MultiMovies: GDMIRROR unavailable');
        return _iqChain(embed, main);
      });
    });
  }).then(function (sources) {
    var out = [], seen = {};
    (sources || []).forEach(function (s) {
      if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); }
    });
    if (!out.length) throw new Error('MultiMovies: no playable sources');
    return out;
  });
}
