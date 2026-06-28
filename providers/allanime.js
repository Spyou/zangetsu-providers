// AllAnime provider — https://allanime.to (API: https://api.allanime.day/api)

var API = 'https://api.allanime.day/api';
var REFERER = 'https://youtu-chan.com';
var ORIGIN = 'https://youtu-chan.com';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';
var SOURCE_ID = 'allanime';
var SOURCES_HASH = 'd405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec';
var ALLANIME_KEY_SEED = 'Xot36i3lK3:v1';

var _HEXMAP = {"79":"A","7a":"B","7b":"C","7c":"D","7d":"E","7e":"F","7f":"G","70":"H","71":"I","72":"J","73":"K","74":"L","75":"M","76":"N","77":"O","68":"P","69":"Q","6a":"R","6b":"S","6c":"T","6d":"U","6e":"V","6f":"W","60":"X","61":"Y","62":"Z","59":"a","5a":"b","5b":"c","5c":"d","5d":"e","5e":"f","5f":"g","50":"h","51":"i","52":"j","53":"k","54":"l","55":"m","56":"n","57":"o","48":"p","49":"q","4a":"r","4b":"s","4c":"t","4d":"u","4e":"v","4f":"w","40":"x","41":"y","42":"z","08":"0","09":"1","0a":"2","0b":"3","0c":"4","0d":"5","0e":"6","0f":"7","00":"8","01":"9","15":"-","16":".","67":"_","46":"~","02":":","17":"/","07":"?","1b":"#","63":"[","65":"]","78":"@","19":"!","1c":"$","1e":"&","10":"(","11":")","12":"*","13":"+","14":",","03":";","05":"=","1d":"%"};

function decodeSourceUrl(s) {
  s = String(s);
  if (s.indexOf('--') !== 0) return s;
  var body = s.slice(2), out = '';
  for (var i = 0; i + 1 < body.length; i += 2) { var ch = _HEXMAP[body.substr(i, 2)]; out += (ch == null ? '' : ch); }
  return out.replace('/clock', '/clock.json');
}
globalThis.__allanimeDecodeSourceUrl = decodeSourceUrl; // test hook

var SEARCH_GQL = 'query( $search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType ) { shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) { edges { _id name thumbnail availableEpisodes __typename } }}';
var SHOW_GQL = 'query ($showId: String!) { show( _id: $showId ) { _id name englishName thumbnail description malId availableEpisodes availableEpisodesDetail }}';

function _headers() { return { 'Referer': REFERER, 'Origin': ORIGIN, 'User-Agent': UA, 'Content-Type': 'application/json' }; }

function _post(query, variables) {
  return fetch(API, { method: 'POST', headers: _headers(), body: JSON.stringify({ variables: variables, query: query }) })
    .then(function (r) {
      if (!r.ok) throw new Error('AllAnime: HTTP ' + r.status);
      try { return JSON.parse(r.body || 'null'); } catch (e) { throw new Error('AllAnime: bad JSON (' + r.status + ')'); }
    });
}

function getInfo() {
  return { name: 'AllAnime', lang: 'en', baseUrl: 'https://allanime.to', logo: 'https://allanime.to/favicon.ico', type: 'anime', version: '1.0.4' };
}

