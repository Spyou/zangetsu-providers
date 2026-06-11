// AnimePahe — anime source for the Zangetsu provider repo (animepahe.ru).
//
// AnimePahe is Cloudflare/DDoS-Guard protected, so every request to the
// animepahe host goes through the app's native WebView solver via
// fetch(url, { browser: true }) (attaches cf_clearance + matching UA). The
// chain is JSON-API for the catalog + one HTML hop for the kwik embeds:
//   search/airing/release (api?m=…)  ->  play/{anime}/{episode} HTML
//   ->  <button data-src="https://kwik.si/e/…" data-resolution data-audio>
//   ->  kwik /e/ page  ->  packed eval(function(p,a,c,k,e,d){…})  (Dean-Edwards)
//   ->  unpack  ->  const source='<m3u8>'   (one m3u8 per quality+audio).
// The m3u8 is served by kwik and needs Referer: https://kwik.si/.
//
// Ported faithfully from the current Pal-droid/Animepahe-API (FastAPI) flow
// and KevCui/animepahe-dl (the kwik "const source='…'" extraction), since the
// consumet reference is DMCA-removed. The kwik script is Dean-Edwards packed;
// the host's built-in unpackJs is too rigid, so we bundle an escape-aware
// unpacker here (same pattern as multimovies' _unpack/_readStr).

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'animepahe';

// Domain rotates often. animepahe.ru is now a PARKED page; the current live
// host is animepahe.pw (animepahe.com/.org 301 → .pw). Update here if it moves.
// cf_clearance is cached per host by the app's WebView solver.
var BASE = 'https://animepahe.pw';
var KWIK_REFERER = 'https://kwik.si/';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function getInfo() {
  return { name: 'AnimePahe', lang: 'en', baseUrl: BASE,
    logo: BASE + '/favicon.ico', type: 'anime', version: '1.0.0' };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
function _baseOf(url) { return (String(url).match(/^(https?:\/\/[^/]+)/) || [])[1] || ''; }

// All animepahe requests go through the Cloudflare solver (browser:true). The
// api endpoints want an XHR-style request; the play page is a normal GET.
function _api(path) {
  return fetch(BASE + path, {
    browser: true,
    headers: {
      'User-Agent': UA, 'Referer': BASE + '/',
      'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json'
    }
  }).then(function (r) {
    var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { j = null; }
    return j;
  }).catch(function () { return null; });
}
function _getPage(url, ref) {
  return fetch(url, {
    browser: true,
    headers: { 'User-Agent': UA, 'Referer': ref || BASE + '/' }
  }).then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
// kwik is usually NOT behind Cloudflare (try plain first); fall back to the
// solver if the plain request looks blocked.
function _getKwik(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || BASE + '/' } })
    .then(function (r) {
      var html = r.body || '';
      if (r.ok && html && /eval\(|\.m3u8|kwik/i.test(html)) return html;
      return fetch(url, { browser: true, headers: { 'User-Agent': UA, 'Referer': ref || BASE + '/' } })
        .then(function (r2) { return r2.body || html; }).catch(function () { return html; });
    }).catch(function () {
      return fetch(url, { browser: true, headers: { 'User-Agent': UA, 'Referer': ref || BASE + '/' } })
        .then(function (r2) { return r2.body || ''; }).catch(function () { return ''; });
    });
}

