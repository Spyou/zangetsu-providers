// Kartoons (kartoons.to) — cartoons + anime, shows and movies.
// JSON API, no scraping. Browse is public, playback needs a token
// (site Profile -> Stremio tab -> token from the Manifest URL).

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'kartoons';

var SITE = 'https://kartoons.to';
var APIS = ['https://api.kartoons.to', 'https://api.kartoons.me'];
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function getInfo() {
  return { name: 'Kartoons', lang: 'en', baseUrl: SITE,
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.0.1' };
}

function getSettings() {
  return [
    { key: 'token', label: 'API token (site Profile → Stremio tab → copy token)', type: 'text', default: '' },
    { key: 'audioLang', label: 'Preferred audio', type: 'enum', default: 'hin',
      options: [
        { value: 'hin', label: 'Hindi' },
        { value: 'tam', label: 'Tamil' },
        { value: 'tel', label: 'Telugu' },
        { value: 'eng', label: 'English' }
      ] }
  ];
}

function _trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
function _quality(s) { var m = String(s || '').match(/(\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }

function _settings() {
  try {
    var bag = (typeof __settings !== 'undefined' && __settings) ? __settings : {};
    return bag[SOURCE_ID] || {};
  } catch (e) { return {}; }
}

// Accept the bare token or a pasted manifest URL.
function _token() {
  var raw = _trim(_settings().token || '');
  if (!raw) return '';
  if (raw.indexOf('token=') !== -1) raw = raw.split('token=')[1].split('&')[0];
  return _trim(raw);
}

function _audio() {
  var a = _trim(_settings().audioLang || 'hin').toLowerCase();
  if (a === 'tam' || a === 'tel' || a === 'eng') return a;
  return 'hin';
}

function _audioName(code) {
  if (code === 'tam') return 'Tamil';
  if (code === 'tel') return 'Telugu';
  if (code === 'eng') return 'English';
  return 'Hindi';
}

var _SUB_NAMES = { eng: 'English', hin: 'Hindi', tam: 'Tamil', tel: 'Telugu',
  jpn: 'Japanese', mal: 'Malayalam', kan: 'Kannada', ben: 'Bengali', mar: 'Marathi' };
function _subName(code) {
  var c = _trim(code).toLowerCase();
  if (_SUB_NAMES[c]) return _SUB_NAMES[c];
  if (!c) return 'Unknown';
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function _url(base, path) {
  var t = _token();
  var sep = path.indexOf('?') !== -1 ? '&' : '?';
  return base + '/api/cloudstream/' + path + (t ? sep + 'token=' + encodeURIComponent(t) : '');
}

// Try mirrors in order. Only network failures fall through,
// a real { success: false } answer is passed back.
function _j(path) {
  function attempt(i) {
    if (i >= APIS.length) return Promise.resolve(null);
    return fetch(_url(APIS[i], path), {
      headers: { 'User-Agent': UA, 'Referer': SITE + '/', 'Origin': SITE },
      timeoutMs: 12000
    }).then(function (r) {
      try { return JSON.parse(r.body || 'null'); } catch (e) { return null; }
    }).catch(function () { return null; })
    .then(function (j) { return j ? j : attempt(i + 1); });
  }
  return attempt(0);
}

function _card(it) {
  if (!it || !it.id || !it.title) return null;
  var kind = (it.type === 'movie') ? 'movie' : 'show';
  var url = '/' + kind + '/' + it.id;
  return { id: url, title: _trim(it.title), cover: it.image || null,
    url: url, type: 'anime', sourceId: SOURCE_ID };
}

function _cards(data) {
  var out = [];
  for (var i = 0; i < (data || []).length; i++) {
    var c = _card(data[i]);
    if (c) out.push(c);
  }
  return out;
}

function search(query, page, opts) {
  var q = _trim(query);
  if (!q) return Promise.resolve([]);
  return _j('search?q=' + encodeURIComponent(q) + '&page=' + (page || 1) + '&limit=20')
    .then(function (j) { return _cards(j && j.success && j.data); })
    .catch(function () { return []; });
}

function getHome(opts) {
  var rows = [
    { title: 'Popular Shows', path: 'catalog/show?catalog=popular' },
    { title: 'Trending Shows', path: 'catalog/show?catalog=trending' },
    { title: 'Popular Movies', path: 'catalog/movie?catalog=popular' },
    { title: 'Latest Shows', path: 'catalog/show?catalog=latest' },
    { title: 'Latest Movies', path: 'catalog/movie?catalog=latest' }
  ];
  return Promise.all(rows.map(function (row) {
    return _j(row.path + '&page=1&limit=20').then(function (j) {
      return { title: row.title, items: _cards(j && j.success && j.data) };
    }).catch(function () { return { title: row.title, items: [] }; });
  })).catch(function () { return []; });
}

function _parseUrl(url) {
  var m = String(url || '').match(/\/(show|movie)\/([^/?#]+)(?:\/season\/([^/?#]+))?/);
  if (!m) return null;
  return { kind: m[1], id: m[2], season: m[3] || null };
}

function _ep(showId, seasonSlug, seasonNum, ep, n) {
  var num = (ep.episodeNumber != null) ? ep.episodeNumber : n;
  var t = _trim(ep.title);
  return { id: 'S' + seasonNum + 'E' + num, number: n,
    title: 'S' + seasonNum + ' E' + num + (t ? ' - ' + t : ''),
    url: 'kartoons://show/' + showId + '/' + seasonSlug + '/' + (ep._id || ep.id),
    thumbnail: ep.image || null };
}

function _baseDetail(url, data, episodes) {
  return {
    id: url, title: _trim(data.title) || 'Untitled',
    cover: data.image || data.coverImage || null, url: url,
    description: _trim(data.description), status: data.status || 'unknown',
    genres: (data.tags || []).slice(0, 8), studios: [], type: 'anime',
    sourceId: SOURCE_ID, episodes: episodes,
    year: data.releaseYear || data.startYear || null, malId: null,
    subCount: episodes.length, dubCount: 0
  };
}

function getDetail(url, opts) {
  var key = String(url);
  var hit = _detailCache[key];
  var now = Date.now();
  if (hit && (now - hit.at) < _DETAIL_TTL) return Promise.resolve(hit.value);
  return _fetchDetail(url, opts).then(function (d) {
    if (d && d.episodes && d.episodes.length) {
      _detailCache[key] = { at: Date.now(), value: d };
    }
    return d;
  });
}

// Detail screen hits this a lot — cache 5 min.
var _detailCache = {};
var _DETAIL_TTL = 300000;

function _fetchDetail(url, opts) {
  var p = _parseUrl(url);
  if (!p) return Promise.resolve(null);
  if (p.kind === 'movie') return _movieDetail('/movie/' + p.id, p.id);
  return _showDetail('/show/' + p.id, p.id, p.season);
}

function _movieDetail(url, id) {
  return _j('movie/' + encodeURIComponent(id)).then(function (j) {
    var data = (j && j.success && j.data) || {};
    var episodes = [{ id: 'movie', number: 1, title: _trim(data.title) || 'Movie',
      url: 'kartoons://movie/' + id }];
    return _baseDetail(url, data, episodes);
  }).catch(function () { return null; });
}

function _showDetail(url, id, onlySeason) {
  return _j('show/' + encodeURIComponent(id)).then(function (j) {
    var data = (j && j.success && j.data) || {};
    var seasons = data.seasons || [];
    if (onlySeason) seasons = seasons.filter(function (s) { return s.slug === onlySeason; });
    if (!seasons.length) return _baseDetail(url, data, []);
    return Promise.all(seasons.map(function (s) {
      var slug = s.slug || ('season-' + (s.seasonNumber || 0));
      var num = (s.seasonNumber != null) ? s.seasonNumber : 1;
      return _j('show/' + encodeURIComponent(id) + '/season/' + encodeURIComponent(slug) + '/episodes')
        .then(function (ej) {
          return { slug: slug, num: num, eps: (ej && ej.success && ej.data) || [] };
        }).catch(function () { return { slug: slug, num: num, eps: [] }; });
    })).then(function (groups) {
      var out = [], n = 1;
      for (var i = 0; i < groups.length; i++) {
        for (var k = 0; k < groups[i].eps.length; k++) {
          var ep = groups[i].eps[k];
          if (ep && (ep._id || ep.id)) out.push(_ep(id, groups[i].slug, groups[i].num, ep, n++));
        }
      }
      return _baseDetail(url, data, out);
    });
  }).catch(function () { return null; });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return (d && d.episodes) || []; });
}

function _audioOf(name) {
  var s = String(name || '').toLowerCase();
  if (/english|\beng\b/.test(s)) return { kind: 'sub', audioLang: 'en' };
  if (/hindi|\bhin\b/.test(s)) return { kind: 'dub', audioLang: 'hi' };
  if (/tamil|\btam\b/.test(s)) return { kind: 'dub', audioLang: 'ta' };
  if (/telugu|\btel\b/.test(s)) return { kind: 'dub', audioLang: 'te' };
  var p = _audio();
  return { kind: p === 'eng' ? 'sub' : 'dub',
    audioLang: p === 'eng' ? 'en' : p === 'tam' ? 'ta' : p === 'tel' ? 'te' : 'hi' };
}

function getVideoSources(episodeUrl) {
  var m = String(episodeUrl || '').match(/^kartoons:\/\/(movie|show)\/(.+)$/);
  if (!m) return Promise.reject(new Error('Kartoons: bad episode url'));
  if (!_token()) {
    return Promise.reject(new Error(
      'Kartoons: set your API token in source settings (kartoons.to → Profile → Stremio tab)'));
  }
  var path;
  if (m[1] === 'movie') {
    path = 'movie/' + m[2].split('/')[0] + '/links';
  } else {
    var parts = m[2].split('/');
    path = 'episode/' + parts[parts.length - 1] + '/links';
  }
  return _j(path).then(function (j) {
    if (!j || !j.success || !j.data) {
      throw new Error('Kartoons: ' + ((j && (j.message || j.error)) || 'no links'));
    }
    var subs = [], i, t;
    var rawSubs = j.data.subtitles || [];
    for (i = 0; i < rawSubs.length; i++) {
      t = rawSubs[i];
      if (!t || !t.url) continue;
      var lang = _subName(t.lang);
      subs.push({ url: t.url, lang: lang, label: lang,
        format: /\.srt(\?|$)/i.test(t.url) ? 'srt' : 'vtt' });
    }
    // Preferred audio first.
    var pref = _audioName(_audio());
    var codeRe = new RegExp('(^|[^a-z])' + _audio() + '([^a-z]|$)', 'i');
    var links = (j.data.links || []).slice();
    links.sort(function (a, b) {
      function score(l) {
        var n = (l && l.name) || '';
        if (n.toLowerCase().indexOf(pref.toLowerCase()) !== -1) return 2;
        if (codeRe.test(n)) return 2;
        return 1;
      }
      return score(b) - score(a);
    });
    var out = [], seen = {};
    var hdrs = { 'User-Agent': UA, 'Referer': SITE + '/', 'Origin': SITE };
    for (i = 0; i < links.length; i++) {
      var l = links[i];
      if (!l || !l.url || seen[l.url]) continue;
      seen[l.url] = 1;
      var hls = /\.m3u8(\?|$)/i.test(l.url);
      var ao = _audioOf(l.name);
      out.push({ url: l.url, quality: _quality(l.name) || 'auto', label: _trim(l.name) || 'Kartoons',
        container: hls ? 'hls' : 'mp4', headers: hdrs,
        kind: ao.kind, audioLang: ao.audioLang, subtitles: subs });
    }
    if (!out.length) throw new Error('Kartoons: no playable links');
    return out;
  });
}