// ── Episode thumbnails (Kitsu, keyed by the show's malId) ────────────────────
// AllAnime episodes carry no per-episode image, so the app falls back to the
// series poster. Kitsu has broad per-episode thumbnails (incl. older anime) and
// is reachable where TMDB is ISP-blocked. Map malId -> Kitsu id, then page its
// episodes. Best-effort: only fills `thumbnail`, never touches ids/numbers/urls
// or playback. Returns { episodeNumber: thumbnailUrl }.
function _kitsuStills(malId) {
  if (!malId) return Promise.resolve({});
  var H = { 'Accept': 'application/vnd.api+json', 'User-Agent': UA };
  var mapUrl = 'https://kitsu.io/api/edge/mappings?filter%5BexternalSite%5D=myanimelist/anime'
    + '&filter%5BexternalId%5D=' + encodeURIComponent(malId) + '&include=item';
  return fetch(mapUrl, { headers: H, timeoutMs: 8000 }).then(function (r) {
    var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { return {}; }
    var inc = (j && j.included) || [];
    var kid = null;
    for (var i = 0; i < inc.length; i++) {
      if (inc[i] && inc[i].type === 'anime') { kid = inc[i].id; break; }
    }
    if (!kid) return {};
    var map = {};
    function page(off, depth) {
      if (depth > 8) return map;
      var u = 'https://kitsu.io/api/edge/anime/' + kid +
        '/episodes?page%5Blimit%5D=20&page%5Boffset%5D=' + off;
      return fetch(u, { headers: H, timeoutMs: 8000 }).then(function (r2) {
        var d; try { d = JSON.parse(r2.body || 'null'); } catch (e) { return map; }
        var eps = (d && d.data) || [];
        for (var k = 0; k < eps.length; k++) {
          var at = eps[k].attributes || {};
          var th = at.thumbnail && at.thumbnail.original;
          if (at.number != null && th) map[at.number] = th;
        }
        if (eps.length < 20) return map;
        return page(off + 20, depth + 1);
      }).catch(function () { return map; });
    }
    return page(0, 0);
  }).catch(function () { return {}; });
}

function _mode(opts) { var m = (opts && opts.category) || 'sub'; return (m === 'dub') ? 'dub' : 'sub'; }

function search(query, page, opts) {
  var vars = { search: { allowAdult: false, allowUnknown: false, query: String(query || '') }, limit: 26, page: page || 1, translationType: _mode(opts), countryOrigin: 'ALL' };
  return _post(SEARCH_GQL, vars).then(function (j) {
    var edges = (j && j.data && j.data.shows && j.data.shows.edges) || [];
    var out = [];
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      out.push({ id: e._id, title: e.name, cover: e.thumbnail || null, url: e._id, type: 'anime', sourceId: SOURCE_ID });
    }
    return out;
  });
}

var POPULAR_GQL = 'query($type:VaildPopularTypeEnumType!,$size:Int!,$dateRange:Int,$page:Int,$allowAdult:Boolean,$allowUnknown:Boolean){queryPopular(type:$type,size:$size,dateRange:$dateRange,page:$page,allowAdult:$allowAdult,allowUnknown:$allowUnknown){recommendations{anyCard{_id name englishName thumbnail availableEpisodes __typename}}}}';

function popular(opts) {
  opts = opts || {};
  var vars = { type: 'anime', size: opts.size || 26,
    dateRange: (opts.dateRange == null ? 7 : opts.dateRange),
    page: opts.page || 1, allowAdult: false, allowUnknown: false };
  return _post(POPULAR_GQL, vars).then(function (j) {
    var recs = (j && j.data && j.data.queryPopular && j.data.queryPopular.recommendations) || [];
    var out = [];
    for (var i = 0; i < recs.length; i++) {
      var c = recs[i] && recs[i].anyCard; if (!c || !c._id) continue;
      var ae = c.availableEpisodes || {};
      out.push({ id: c._id, title: c.name, englishTitle: c.englishName || null,
        cover: c.thumbnail || null, url: c._id, type: 'anime', sourceId: SOURCE_ID,
        subCount: ae.sub || 0, dubCount: ae.dub || 0 });
    }
    return out;
  });
}

// CloudStream-style home rows. AllAnime's only listing knob is queryPopular's
// dateRange, so we expose it as four genuinely-different windows.
function getHome(opts) {
  opts = opts || {};
  var cat = _mode(opts);
  var rows = [
    { title: 'Trending Now',       dateRange: 1 },
    { title: 'Popular This Week',  dateRange: 7 },
    { title: 'New This Month',     dateRange: 30 },
    { title: 'All-Time Favorites', dateRange: 0 }
  ];
  return Promise.all(rows.map(function (r) {
    return popular({ category: cat, dateRange: r.dateRange, page: 1 })
      .then(function (items) { return { title: r.title, items: items }; })
      .catch(function () { return { title: r.title, items: [] }; });
  }));
}

