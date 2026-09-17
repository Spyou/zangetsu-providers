// TorBox — debrid movie/series source for the Zangetsu provider repo.
//
// Catalog + episode lists come from TMDB (host injects api_key for
// api.themoviedb.org). Torrents are discovered via Torrentio's public
// Stremio stream API (imdb + S/E → infoHash + filename), then unlocked
// through the TorBox API with the user's API key. Multi-file packs select
// the episode by filename (Torrentio fileIdx does NOT match TorBox file ids).
//
// Settings: apiKey, webStreaming (HLS), cachedOnly, Torrentio sort/limit, resolve caps.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'torbox';

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

var _TMDB = 'https://api.themoviedb.org/3';
var _POSTER = 'https://image.tmdb.org/t/p/w500';
var _STILL = 'https://image.tmdb.org/t/p/w300';
var _TORRENTIO = 'https://torrentio.strem.fun';
var _TB_API = 'https://api.torbox.app/v1/api';
var _VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|wmv|webm|ts|m2ts|mpg|mpeg)$/i;
var _SAMPLE = /[\\/](?:sample|samples|trailer|extras?)[\\/]|\b(?:sample|trailer)\b/i;
var _ZIP_ONLY = /\.zip$/i;

function getInfo() {
  return {
    name: 'TorBox', lang: 'en', baseUrl: 'https://torbox.app',
    logo: 'https://torbox.app/favicon.ico', type: 'movie', version: '1.0.0'
  };
}

function getSettings() {
  return [
    { key: 'apiKey', label: 'TorBox API key', type: 'text', default: '' },
    {
      key: 'webStreaming',
      label: 'Web streaming (HLS)',
      type: 'bool',
      default: false
    },
    { key: 'cachedOnly', label: 'Cached torrents only', type: 'bool', default: true },
    {
      key: 'torrentioBase',
      label: 'Torrentio base URL (optional)',
      type: 'text',
      default: 'https://torrentio.strem.fun'
    },
    {
      key: 'torrentioSort',
      label: 'Torrentio sorting',
      type: 'enum',
      default: 'qualityseed',
      options: [
        { value: 'qualityseed', label: 'By quality, then seeders' },
        { value: 'qualitysize', label: 'By quality, then size' },
        { value: 'seeders', label: 'By seeders' },
        { value: 'size', label: 'By size' }
      ]
    },
    {
      key: 'torrentioLimitPerQuality',
      label: 'Torrentio max results per quality (0 = unlimited)',
      type: 'enum',
      default: '0',
      options: [
        { value: '0', label: 'Unlimited' },
        { value: '1', label: '1 per quality' },
        { value: '2', label: '2 per quality' },
        { value: '3', label: '3 per quality' },
        { value: '5', label: '5 per quality' },
        { value: '10', label: '10 per quality' },
        { value: '20', label: '20 per quality' }
      ]
    },
    {
      key: 'maxCandidates',
      label: 'Max torrents to consider after Torrentio',
      type: 'enum',
      default: '15',
      options: [
        { value: '8', label: '8' },
        { value: '15', label: '15' },
        { value: '20', label: '20' },
        { value: '31', label: '31' },
        { value: '0', label: 'All returned' }
      ]
    },
    {
      key: 'preferCachedFirst',
      label: 'Prefer cached torrents when unlocking',
      type: 'bool',
      default: true
    },
    {
      key: 'boostEpisodeMatch',
      label: 'Boost torrents whose filename matches this episode',
      type: 'bool',
      default: true
    }
  ];
}

// ── helpers ────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }

function _settings() {
  try {
    var bag = (typeof __settings !== 'undefined' && __settings) ? __settings : {};
    return bag[SOURCE_ID] || {};
  } catch (e) { return {}; }
}

function _apiKey() {
  return _trim(_settings().apiKey || '');
}

function _cachedOnly() {
  var s = _settings();
  return s.cachedOnly !== false && s.cachedOnly !== 'false' && s.cachedOnly !== 0;
}

function _useWebStreaming() {
  var s = _settings();
  return s.webStreaming === true || s.webStreaming === 'true' || s.webStreaming === 1;
}

function _torrentioBase() {
  var b = _trim(_settings().torrentioBase || '') || _TORRENTIO;
  while (b.length && b.charAt(b.length - 1) === '/') b = b.slice(0, -1);
  return b;
}

function _torrentioSortKey() {
  var s = _trim(_settings().torrentioSort || 'qualityseed');
  if (s === 'qualitysize' || s === 'seeders' || s === 'size') return s;
  return 'qualityseed';
}