// ── Dean-Edwards p,a,c,k,e,d unpacker (kwik) ──────────────────────────────────
// The host's unpackJs hardcodes base 62 and a literal `.split('|'),0,{}))`
// tail; kwik's packer varies, so we parse it ourselves. _readStr honours \'
// and \\ escapes inside the single-quoted payload/dictionary.
function _readStr(s, i) {
  var out = ''; i++;
  while (i < s.length) {
    var c = s[i];
    if (c === '\\') { out += s[i + 1]; i += 2; continue; }
    if (c === "'") return { str: out, next: i + 1 };
    out += c; i++;
  }
  return { str: out, next: i };
}
function _unpack(s) {
  s = String(s);
  var h = s.indexOf("}('");
  if (h < 0 || s.indexOf(".split('|')") < 0) return s;
  var p = _readStr(s, h + 2);                 // payload template
  var rest = s.slice(p.next);                 // ,BASE,COUNT,'DICT'.split('|')…
  var m = rest.match(/^,(\d+),(\d+),/);
  if (!m) return s;
  var base = parseInt(m[1], 10), count = parseInt(m[2], 10);
  var d = _readStr(s, p.next + m[0].length);  // dictionary
  var dict = d.str.split('|');
  function enc(n) {
    return (n < base ? '' : enc(Math.floor(n / base))) +
      ((n = n % base) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  }
  var out = p.str;
  while (count--) {
    if (dict[count]) out = out.replace(new RegExp('\\b' + enc(count) + '\\b', 'g'), dict[count]);
  }
  return out;
}

// ── catalog cards ─────────────────────────────────────────────────────────────
function _year(s) { var m = String(s || '').match(/(19|20)\d{2}/); return m ? parseInt(m[0], 10) : null; }

// A search/airing record → a Zangetsu card. `session` is the anime id (the
// stable handle used by every downstream call); search uses `poster`, airing
// uses `snapshot` + anime_* prefixed fields.
function _searchCard(a) {
  if (!a || !a.session) return null;
  return {
    id: a.session, title: a.title || 'Untitled', englishTitle: null,
    cover: a.poster || null, url: a.session, type: 'anime', sourceId: SOURCE_ID,
    subCount: (a.episodes != null ? a.episodes : 0), dubCount: 0
  };
}
function _airingCard(a) {
  if (!a) return null;
  var session = a.anime_session || a.session;
  if (!session) return null;
  return {
    id: session, title: a.anime_title || a.title || 'Untitled', englishTitle: null,
    cover: a.snapshot || a.poster || null, url: session, type: 'anime', sourceId: SOURCE_ID,
    subCount: 0, dubCount: 0
  };
}

function search(query, page, opts) {
  var q = _trim(query);
  if (q.length < 1) return Promise.resolve([]);
  return _api('/api?m=search&q=' + encodeURIComponent(q)).then(function (j) {
    var list = (j && j.data) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) { var c = _searchCard(list[i]); if (c) out.push(c); }
    return out;
  }).catch(function () { return []; });
}

// Newest airing episodes (the only public listing endpoint). Paged.
function popular(opts) {
  opts = opts || {};
  var p = opts.page || 1;
  return _api('/api?m=airing&page=' + p).then(function (j) {
    var list = (j && j.data) || [];
    var out = [], seen = {};
    for (var i = 0; i < list.length; i++) {
      var c = _airingCard(list[i]);
      if (c && !seen[c.id]) { seen[c.id] = 1; out.push(c); }
    }
    return out;
  }).catch(function () { return []; });
}

// Airing is the only catalog feed, so build several rows from its first pages
// (each page is a distinct slice of recent releases). The app uses row 0 as the
// hero carousel.
function getHome(opts) {
  return Promise.all([popular({ page: 1 }), popular({ page: 2 }), popular({ page: 3 })])
    .then(function (pages) {
      var seen = {};
      function dedupe(items) {
        var o = [];
        for (var i = 0; i < items.length; i++) {
          var c = items[i];
          if (c && !seen[c.id]) { seen[c.id] = 1; o.push(c); }
        }
        return o;
      }
      var r0 = dedupe(pages[0] || []);
      var r1 = dedupe(pages[1] || []);
      var r2 = dedupe(pages[2] || []);
      var rows = [];
      if (r0.length) rows.push({ title: 'Recently Released', items: r0 });
      if (r1.length) rows.push({ title: 'More Recent', items: r1 });
      if (r2.length) rows.push({ title: 'Latest Episodes', items: r2 });
      return rows;
    }).catch(function () { return []; });
}

// ── detail / episodes ─────────────────────────────────────────────────────────
// The /anime/{session} page carries synopsis, genres, status, year and the
// canonical og:url session. Page through ALL release pages for the episode list.
function _allEpisodes(session) {
  return _api('/api?m=release&id=' + encodeURIComponent(session) + '&sort=episode_asc&page=1')
    .then(function (j) {
      var eps = (j && j.data) || [];
      var last = (j && typeof j.last_page === 'number') ? j.last_page : 1;
      function more(p) {
        if (p > last || p > 60) return eps;
        return _api('/api?m=release&id=' + encodeURIComponent(session) + '&sort=episode_asc&page=' + p)
          .then(function (j2) {
            var batch = (j2 && j2.data) || [];
            for (var i = 0; i < batch.length; i++) eps.push(batch[i]);
            return more(p + 1);
          }).catch(function () { return eps; });
      }
      return more(2);
    }).catch(function () { return []; });
}