function getDetail(url, opts) {
  var showId = String(url);
  var cat = (opts && opts.category === 'dub') ? 'dub' : 'sub';
  return _post(SHOW_GQL, { showId: showId }).then(function (j) {
    var show = (j && j.data && j.data.show) || {};
    var aed = show.availableEpisodesDetail || {};
    var ae = show.availableEpisodes || {};
    var keys = (aed[cat] || []).slice().sort(function (a, b) { return parseFloat(a) - parseFloat(b); });
    var eps = [];
    for (var i = 0; i < keys.length; i++) {
      var n = keys[i];
      eps.push({ id: cat + ':' + n, title: 'Episode ' + n, number: parseFloat(n),
        url: 'allanime://' + showId + '/' + cat + '/' + n });
    }
    var detail = { id: showId, title: show.name || showId, englishTitle: show.englishName || null,
      cover: show.thumbnail || null, url: showId, description: htmlText(show.description || ''),
      status: 'unknown', genres: [], studios: [], type: 'anime', sourceId: SOURCE_ID,
      // MAL id drives tracker sync (AniList/MAL/Simkl) in the app.
      malId: (show.malId != null) ? parseInt(show.malId, 10) : null,
      episodes: eps, subCount: (ae.sub != null ? ae.sub : (aed.sub || []).length),
      dubCount: (ae.dub != null ? ae.dub : (aed.dub || []).length) };
    // Best-effort episode stills from Jikan (additive; poster fallback on miss).
    return _kitsuStills(show.malId).then(function (stills) {
      if (stills) {
        for (var k = 0; k < eps.length; k++) {
          var img = stills[eps[k].number];
          if (img) eps[k].thumbnail = img;
        }
      }
      return detail;
    }).catch(function () { return detail; });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

var SOURCES_GQL = 'query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) { episode( showId: $showId translationType: $translationType episodeString: $episodeString ) { episodeString sourceUrls }}';

function _fetchSourceUrls(showId, mode, epNo) {
  var variables = encodeURIComponent(JSON.stringify({ showId: showId, translationType: mode, episodeString: String(epNo) }));
  var extensions = encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: SOURCES_HASH } }));
  var url = API + '?variables=' + variables + '&extensions=' + extensions;
  return fetch(url, { headers: { 'Referer': REFERER, 'Origin': ORIGIN, 'User-Agent': UA } })
    .then(function (r) {
      var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { throw new Error('AllAnime sources: bad JSON'); }
      var data = j && j.data;
      if (data && data.tobeparsed) return _decryptTobeparsed(data.tobeparsed);
      if (data && data.episode && data.episode.sourceUrls) return data.episode.sourceUrls;
      throw new Error('AllAnime: no sources in response');
    });
}

function _decryptTobeparsed(b64) {
  return sha256Hex(ALLANIME_KEY_SEED).then(function (keyHex) {
    var bytes = base64ToBytes(b64);
    var iv = bytes.slice(1, 13);
    var counterHex = bytesToHex(iv) + '00000002';
    var ct = bytes.slice(13, bytes.length - 16);
    return aesCtrDecrypt({ keyHex: keyHex, counterHex: counterHex, dataB64: bytesToB64(ct) })
      .then(function (plain) {
        var obj; try { obj = JSON.parse(plain); } catch (e) { throw new Error('AllAnime: decrypt parse failed'); }
        return (obj.episode && obj.episode.sourceUrls) || obj.sourceUrls || [];
      });
  });
}