function _torrentioLimitPerQuality() {
  var n = parseInt(_settings().torrentioLimitPerQuality, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

function _maxCandidates() {
  var n = parseInt(_settings().maxCandidates, 10);
  if (isNaN(n) || n === 0) return 999;
  return n;
}

function _preferCachedFirst() {
  var s = _settings();
  return s.preferCachedFirst !== false && s.preferCachedFirst !== 'false' && s.preferCachedFirst !== 0;
}

function _boostEpisodeMatch() {
  var s = _settings();
  return s.boostEpisodeMatch !== false && s.boostEpisodeMatch !== 'false' && s.boostEpisodeMatch !== 0;
}

// Torrentio manifest path prefix, e.g. sort=qualityseed|limit=5/
function _torrentioOptsPrefix() {
  var parts = ['sort=' + _torrentioSortKey()];
  var lim = _torrentioLimitPerQuality();
  if (lim > 0) parts.push('limit=' + lim);
  return parts.join('|') + '/';
}

function _pad(n) {
  n = parseInt(n, 10) || 0;
  return n < 10 ? ('0' + n) : String(n);
}

function _sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function _basename(path) {
  var s = String(path || '').replace(/\\/g, '/');
  var i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function _tj(url) {
  return fetch(url, { headers: { 'User-Agent': UA }, timeoutMs: 10000 })
    .then(function (r) {
      try { return JSON.parse(r.body || 'null'); } catch (e) { return null; }
    })
    .catch(function () { return null; });
}

function _tbHeaders(key, extra) {
  var h = {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Authorization': 'Bearer ' + key
  };
  if (extra) {
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
    }
  }
  return h;
}

function _tbGet(path, key) {
  return fetch(_TB_API + path, {
    headers: _tbHeaders(key),
    timeoutMs: 20000
  }).then(function (r) {
    try { return JSON.parse(r.body || 'null'); } catch (e) { return null; }
  }).catch(function () { return null; });
}

function _tbPostForm(path, key, form) {
  return fetch(_TB_API + path, {
    method: 'POST',
    headers: _tbHeaders(key, { 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: form,
    timeoutMs: 30000
  }).then(function (r) {
    try { return JSON.parse(r.body || 'null'); } catch (e) { return null; }
  }).catch(function () { return null; });
}

function _tbPostJson(path, key, obj) {
  return fetch(_TB_API + path, {
    method: 'POST',
    headers: _tbHeaders(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(obj),
    timeoutMs: 20000
  }).then(function (r) {
    try { return JSON.parse(r.body || 'null'); } catch (e) { return null; }
  }).catch(function () { return null; });
}

function _quality(s) {
  var m = String(s || '').match(/\b(2160|1080|720|480|360)p\b/i);
  if (m) return m[1] + 'p';
  if (/\b4k\b|uhd|2160/i.test(s || '')) return '2160p';
  return null;
}

function _resRank(q) {
  var n = parseInt(String(q || '').replace(/p$/i, ''), 10);
  return isNaN(n) ? 0 : n;
}

function _sizeLabel(bytes) {
  var n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return Math.round(n / 1048576) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

function _parseSizeToBytes(s) {
  var m = String(s || '').match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
  if (!m) return 0;
  var n = parseFloat(m[1]);
  if (isNaN(n)) return 0;
  var u = m[2].toUpperCase();
  if (u === 'TB') return n * 1099511627776;
  if (u === 'GB') return n * 1073741824;
  if (u === 'MB') return n * 1048576;
  return n * 1024;
}

function _isVideoFile(name) {
  var n = String(name || '');
  if (!n || _SAMPLE.test(n)) return false;
  return _VIDEO_EXT.test(n);
}

function _parseEpFromName(name) {
  var s = String(name || '');
  var m = s.match(/[Ss](\d{1,2})\s*[EeXx](\d{1,3})/)
    || s.match(/[Ss](\d{1,2})\s*[.\-_ ]?\s*[Ee](\d{1,3})/)
    || s.match(/\b(\d{1,2})[xX](\d{1,3})\b/)
    || s.match(/Season\s*(\d{1,2})\s*(?:Episode|Ep\.?)\s*(\d{1,3})/i);
  if (m) return { s: parseInt(m[1], 10), e: parseInt(m[2], 10), multi: false };
  if (/[Ss]\d{1,2}\s*[Ee]\d{1,3}\s*[-~]\s*[Ee]?\d{1,3}/.test(s)
    || /\bE\d{1,3}\s*[-~]\s*E?\d{1,3}\b/i.test(s)) {
    return { s: 0, e: 0, multi: true };
  }
  // Absolute episode: "Episode 200", " - 200 - ", " (005)."
  var abs = s.match(/(?:^|[^\d])(?:Ep\.?|Episode)[ .\-_]*0*(\d{1,4})(?:[^\d]|$)/i)
    || s.match(/\s-\s0*(\d{1,4})\s*-/)
    || s.match(/\((\d{3,4})\)\.\w+$/);
  if (abs) return { s: 0, e: parseInt(abs[1], 10), multi: false, absolute: true };
  return null;
}

function _fileMatchesPreferred(fileName, preferred) {
  if (!preferred) return false;
  var base = _basename(preferred).toLowerCase();
  var name = String(fileName || '').toLowerCase().replace(/\\/g, '/');
  if (!base) return false;
  return name === base || name.endsWith('/' + base) || _basename(name) === base;
}

// Prefer Torrentio filename; never trust fileIdx against TorBox's file list.
// [absEp] is the anime absolute episode (Shippuden "Episode 124") when TMDB
// uses continuous episode_number within a season.
function _pickFile(files, season, episode, isMovie, preferredName, absEp) {
  var list = (files || []).filter(function (f) {
    var n = f.name || f.short_name || f.absolute_path || '';
    return _isVideoFile(n);
  });
  // Mega-packs TorBox sometimes exposes as a single zip — unusable for one ep.
  if (!list.length) {
    var only = (files || []).filter(function (f) {
      return _ZIP_ONLY.test(f.name || f.short_name || '');
    });
    if (only.length) return null;
    return null;
  }

  if (preferredName) {
    for (var i = 0; i < list.length; i++) {
      var n = list[i].name || list[i].short_name || list[i].absolute_path || '';
      if (_fileMatchesPreferred(n, preferredName)) return list[i];
    }
  }

  if (isMovie || (!season && !episode && !absEp)) {
    list.sort(function (a, b) { return (Number(b.size) || 0) - (Number(a.size) || 0); });
    return list[0];
  }

  var best = null;
  var bestScore = -1;
  for (var j = 0; j < list.length; j++) {
    var f = list[j];
    var name = f.name || f.short_name || f.absolute_path || '';
    var parsed = _parseEpFromName(name);
    var score = 0;
    if (parsed) {
      if (parsed.multi) score = 40;
      else if (parsed.absolute && absEp && parsed.e === absEp) score = 1200;
      else if (season && episode && parsed.s === season && parsed.e === episode) score = 1000;
      else if (absEp && parsed.s === 0 && parsed.e === absEp) score = 900;
      else if (episode && parsed.s === 0 && parsed.e === episode) score = 400;
      else if (episode && parsed.e === episode) score = 200;
      else score = -100;
    } else {
      score = 10;
    }
    score += Math.min(50, Math.floor((Number(f.size) || 0) / 50000000));
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return bestScore >= 50 ? best : (best || list[0]);
}

// Opaque media / episode URLs.
// Rel episode is season-relative (Torrentio/Stremio). abs is anime absolute.
function _mediaUrl(kind, tmdbId) {
  return 'torbox://' + kind + '/' + tmdbId;
}

function _epUrl(kind, tmdbId, season, episode, imdb, abs) {
  var u = 'torbox://' + kind + '/' + tmdbId + '/' + (season || 0) + '/' + (episode || 0);
  var q = [];
  if (imdb) q.push('imdb=' + encodeURIComponent(imdb));
  if (abs) q.push('abs=' + encodeURIComponent(String(abs)));
  if (q.length) u += '?' + q.join('&');
  return u;
}

function _parseUrl(url) {
  var s = String(url || '');
  var m = s.match(/^torbox:\/\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?/i);
  if (!m) return null;
  var q = {};
  var qi = s.indexOf('?');
  if (qi >= 0) {
    var parts = s.slice(qi + 1).split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv[0]) q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    }
  }
  return {
    kind: m[1].toLowerCase(),
    tmdbId: parseInt(m[2], 10),
    season: m[3] != null ? parseInt(m[3], 10) : null,
    episode: m[4] != null ? parseInt(m[4], 10) : null,
    imdb: q.imdb || null,
    abs: q.abs ? parseInt(q.abs, 10) : null
  };
}

function _itemFromTmdb(r) {
  var kind = r.media_type === 'tv' ? 'tv' : 'movie';
  if (r.media_type && r.media_type !== 'movie' && r.media_type !== 'tv') return null;
  var title = _trim(r.title || r.name || '');
  if (!title) return null;
  var year = ((r.release_date || r.first_air_date || '') + '').slice(0, 4) || null;
  var url = _mediaUrl(kind, r.id);
  return {
    id: url,
    title: year ? (title + ' (' + year + ')') : title,
    cover: r.poster_path ? (_POSTER + r.poster_path) : null,
    url: url,
    type: 'movie',
    sourceId: SOURCE_ID
  };
}

function _ensureImdb(kind, tmdbId, imdb) {
  if (imdb) return Promise.resolve(imdb);
  var path = kind === 'tv'
    ? ('/tv/' + tmdbId + '/external_ids')
    : ('/movie/' + tmdbId + '/external_ids');
  return _tj(_TMDB + path).then(function (j) {
    return (j && j.imdb_id) || null;
  }).catch(function () { return null; });
}

// ── catalog ────────────────────────────────────────────────────────────────
function search(query, page, opts) {
  var q = _trim(query);
  if (!q) return Promise.resolve([]);
  var p = (page && page > 1) ? page : 1;
  return _tj(_TMDB + '/search/multi?query=' + encodeURIComponent(q) + '&page=' + p)
    .then(function (j) {
      var out = [], res = (j && j.results) || [];
      for (var i = 0; i < res.length; i++) {
        var it = _itemFromTmdb(res[i]);
        if (it) out.push(it);
      }
      return out;
    })
    .catch(function () { return []; });
}

function getHome(opts) {
  return Promise.all([
    _tj(_TMDB + '/trending/movie/week'),
    _tj(_TMDB + '/trending/tv/week'),
    _tj(_TMDB + '/movie/popular'),
    _tj(_TMDB + '/tv/popular')
  ]).then(function (all) {
    function mapKind(j, kind) {
      var out = [], res = (j && j.results) || [];
      for (var i = 0; i < res.length; i++) {
        var r = res[i];
        r.media_type = kind;
        var it = _itemFromTmdb(r);
        if (it) out.push(it);
      }
      return out;
    }
    return [
      { title: 'Trending Movies', items: mapKind(all[0], 'movie') },
      { title: 'Trending Series', items: mapKind(all[1], 'tv') },
      { title: 'Popular Movies', items: mapKind(all[2], 'movie') },
      { title: 'Popular Series', items: mapKind(all[3], 'tv') }
    ];
  }).catch(function () { return []; });
}

function _tvEpisodes(tmdbId, imdb, seasonCount) {
  var jobs = [];
  var max = Math.min(seasonCount || 1, 40);
  for (var s = 1; s <= max; s++) {
    (function (season) {
      jobs.push(_tj(_TMDB + '/tv/' + tmdbId + '/season/' + season).then(function (j) {
        return { season: season, eps: (j && j.episodes) || [] };
      }));
    })(s);
  }
  return Promise.all(jobs).then(function (rows) {
    var out = [];
    rows.sort(function (a, b) { return a.season - b.season; });
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      // TMDB anime like Shippuden uses continuous episode_number (S6 = 113…143).
      // Torrentio/Stremio expect season-relative (S06E12). Detect and convert.
      var continuous = false;
      for (var c = 0; c < row.eps.length; c++) {
        var cn = row.eps[c].episode_number;
        if (cn != null && cn !== c + 1) { continuous = true; break; }
      }
      for (var k = 0; k < row.eps.length; k++) {
        var ep = row.eps[k];
        var tmdbNum = ep.episode_number;
        if (tmdbNum == null) continue;
        var rel = continuous ? (k + 1) : tmdbNum;
        var absNum = continuous ? tmdbNum : null;
        var title = 'S' + _pad(row.season) + ' E' + _pad(rel)
          + ' - ' + (ep.name || ('Episode ' + (absNum || tmdbNum)));
        out.push({
          id: row.season + 'x' + rel,
          title: title,
          // Absolute when continuous so Z-Mode / MAL ep N line up; else season-relative.
          number: absNum || tmdbNum,
          url: _epUrl('tv', tmdbId, row.season, rel, imdb, absNum),
          date: ep.air_date || null,
          thumbnail: ep.still_path ? (_STILL + ep.still_path) : null
        });
      }
    }
    return out;
  });
}

function getDetail(url, opts) {
  var p = _parseUrl(url);
  if (!p) return Promise.resolve(null);
  var isTv = p.kind === 'tv';
  var path = isTv
    ? ('/tv/' + p.tmdbId + '?append_to_response=external_ids')
    : ('/movie/' + p.tmdbId + '?append_to_response=external_ids');
  return _tj(_TMDB + path).then(function (info) {
    if (!info || info.success === false) return null;
    var title = _trim(info.title || info.name || 'Untitled');
    var year = ((info.release_date || info.first_air_date || '') + '').slice(0, 4) || null;
    var imdb = (info.external_ids && info.external_ids.imdb_id)
      || info.imdb_id || p.imdb || null;
    var genres = ((info.genres || []).map(function (g) { return g.name; })).filter(Boolean);
    var base = {
      id: _mediaUrl(p.kind, p.tmdbId),
      title: title,
      cover: info.poster_path ? (_POSTER + info.poster_path) : null,
      url: _mediaUrl(p.kind, p.tmdbId),
      description: info.overview || '',
      status: info.status || 'unknown',
      genres: genres.slice(0, 8),
      studios: [],
      type: 'movie',
      sourceId: SOURCE_ID,
      year: year,
      tmdbId: p.tmdbId,
      tmdbIsTv: isTv,
      imdbId: imdb || null,
      episodes: [],
      subCount: 0,
      dubCount: 0
    };
    if (!isTv) {
      base.episodes = [{
        id: 'movie',
        title: title,
        number: 1,
        url: _epUrl('movie', p.tmdbId, 0, 0, imdb)
      }];
      base.subCount = 1;
      return base;
    }
    var seasons = (info.number_of_seasons || ((info.seasons || []).length) || 1);
    if (info.seasons && info.seasons.length) {
      var maxS = 0;
      for (var i = 0; i < info.seasons.length; i++) {
        var sn = info.seasons[i].season_number;
        if (sn > maxS) maxS = sn;
      }
      if (maxS > 0) seasons = maxS;
    }
    return _tvEpisodes(p.tmdbId, imdb, seasons).then(function (eps) {
      base.episodes = eps;
      base.subCount = eps.length;
      return base;
    });
  }).catch(function () { return null; });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) {
    return (d && d.episodes) || [];
  });
}

// ── Torrentio discovery + TorBox resolve ───────────────────────────────────
function _torrentioStreams(imdb, isMovie, season, episode) {
  if (!imdb) return Promise.resolve([]);
  var id = String(imdb);
  if (id.indexOf('tt') !== 0) id = 'tt' + id;
  var streamPath = isMovie
    ? ('stream/movie/' + id + '.json')
    : ('stream/series/' + id + ':' + season + ':' + episode + '.json');
  var url = _torrentioBase() + '/' + _torrentioOptsPrefix() + streamPath;
  var referer = _torrentioBase() + '/';
  var headers = {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': referer
  };
  function once(useBrowser) {
    return fetch(url, {
      headers: headers,
      timeoutMs: 25000,
      browser: !!useBrowser
    }).then(function (r) {
      var j = null;
      try { j = JSON.parse(r.body || 'null'); } catch (e) { }
      var list = (j && j.streams) || [];
      return Array.isArray(list) ? list : [];
    }).catch(function () { return []; });
  }
  // Retry via embedded browser if CF returns HTML / empty (desktop IP blocks).
  return once(false).then(function (list) {
    if (list.length) return list;
    return once(true);
  });
}

function _parseTorrentioStream(s) {
  if (!s || !s.infoHash) return null;
  var lines = String(s.title || '').split('\n');
  var release = _trim(lines[0] || '');
  var blob = String(s.title || '') + '\n' + String(s.name || '');
  var seeders = 0;
  var sm = blob.match(/👤\s*([\d.]+[kKmM]?)/) || blob.match(/(\d+)\s*seed/i);
  if (sm) {
    var raw = sm[1];
    if (/k$/i.test(raw)) seeders = Math.round(parseFloat(raw) * 1000);
    else if (/m$/i.test(raw)) seeders = Math.round(parseFloat(raw) * 1000000);
    else seeders = parseInt(raw, 10) || 0;
  }
  var sizeStr = (blob.match(/💾\s*([\d.]+\s*[TGMK]B)/i) || [])[1] || '';
  var size = _parseSizeToBytes(sizeStr);
  var filename = (s.behaviorHints && s.behaviorHints.filename) || '';
  // Sometimes the episode path is on line 2 of the title.
  if (!filename && lines.length > 1) {
    for (var i = 1; i < lines.length; i++) {
      if (_VIDEO_EXT.test(lines[i])) { filename = _basename(lines[i]); break; }
    }
  }
  var q = _quality(s.name) || _quality(filename) || _quality(release) || null;
  var mega = /complete\s+series|s01\s*[-–]\s*s\d{1,2}|season\s*1\s*-\s*\d+|\[1-\d{2,4}\]|\(001-\d{3}\)/i.test(release);
  var tagBlob = (release + ' ' + filename + ' ' + blob).toLowerCase();
  var audioKind = _detectAudioKind(tagBlob);
  return {
    hash: String(s.infoHash).toLowerCase(),
    title: release || filename || s.infoHash,
    filename: filename,
    magnet: 'magnet:?xt=urn:btih:' + s.infoHash,
    size: size,
    seeders: seeders,
    quality: q,
    mega: mega,
    fileIdx: s.fileIdx,
    audioKind: audioKind
  };
}

// Tag streams so the app's pickDefault(prefer: dub|sub) can honor Settings.
// Dual Audio ⇒ dub (has English). Bare "multi" without eng is NOT dub.
function _detectAudioKind(blob) {
  var s = String(blob || '').toLowerCase();
  if (!s) return 'raw';
  if (/\bdual[\s._-]*audio\b|\bdualaudio\b/.test(s)) return 'dub';
  if (/\b(?:eng(?:lish)?[\s._-]*)?dub(?:bed)?\b/.test(s) && !/\bdubtitle/.test(s)) return 'dub';
  if (/\b(?:multi[\s._-]*audio|multiaudio)\b/.test(s)
    && /\b(?:eng(?:lish)?|en)\b/.test(s)) return 'dub';
  if (/\b(?:soft[\s._-]*)?subs?\b|\bhardsub|\bmulti[\s._-]*subs?\b/.test(s)
    && !/\bdub(?:bed)?\b|\bdual[\s._-]*audio\b/.test(s)) return 'sub';
  // Japanese-only / unmarked anime rips — treat as sub, not dub.
  if (/\b(?:jpn?|japanese|raw)\b/.test(s) && !/\b(?:eng(?:lish)?|dual|dub)\b/.test(s)) {
    return 'sub';
  }
  return 'raw';
}

function _episodeMatchScore(c, season, episode, isMovie, absEp) {
  if (isMovie || !c.filename) return 0;
  if (!_boostEpisodeMatch()) return 0;
  var parsed = _parseEpFromName(c.filename);
  if (!parsed) return 0;
  if (parsed.absolute && absEp && parsed.e === absEp) return 2200;
  if (season && episode && parsed.s === season && parsed.e === episode) return 2000;
  if (absEp && parsed.s === 0 && parsed.e === absEp) return 1800;
  if (episode && parsed.s === 0 && parsed.e === episode) return 800;
  if (episode && parsed.e === episode) return 400;
  if (absEp && parsed.e === absEp) return 600;
  if (season || episode || absEp) return -500;
  return 0;
}

function _rankCandidates(streams, season, episode, isMovie, absEp) {
  var out = [];
  var seenHash = {};
  for (var i = 0; i < streams.length; i++) {
    var c = _parseTorrentioStream(streams[i]);
    if (!c) continue;
    if (seenHash[c.hash]) continue;
    seenHash[c.hash] = 1;
    // Keep Torrentio order (sort/limit already applied server-side). Only adjust
    // for obvious misfiles and mega packs the player cannot use.
    c._score = _episodeMatchScore(c, season, episode, isMovie, absEp);
    if (c.mega) c._score -= 1500;
    if (c.size > 40 * 1073741824) c._score -= 800;
    else if (c.size > 15 * 1073741824) c._score -= 300;
    out.push(c);
  }
  if (_boostEpisodeMatch()) {
    out.sort(function (a, b) {
      if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);
      return 0;
    });
  }
  var cap = _maxCandidates();
  if (out.length > cap) out = out.slice(0, cap);
  return out;
}

function _checkCachedFiles(key, hashes) {
  if (!hashes.length) return Promise.resolve({});
  return _tbPostJson('/torrents/checkcached?format=object&list_files=true', key, {
    hashes: hashes
  }).then(function (j) {
    if (!j || j.success === false || !j.data) {
      var q = hashes.map(function (h) { return 'hash=' + encodeURIComponent(h); }).join('&');
      return _tbGet('/torrents/checkcached?' + q + '&format=object&list_files=true', key)
        .then(function (j2) { return (j2 && j2.data) || {}; });
    }
    return j.data || {};
  }).then(function (data) {
    var map = {};
    if (!data || typeof data !== 'object') return map;
    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) {
        var it = data[i];
        if (it && it.hash) map[String(it.hash).toLowerCase()] = it;
      }
      return map;
    }
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      map[String(k).toLowerCase()] = data[k];
    }
    return map;
  }).catch(function () { return {}; });
}