// Episode url packs the anime session + episode session, both needed for the
// /play/{anime}/{episode} hop.
function _epUrl(animeSession, episodeSession) {
  return 'animepahe://' + animeSession + '/' + episodeSession;
}

function getDetail(url, opts) {
  var session = String(url);
  return _getPage(BASE + '/anime/' + encodeURIComponent(session), BASE + '/').then(function (html) {
    // Prefer the canonical session from og:url (search sessions sometimes
    // redirect to a different anime session used by the release API).
    var canon = (html.match(/property=["']og:url["'][^>]*content=["']([^"']+)["']/i) ||
                 html.match(/content=["']([^"']+)["'][^>]*property=["']og:url["']/i) || [])[1] || '';
    var canonSession = canon ? canon.replace(/\/$/, '').split('/').pop() : session;
    if (!canonSession) canonSession = session;

    var title = htmlText(
      (html.match(/<h1[^>]*>\s*(?:<span[^>]*>)?([\s\S]*?)<\/(?:span|h1)>/i) || [])[1] ||
      (html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || [])[1] || session);
    title = title.replace(/^\s*Anime\s*[:\-]\s*/i, '');

    var cover = (html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || [])[1] ||
      (html.match(/<div class=["']anime-poster["'][\s\S]{0,200}?<img[^>]+(?:data-src|src)=["']([^"']+)["']/i) || [])[1] || null;

    var description = htmlText(
      (html.match(/<div class=["']anime-synopsis["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
      (html.match(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i) || [])[1] || '');

    var status = 'unknown';
    var sm = html.match(/Status:[\s\S]{0,120}?<a[^>]*>([^<]+)<\/a>/i);
    if (sm) {
      var sv = _trim(sm[1]).toLowerCase();
      if (/finish|complete/.test(sv)) status = 'completed';
      else if (/airing|current|ongoing/.test(sv)) status = 'ongoing';
    }

    var genres = [], gm;
    var gblock = (html.match(/<div class=["']anime-genre["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
      (html.match(/Genres?:[\s\S]{0,800}?<\/div>/i) || [])[0] || '';
    var gre = /<a[^>]*>([^<]+)<\/a>/gi;
    while ((gm = gre.exec(gblock)) !== null) { var g = _trim(htmlText(gm[1])); if (g) genres.push(g); }
    genres = genres.slice(0, 8);

    var year = _year((html.match(/Aired:[\s\S]{0,120}?<\/p>/i) || [])[0]) ||
      _year((html.match(/Season:[\s\S]{0,80}?<a[^>]*>([^<]+)/i) || [])[1]) || null;

    var base = {
      id: session, title: title || session, englishTitle: null,
      cover: cover, url: session, description: description, status: status,
      genres: genres, studios: [], type: 'anime', sourceId: SOURCE_ID,
      episodes: [], year: year, malId: null, subCount: 0, dubCount: 0
    };

    return _allEpisodes(canonSession).then(function (eps) {
      var out = [];
      for (var i = 0; i < eps.length; i++) {
        var ep = eps[i];
        if (!ep || !ep.session) continue;
        var n = (ep.episode != null) ? parseFloat(ep.episode) : (i + 1);
        var o = {
          id: String(ep.id != null ? ep.id : n), number: n,
          title: _trim(ep.title) || ('Episode ' + n),
          url: _epUrl(canonSession, ep.session)
        };
        if (ep.snapshot) o.thumbnail = ep.snapshot; // per-episode still from the API
        out.push(o);
      }
      base.episodes = out;
      base.subCount = out.length; // dub availability is per-source (resolved at play time)
      return base;
    }).catch(function () { return base; });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// ── video resolution (play page → kwik → m3u8) ────────────────────────────────
// Parse the <button> grid on the play page. AnimePahe writes one button per
// quality+audio with data-src (kwik /e/ link), data-fansub, data-resolution
// and data-audio (jpn/eng). Attribute order varies, so read each independently.
function _parseButtons(html) {
  var out = [], m;
  var re = /<button[^>]*\bdata-src=["']([^"']+)["'][^>]*>/gi;
  while ((m = re.exec(html)) !== null) {
    var tag = m[0];
    var src = m[1];
    if (!/^https?:\/\/kwik\./i.test(src)) continue;
    var resolution = (tag.match(/data-resolution=["']([^"']+)["']/i) || [])[1] || '';
    var audio = (tag.match(/data-audio=["']([^"']+)["']/i) || [])[1] || '';
    var fansub = (tag.match(/data-fansub=["']([^"']+)["']/i) || [])[1] || '';
    out.push({ src: src, resolution: resolution, audio: audio, fansub: fansub });
  }
  // Fallback: bare kwik links if the button selector misses.
  if (!out.length) {
    var km, kre = /https:\/\/kwik\.[a-z]+\/e\/\w+/gi;
    var seen = {};
    while ((km = kre.exec(html)) !== null) {
      if (!seen[km[0]]) { seen[km[0]] = 1; out.push({ src: km[0], resolution: '', audio: '', fansub: '' }); }
    }
  }
  return out;
}

function _audioFlags(audio) {
  var a = String(audio || '').toLowerCase();
  if (a.indexOf('eng') === 0 || a === 'en') return { kind: 'dub', audioLang: 'en' };
  return { kind: 'sub', audioLang: 'ja' };
}

// kwik /e/ page → unpack the packed eval → const source='<m3u8>'.
function _resolveKwik(btn, playUrl) {
  return _getKwik(btn.src, playUrl).then(function (html) {
    if (!html) return null;
    var hay = html;
    // Most kwik pages hide the m3u8 inside the packed script; unpack first.
    if (/eval\(/.test(html)) {
      var script = (html.match(/<script[^>]*>(eval\(function[\s\S]*?)<\/script>/i) || [])[1] ||
        (html.match(/(eval\(function\(p,a,c,k,e,(?:d|r)\)[\s\S]*?\.split\('\|'\)[\s\S]*?\)\))/i) || [])[0] || '';
      if (script) {
        var unp = ''; try { unp = _unpack(script); } catch (e) {}
        if (unp) hay = html + '\n' + unp;
      }
    }
    var url =
      (hay.match(/const\s+source\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i) || [])[1] ||
      (hay.match(/\bsource\s*[:=]\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i) || [])[1] ||
      (hay.match(/https?:\/\/[^'"\\\s<>]+\.m3u8[^'"\\\s<>]*/i) || [])[0];
    if (!url) return null;

    var flags = _audioFlags(btn.audio);
    var quality = btn.resolution ? (String(btn.resolution).replace(/p$/i, '') + 'p') : 'auto';
    return {
      url: url, quality: quality,
      container: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4',
      // kwik m3u8 segments are gated on the kwik referer + UA.
      headers: { 'User-Agent': UA, 'Referer': KWIK_REFERER, 'Origin': _baseOf(KWIK_REFERER) },
      kind: flags.kind, audioLang: flags.audioLang, subtitles: [],
      label: btn.fansub || ''
    };
  }).catch(function () { return null; });
}

function getVideoSources(episodeUrl) {
  var raw = String(episodeUrl).replace('animepahe://', '');
  var parts = raw.split('/');
  var animeSession = parts[0], episodeSession = parts[1];
  if (!animeSession || !episodeSession) {
    return Promise.reject(new Error('AnimePahe: bad episode url'));
  }
  var playUrl = BASE + '/play/' + animeSession + '/' + episodeSession;
  return _getPage(playUrl, BASE + '/').then(function (html) {
    var btns = _parseButtons(html);
    if (!btns.length) throw new Error('AnimePahe: no kwik links on play page');
    var jobs = btns.map(function (b) { return _resolveKwik(b, playUrl); });
    return Promise.all(jobs).then(function (results) {
      var out = [], seen = {};
      for (var i = 0; i < results.length; i++) {
        var s = results[i];
        if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); }
      }
      if (!out.length) throw new Error('AnimePahe: no playable sources');
      // Highest quality first (matches the player's expectation).
      out.sort(function (a, b) {
        var qa = parseInt(String(a.quality).replace(/p$/i, ''), 10) || 0;
        var qb = parseInt(String(b.quality).replace(/p$/i, ''), 10) || 0;
        return qb - qa;
      });
      return out;
    });
  });
}