function _resolveClock(path, mode) {
  return fetch('https://allanime.day' + path, { headers: { 'Referer': REFERER, 'User-Agent': UA }, timeoutMs: 8000 })
    .then(function (r) {
      var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { return []; }
      var links = (j && j.links) || [];
      var out = [];
      for (var i = 0; i < links.length; i++) {
        var lk = links[i]; var u = lk.link || lk.url; if (!u) continue;
        var isHls = lk.hls === true || /\.m3u8/.test(u) || /repackager\.wixmp/.test(u);
        out.push({ url: u, quality: lk.resolutionStr || '', container: isHls ? 'hls' : 'mp4',
          headers: { 'Referer': REFERER, 'User-Agent': UA }, kind: mode, audioLang: mode === 'dub' ? 'en' : 'ja', subtitles: [] });
      }
      return out;
    });
}

function _settleWithDeadline(jobs, deadlineMs) {
  return new Promise(function (resolve) {
    var results = [];
    var pending = jobs.length;
    var done = false;
    function finish() { if (!done) { done = true; resolve(results); } }
    if (pending === 0) { resolve(results); return; }
    for (var i = 0; i < jobs.length; i++) {
      Promise.resolve(jobs[i])
        .then(function (arr) { if (arr && arr.length) results = results.concat(arr); })
        .catch(function () {})
        .then(function () { pending -= 1; if (pending === 0) finish(); });
    }
    setTimeout(finish, deadlineMs);
  });
}
globalThis.__allanimeSettleWithDeadline = _settleWithDeadline; // test hook

function getVideoSources(episodeUrl) {
  var m = String(episodeUrl).replace('allanime://', '').split('/');
  var showId = m[0], mode = (m[1] === 'dub') ? 'dub' : 'sub', epNo = m[2];
  return _fetchSourceUrls(showId, mode, epNo).then(function (sourceUrls) {
    var SKIP = { 'Ss-Hls': 1 }; // dead host
    var hdr = { 'Referer': REFERER, 'User-Agent': UA };
    // Resolve in PRIORITY order (desc) so the best source — usually the direct
    // `Yt-mp4` on AllAnime's own CDN (a real, range-streamable .mp4) — is the
    // first one ready, which is what the player's fast-start picks.
    var list = sourceUrls.slice().sort(function (a, b) {
      return (b.priority || 0) - (a.priority || 0);
    });
    var jobs = [];
    for (var i = 0; i < list.length; i++) {
      var su = list[i]; var name = su.sourceName || ''; var raw = String(su.sourceUrl || '');
      var type = su.sourceName ? (su.type || '') : '';
      if (SKIP[name]) continue;
      // 1. AllAnime-internal clock endpoint (`--`-obfuscated) → its links API.
      if (raw.indexOf('--') === 0) {
        var path = decodeSourceUrl(raw);
        if (path.indexOf('/clock') !== -1) {
          jobs.push(_resolveClock(path, mode).catch(function () { return []; }));
        }
        continue;
      }
      if (!/^https?:\/\//.test(raw)) continue;
      // 2. A `player` source (or a bare media file) is a DIRECT stream — use it
      //    as-is. Everything else is an iframe EMBED: run the host extractors
      //    (ok.ru / mp4upload / streamlare / …). Unsupported embed hosts return
      //    [] instead of being mis-added as a broken "mp4" (which black-screened
      //    the player). `type:'player'` is AllAnime's own direct-CDN marker.
      if (type === 'player' || /\.(m3u8|mp4)(\?|$)/i.test(raw)) {
        jobs.push(Promise.resolve([{ url: raw, quality: su.resolutionStr || '',
          container: /\.m3u8/i.test(raw) ? 'hls' : 'mp4', headers: hdr,
          kind: mode, audioLang: mode === 'dub' ? 'en' : 'ja', subtitles: [] }]));
      } else {
        jobs.push(extractVideo(raw, { headers: hdr, kind: mode, audioLang: mode === 'dub' ? 'en' : 'ja' }).catch(function () { return []; }));
      }
    }
    var deadline = (typeof globalThis.__allanimeDeadlineMs === 'number') ? globalThis.__allanimeDeadlineMs : 6000;
    return _settleWithDeadline(jobs, deadline).then(function (all) {
      if (all.length === 0) throw new Error('AllAnime: no playable sources');
      return all;
    });
  });
}