function _createTorrent(key, magnet, cachedOnly) {
  // allow_zip=false: huge anime packs otherwise collapse to one .zip on TorBox.
  var form = 'magnet=' + encodeURIComponent(magnet) + '&allow_zip=false';
  if (cachedOnly) form += '&add_only_if_cached=true';
  return _tbPostForm('/torrents/createtorrent', key, form);
}

function _getTorrentById(key, id) {
  // Single-id lookup only — NEVER fetch full mylist (can be multi‑MB and blows
  // the app's ~8s playback resolve budget).
  return _tbGet('/torrents/mylist?id=' + encodeURIComponent(String(id)) + '&bypass_cache=true', key)
    .then(function (j) {
      var d = j && j.data;
      if (!d) return null;
      return Array.isArray(d) ? (d[0] || null) : d;
    });
}

function _torrentIdFromCreate(j) {
  if (!j) return null;
  var d = j.data;
  if (d && typeof d === 'object') {
    if (d.torrent_id != null) return d.torrent_id;
    if (d.id != null) return d.id;
  }
  return null;
}

function _requestDl(key, torrentId, fileId) {
  var q = 'token=' + encodeURIComponent(key)
    + '&torrent_id=' + encodeURIComponent(String(torrentId))
    + '&file_id=' + encodeURIComponent(String(fileId))
    + '&redirect=false';
  return _tbGet('/torrents/requestdl?' + q, key).then(function (j) {
    if (!j || j.success === false) return null;
    var d = j.data;
    if (typeof d === 'string' && /^https?:\/\//i.test(d)) return d;
    if (d && typeof d === 'object') {
      if (d.url) return d.url;
      if (d.link) return d.link;
      if (d.download) return d.download;
    }
    return null;
  });
}

// TorBox transcoded HLS (Stremio-style). Needs web streaming on the account;
// PLAN_RESTRICTED_FEATURE → caller falls back to requestdl.
function _webStreamUrl(key, torrentId, fileId) {
  var cq = 'id=' + encodeURIComponent(String(torrentId))
    + '&file_id=' + encodeURIComponent(String(fileId))
    + '&type=torrent';
  return _tbGet('/stream/createstream?' + cq, key).then(function (j) {
    if (!j || j.success === false) return null;
    var data = j.data;
    var presigned = (data && (data.presigned_token || data.presignedToken)) || null;
    if (!presigned) return null;
    var dq = 'presigned_token=' + encodeURIComponent(String(presigned))
      + '&token=' + encodeURIComponent(key);
    return _tbGet('/stream/getstreamdata?' + dq, key).then(function (j2) {
      if (!j2 || j2.success === false) return null;
      var hls = j2.data && j2.data.hls_url;
      return (typeof hls === 'string' && /^https?:\/\//i.test(hls)) ? hls : null;
    });
  }).catch(function () { return null; });
}

function _playbackUrl(key, torrentId, fileId, streamOnly) {
  if (!_useWebStreaming()) return _requestDl(key, torrentId, fileId);
  return _webStreamUrl(key, torrentId, fileId).then(function (hls) {
    if (hls) return hls;
    if (streamOnly) return null;
    return _requestDl(key, torrentId, fileId);
  });
}

function _sourceFrom(url, cand, file, cached) {
  if (!url) return null;
  var q = cand.quality || _quality(cand.filename) || _quality(file && file.name) || 'auto';
  var size = _sizeLabel((file && file.size) || cand.size);
  var display = _basename(cand.filename || (file && file.name) || cand.title || 'TorBox');
  var label = (q !== 'auto' ? q + ' · ' : '') + display;
  if (size) label += ' · ' + size;
  if (cached) label = '⚡ ' + label;
  if (/\.m3u8(\?|$)/i.test(url) && !/\bHLS\b/i.test(label)) label += ' · HLS';
  var kind = cand.audioKind || 'raw';
  if (kind === 'dub' && !/\bdub\b|\bdual/i.test(label)) label += ' · Dub';
  return {
    url: url,
    quality: q,
    label: label,
    container: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4',
    kind: kind,
    audioLang: kind === 'dub' ? 'en' : (kind === 'sub' ? 'ja' : '')
  };
}

function _cacheHasPlayableFile(cacheInfo, season, episode, isMovie, preferredName, absEp) {
  var files = (cacheInfo && cacheInfo.files) || [];
  return !!_pickFile(files, season, episode, isMovie, preferredName, absEp);
}

// Fast path: checkcached file list + createtorrent → requestdl.
// Avoids full /mylist (multi‑MB) which was causing 8s playback timeouts.
function _resolveOne(key, cand, cacheInfo, season, episode, isMovie, cachedOnly, absEp, streamOnly) {
  var cacheFiles = (cacheInfo && cacheInfo.files) || [];
  var picked = _pickFile(cacheFiles, season, episode, isMovie, cand.filename, absEp);

  function finish(torrentId, files, cached) {
    if (torrentId == null) return Promise.resolve(null);
    var file = _pickFile(files || cacheFiles, season, episode, isMovie, cand.filename, absEp) || picked;
    if (!file || file.id == null) return Promise.resolve(null);
    return _playbackUrl(key, torrentId, file.id, !!streamOnly).then(function (url) {
      return _sourceFrom(url, cand, file, cached);
    });
  }

  function afterCreate(j) {
    if (!j) return null;
    var tid = _torrentIdFromCreate(j);

    if (j.success === false) {
      // Already in the account — data sometimes still carries the id.
      if (j.error === 'DUPLICATE_ITEM' && tid != null) {
        if (picked) return finish(tid, cacheFiles, true);
        return _getTorrentById(key, tid).then(function (t) {
          return finish(tid, (t && t.files) || cacheFiles, true);
        });
      }
      // No id and no full-list lookup — skip to the next candidate.
      return null;
    }

    if (tid == null) return null;

    // Cached hits usually already have file ids from checkcached — skip mylist.
    if (picked) {
      return finish(tid, cacheFiles, true).then(function (src) {
        if (src) return src;
        // File-id mismatch fallback: one single-id mylist fetch.
        return _getTorrentById(key, tid).then(function (t) {
          return finish(tid, (t && t.files) || [], !!(t && t.cached));
        });
      });
    }

    // Uncached / no file list yet — one quick single-id poll, not a long loop.
    return _getTorrentById(key, tid).then(function (t) {
      if (t && t.files && t.files.length) {
        return finish(tid, t.files, !!(t.cached || cacheInfo));
      }
      if (cachedOnly) return null;
      return _sleep(800).then(function () {
        return _getTorrentById(key, tid).then(function (t2) {
          return finish(tid, (t2 && t2.files) || [], !!(t2 && t2.cached));
        });
      });
    });
  }

  return _createTorrent(key, cand.magnet, cachedOnly)
    .then(afterCreate)
    .catch(function () { return null; });
}

function _isFastPlayback(fast) {
  return fast === true || fast === 1 || fast === 'true';
}

function getVideoSources(episodeUrl, fast) {
  var playbackFast = _isFastPlayback(fast);
  var key = _apiKey();
  if (!key) return Promise.resolve([]);
  var p = _parseUrl(episodeUrl);
  if (!p) return Promise.resolve([]);
  var isMovie = p.kind === 'movie';
  var season = isMovie ? 0 : (p.season || 0);
  var episode = isMovie ? 0 : (p.episode || 0);
  var absEp = isMovie ? null : (p.abs || null);
  var cachedOnly = _cachedOnly();
  var webHls = _useWebStreaming();
  var maxOut = 6;
  // HLS path: createstream + getstreamdata per unlock — stay inside ~8s playback budget.
  if (playbackFast && webHls) maxOut = 1;

  return _ensureImdb(p.kind, p.tmdbId, p.imdb).then(function (imdb) {
    if (!imdb) return [];
    // season/episode in URL are season-relative (Torrentio). abs is anime absolute.
    return _torrentioStreams(imdb, isMovie, season, episode).then(function (streams) {
      var cands = _rankCandidates(streams, season, episode, isMovie, absEp);
      if (!cands.length) return [];
      // Playback has an ~8s app budget unless TorBox is pinned; huge checkcached
      // payloads for every candidate were eating most of it.
      var hashCap = playbackFast
        ? (webHls ? Math.min(cands.length, 2) : Math.min(cands.length, maxOut + 3))
        : cands.length;
      var hashes = cands.slice(0, hashCap).map(function (c) { return c.hash; });
      return _checkCachedFiles(key, hashes).then(function (cacheMap) {
        var filtered = cands.filter(function (c) {
          if (playbackFast && hashes.indexOf(c.hash) < 0) return false;
          var info = cacheMap[c.hash];
          if (cachedOnly) {
            if (!info) return false;
            // Prefer hashes where checkcached already lists a matching video file.
            return _cacheHasPlayableFile(info, season, episode, isMovie, c.filename, absEp)
              || !!(info.files && info.files.length)
              || !!(info.name || info.size);
          }
          return true;
        });
        if (_preferCachedFirst()) {
          filtered.sort(function (a, b) {
            var af = _cacheHasPlayableFile(cacheMap[a.hash], season, episode, isMovie, a.filename, absEp) ? 1 : 0;
            var bf = _cacheHasPlayableFile(cacheMap[b.hash], season, episode, isMovie, b.filename, absEp) ? 1 : 0;
            if (af !== bf) return bf - af;
            var ac = cacheMap[a.hash] ? 1 : 0;
            var bc = cacheMap[b.hash] ? 1 : 0;
            if (ac !== bc) return bc - ac;
            return (b._score || 0) - (a._score || 0);
          });
        }
        if (!filtered.length) return [];

        var toResolve = filtered.slice(0, maxOut);

        if (playbackFast && webHls) {
          // One candidate, HLS only (no requestdl fallback) — parallel unlock blew the budget.
          var c0 = toResolve[0];
          if (!c0) return [];
          c0.cached = !!cacheMap[c0.hash];
          return _resolveOne(
            key, c0, cacheMap[c0.hash], season, episode, isMovie, cachedOnly, absEp, true
          ).then(function (src) { return src ? [src] : []; });
        }

        if (playbackFast) {
          // Unlock mirrors in parallel so playback fits the per-source time budget.
          return Promise.all(toResolve.map(function (c) {
            c.cached = !!cacheMap[c.hash];
            return _resolveOne(
              key, c, cacheMap[c.hash], season, episode, isMovie, cachedOnly, absEp, false
            );
          })).then(function (results) {
            var out = [];
            for (var ri = 0; ri < results.length; ri++) {
              if (results[ri]) out.push(results[ri]);
            }
            return out;
          });
        }

        var out = [];
        function next(i) {
          if (i >= toResolve.length || out.length >= maxOut) return out;
          var c = toResolve[i];
          c.cached = !!cacheMap[c.hash];
          return _resolveOne(key, c, cacheMap[c.hash], season, episode, isMovie, cachedOnly, absEp, false)
            .then(function (src) {
              if (src) out.push(src);
              return next(i + 1);
            });
        }
        return next(0);
      });
    });
  }).catch(function () { return []; });
}
