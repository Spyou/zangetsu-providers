// HiAnime — anime source for the Zangetsu provider repo (hianime.at).
//
// The site renders its catalogue server-side, so browse/detail/episodes are all
// regex over HTML. The two ajax routes the player uses aren't in the page markup
// at all — the theme builds them from a `rest_url` config — so they're spelled
// out here:
//   /search?keyword=                           -> flw-item cards
//   /<slug>                                    -> poster, synopsis, sub/dub ticks
//   /api/theme/episode/list/<animeId>          -> { html } of ep-item anchors
//   /api/theme/episode/servers?episodeId=<id>  -> { html }, data-hash = b64 embed
//   <embed>/stream/getSources(New)?id=&type=   -> m3u8 + subtitle tracks
//
// The anime id is just the trailing number of the slug (dan-da-dan-86 -> 86).
//
// VidPlay (vidtube) uses getSources. MegaPlay's getSources returns an encrypted
// `enc` blob — getSourcesNew restores the plain `sources.file`. Zoko still hides
// its payload behind its own player and stays out of PLAYER_RE.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'hianime';

var SITE = 'https://hianime.at';
var API = SITE + '/api/theme/';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Embed hosts that hand back a plain m3u8 (via getSources or getSourcesNew).
var PLAYER_RE = /^https?:\/\/(?:[a-z0-9-]+\.)?(?:vidtube\.[a-z]+|megaplay\.[a-z]+)/i;

function getInfo() {
  return { name: 'HiAnime', lang: 'en', baseUrl: SITE,
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.1.1' };
}

// MegaPlay encrypts /stream/getSources; /stream/getSourcesNew still returns
// sources.file. VidPlay (vidtube) only exposes getSources.
function _sourcesUrl(base, dataId, type) {
  var path = /megaplay\.[a-z]+/i.test(String(base || ''))
    ? '/stream/getSourcesNew' : '/stream/getSources';
  return base + path + '?id=' + dataId + '&type=' + type;
}

function _mode(opts) { return (opts && opts.category === 'dub') ? 'dub' : 'sub'; }

// GET a page as text. `xhr` adds the ajax header the /api/theme routes are
// called with by the site itself — they answer without it today, but sending it
// costs nothing and survives them tightening up.
function _get(url, ref, xhr) {
  var h = { 'User-Agent': UA, 'Referer': ref || SITE + '/' };
  if (xhr) h['X-Requested-With'] = 'XMLHttpRequest';
  return fetch(url, { headers: h })
    .then(function (r) { return r.body || ''; })
    .catch(function () { return ''; });
}
// Both ajax routes answer { status, html } — the payload is an HTML string.
function _ajax(path, ref) {
  return _get(API + path, ref, true).then(function (b) {
    var j; try { j = JSON.parse(b || 'null'); } catch (e) { j = null; }
    return (j && typeof j.html === 'string') ? j.html : '';
  });
}
function _b64(s) {
  try {
    var b = base64ToBytes(String(s || '')), o = '';
    for (var i = 0; i < b.length; i++) o += String.fromCharCode(b[i]);
    return o;
  } catch (e) { return ''; }
}
function _text(s) { return htmlText(String(s || '').replace(/<[^>]*>/g, '')).replace(/^\s+|\s+$/g, ''); }
function _year(s) { var m = String(s || '').match(/(19|20)\d{2}/); return m ? m[0] : null; }
// Slug = the last path segment, with or without the /watch/ prefix, and always
// ending in the anime id (…-86). Genre/studio links have no trailing id, so
// they can't be mistaken for a title.
function _slug(chunk) {
  var m = String(chunk || '').match(/href="[^"]*\/(?:watch\/)?([a-z0-9][a-z0-9-]*-\d+)(?:\?[^"]*)?"/i);
  return m ? m[1] : null;
}
function _animeId(slug) { var m = String(slug || '').match(/-(\d+)$/); return m ? m[1] : null; }
// Sub/dub badge counts. The <i> icon inside the badge carries a class with a
// digit in it ("mr-1"), so the tags have to go before reading the number.
function _tick(chunk, name) {
  var m = String(chunk || '').match(new RegExp('tick-' + name + '"[^>]*>([\\s\\S]*?)<\\/div>'));
  if (!m) return 0;
  var n = m[1].replace(/<[^>]*>/g, '').match(/\d+/);
  return n ? parseInt(n[0], 10) : 0;
}

// ── Cards ───────────────────────────────────────────────────────────────────
// The three card shapes on the site (grid flw-item, home spotlight deslide-item,
// trending item) differ in layout but all carry a film-poster-img <img> whose
// alt is the title, plus a slug link, so one parser covers the lot. The poster
// is what tells a card apart from the site furniture that also sits in a
// `class="item"` (the az-list, the login menu).
function _cards(seg) {
  var out = [], seen = {};
  // Splitting on the card containers alone leaves the last card running to the
  // end of whatever was passed in, so it reads its badges off the sidebar or
  // the footer — end the run at the enclosing section too.
  var chunks = String(seg || '').split(/class="(?:flw-item|deslide-item|item)[\s"]|<\/section|<footer/);
  for (var i = 1; i < chunks.length; i++) {
    var c = chunks[i];
    var img = (c.match(/<img\b[^>]*film-poster-img[^>]*>/i) || [])[0];
    var slug = _slug(c);
    if (!img || !slug || seen[slug]) continue;
    var title = (img.match(/alt="([^"]+?)(?:\s+Poster)?"/i) || [])[1]
      || (c.match(/title="([^"]+)"/) || [])[1];
    if (!title) continue;
    seen[slug] = 1;
    out.push({ id: slug, title: _text(title), englishTitle: _text(title),
      cover: (img.match(/src="([^"]+)"/i) || [])[1] || null,
      url: slug, type: 'anime', sourceId: SOURCE_ID,
      subCount: _tick(c, 'sub'), dubCount: _tick(c, 'dub') });
  }
  return out;
}

// ── Search ──────────────────────────────────────────────────────────────────
// One page of results, no pagination links in the markup — page 2+ is empty
// rather than a repeat of page 1.
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 1 || (page && page > 1)) return Promise.resolve([]);
  return _get(SITE + '/search?keyword=' + encodeURIComponent(q), SITE + '/')
    .then(function (html) {
      // Results only: the page's Top 10 sidebar is built from the same card
      // markup and would otherwise ride along as matches.
      var i = html.indexOf('film_list-wrap');
      if (i < 0) return [];
      var j = html.indexOf('</section', i);
      return _cards(html.substring(i, j < 0 ? html.length : j));
    })
    .catch(function () { return []; });
}

// ── Home ────────────────────────────────────────────────────────────────────
// Sections are marked by their <h2 class="cat-heading">; slice each from its
// heading to the next one. The spotlight carousel sits above the first heading.
function getHome(opts) {
  var want = { 'Trending': 1, 'Latest Episode': 1, 'New On HiAnime': 1, 'Top Upcoming': 1 };
  return _get(SITE + '/home', SITE + '/').then(function (html) {
    var marks = [], re = /<h2 class="cat-heading[^"]*">\s*([^<]+?)\s*<\/h2>/g, m;
    while ((m = re.exec(html)) !== null) marks.push({ name: m[1], at: m.index });
    var rows = [];
    var spot = _cards(marks.length ? html.substring(0, marks[0].at) : '');
    if (spot.length) rows.push({ title: 'Spotlight', items: spot });
    for (var i = 0; i < marks.length; i++) {
      if (!want[marks[i].name]) continue;
      var end = (i + 1 < marks.length) ? marks[i + 1].at : html.length;
      var items = _cards(html.substring(marks[i].at, end));
      if (items.length) rows.push({ title: marks[i].name, items: items });
    }
    return rows;
  }).catch(function () { return []; });
}

// ── Detail + episodes ───────────────────────────────────────────────────────
function _info(html, label) {
  var m = String(html).match(new RegExp('item-head">' + label
    + ':<\\/span>\\s*<span class="name">([\\s\\S]*?)<\\/span>'));
  return m ? _text(m[1]) : null;
}
// Anchor texts out of one sidebar row. Bounded to that row's block: the page
// also carries an all-genres widget and a promo blurb that links studios, and
// scanning the whole document picks those up as the title's own.
function _infoList(html, label, cap) {
  var block = String(html).match(new RegExp('item-head">' + label
    + ':<\\/span>([\\s\\S]*?)<\\/div>'));
  if (!block) return [];
  var out = [], seen = {}, m, re = /<a\b[^>]*>\s*([^<]+?)\s*</g;
  while ((m = re.exec(block[1])) !== null && out.length < cap) {
    var t = _text(m[1]);
    if (t && !seen[t]) { seen[t] = 1; out.push(t); }
  }
  return out;
}

// The episode list gives no per-episode sub/dub flags — that only comes from the
// server list — so the url carries the category the player asked for, then the
// episode id and number. Category leads because the player's Sub/Dub toggle
// rewrites that first segment in place.
function _epUrl(cat, epId, num) { return 'hianime://' + cat + '/' + epId + '/' + num; }

// Episode thumbnails (Kitsu, keyed by MAL id). The site exposes no per-episode
// image, so without this the app falls back to the series poster. Kitsu covers
// older anime too and is reachable where TMDB is ISP-blocked. Strictly
// best-effort: any failure leaves the poster fallback and never touches
// playback. Returns { episodeNumber: thumbnailUrl }.
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

// No MAL id anywhere in the page markup, but the Zoko server's embed url is
// built as /stream/mal/<malId>/<ep>/, so one server list for the first episode
// hands it over. Drives tracker sync and the Kitsu stills above; best-effort,
// a title without that server just gets a null id.
function _malFromServers(epId, ref) {
  return _ajax('episode/servers?episodeId=' + encodeURIComponent(epId), ref).then(function (html) {
    var m, re = /data-hash="([^"]+)"/g;
    while ((m = re.exec(html)) !== null) {
      var hit = _b64(m[1]).match(/\/mal\/(\d+)\//);
      if (hit) return parseInt(hit[1], 10);
    }
    return null;
  }).catch(function () { return null; });
}

function getDetail(url, opts) {
  var slug = String(url);
  var cat = _mode(opts);
  var watchRef = SITE + '/watch/' + slug;
  return _get(SITE + '/' + encodeURIComponent(slug), SITE + '/').then(function (html) {
    var stats = (html.match(/class="film-stats"([\s\S]{0,1500})/) || [])[1] || '';
    var title = _text((html.match(/<h2[^>]*class="[^"]*film-name[^"]*"[^>]*>([\s\S]*?)<\/h2>/) || [])[1]) || slug;
    var base = {
      id: slug, title: title, englishTitle: title, url: slug,
      cover: (html.match(/class="anisc-poster"[\s\S]{0,400}?<img[^>]+src="([^"]+)"/) || [])[1] || null,
      description: _text((html.match(/class="film-description[^"]*"[\s\S]{0,200}?<div class="text">([\s\S]*?)<\/div>/) || [])[1]),
      status: _info(html, 'Status') || 'unknown',
      genres: _infoList(html, 'Genres', 8), studios: _infoList(html, 'Studios', 4),
      type: 'anime', sourceId: SOURCE_ID, episodes: [],
      year: _year(_info(html, 'Aired')), malId: null,
      subCount: _tick(stats, 'sub'), dubCount: _tick(stats, 'dub')
    };
    var animeId = (html.match(/data-animeid="(\d+)"/) || [])[1] || _animeId(slug);
    if (!animeId) return base;
    return _ajax('episode/list/' + animeId, watchRef).then(function (lhtml) {
      // The list ships every episode at once — the EPS: 001-100 dropdown only
      // pages what's already there — so long runs need no extra requests.
      var out = [], first = null, re = /<a\b([^>]*\bep-item\b[^>]*)>/g, m;
      while ((m = re.exec(lhtml)) !== null) {
        var attrs = m[1];
        var epId = (attrs.match(/data-id="(\d+)"/) || [])[1];
        if (!epId) continue;
        if (!first) first = epId;
        var n = parseInt((attrs.match(/data-number="(\d+)"/) || [])[1] || (out.length + 1), 10);
        var t = (attrs.match(/title="([^"]*)"/) || [])[1];
        out.push({ id: cat + ':' + n, number: n,
          title: t ? _text(t) : ('Episode ' + n), url: _epUrl(cat, epId, n) });
      }
      base.episodes = out;
      if (!out.length) return base;
      return _malFromServers(first, watchRef).then(function (mal) {
        base.malId = mal;
        return _kitsuStills(mal).then(function (stills) {
          for (var k = 0; k < out.length; k++) {
            var still = stills && stills[out[k].number];
            if (still) out[k].thumbnail = still;
          }
          return base;
        }).catch(function () { return base; });
      }).catch(function () { return base; });
    }).catch(function () { return base; });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// ── Streams: server list → embed → getSources ───────────────────────────────
function _parseServers(html) {
  var out = [], m;
  var re = /data-type="(\w+)"[\s\S]{0,200}?data-server-name="([^"]+)"[\s\S]{0,200}?data-hash="([^"]+)"/g;
  while ((m = re.exec(html)) !== null) {
    var url = _b64(m[3]);
    if (url) out.push({ type: m[1], name: m[2], url: url });
  }
  return out;
}
function _srvRank(name) {
  var n = String(name || '').toLowerCase();
  if (n.indexOf('vidplay') > -1) return 0;
  if (n.indexOf('vidstream') > -1) return 1;
  if (n.indexOf('hd') > -1) return 2;
  return 5;
}

function getVideoSources(episodeUrl) {
  var parts = String(episodeUrl).replace('hianime://', '').split('/');
  var cat = (parts[0] === 'dub') ? 'dub' : 'sub';
  var epId = parts[1] || '';
  // Anything else is a url from the old API-backed chain, whose player links
  // died with that host — nothing to resolve, so say so instead of guessing.
  if (!/^\d+$/.test(epId)) return Promise.reject(new Error('HiAnime: no episode id'));

  return _ajax('episode/servers?episodeId=' + encodeURIComponent(epId), SITE + '/watch/')
    .then(function (html) {
      var servers = _parseServers(html), want = [];
      for (var i = 0; i < servers.length; i++) {
        var t = servers[i].type;
        // hsub is the same audio as sub with hardcoded signs, so it stands in.
        var ok = (cat === 'dub') ? (t === 'dub') : (t === 'sub' || t === 'hsub');
        if (ok) want.push(servers[i]);
      }
      // No fallback to the other cut: the file a host hands back is only ever
      // labelled by what we asked for, so standing in a sub pack for a missing
      // dub would play Japanese audio under a Dub badge.
      want.sort(function (a, b) { return _srvRank(a.name) - _srvRank(b.name); });
      return _tryServers(want, 0, cat);
    });
}

function _tryServers(list, i, cat) {
  if (i >= list.length) return Promise.reject(new Error('HiAnime: no playable server'));
  if (!PLAYER_RE.test(list[i].url)) return _tryServers(list, i + 1, cat);
  return _extractPlayer(list[i].url, cat).catch(function () {
    return _tryServers(list, i + 1, cat);
  });
}

// The cut (sub/hsub/dub) the embed url was issued for. Sources are keyed by
// the embed's data-id, and that id is SHARED across the three cuts — the audio
// comes from `type` alone — so a dub embed asked without it answers with the
// sub stream.
function _cutOf(embed) {
  return (String(embed || '').match(/\/(sub|hsub|dub)\/?(?:[?#]|$)/i) || [])[1] || null;
}

function _extractPlayer(embed, cat) {
  var base = (embed.match(/^(https?:\/\/[^/]+)/) || [])[1] || 'https://vidtube.site';
  var type = _cutOf(embed) || cat;
  return _get(embed, SITE + '/').then(function (mhtml) {
    var dataId = (mhtml.match(/data-id="(\d+)"/) || [])[1];
    if (!dataId) throw new Error('HiAnime: no embed id');
    return fetch(_sourcesUrl(base, dataId, type), {
      headers: { 'User-Agent': UA, 'Referer': embed, 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function (r) {
      var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { throw new Error('HiAnime: bad getSources'); }
      var s = j && j.sources;
      // No sources.file → walk on to the next server.
      var file = s ? (s.file || (s[0] && s[0].file)) : null;
      if (!file) throw new Error('HiAnime: no stream file');
      var subs = [], tracks = (j && j.tracks) || [];
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (!t || !t.file) continue;
        if (t.kind && t.kind !== 'captions' && t.kind !== 'subtitles') continue;
        subs.push({ url: t.file, lang: t.label || 'Sub', label: t.label || 'Sub',
          format: /\.srt(\?|$)/i.test(t.file) ? 'srt' : 'vtt', 'default': !!t['default'] });
      }
      var hdrs = { 'User-Agent': UA, 'Referer': base + '/', 'Origin': base };
      var mk = function (u, q) {
        return { url: u, quality: q, container: /\.m3u8(\?|$)/i.test(u) ? 'hls' : 'mp4',
          headers: hdrs, kind: cat, audioLang: cat === 'dub' ? 'en' : 'ja', subtitles: subs };
      };
      if (!/\.m3u8(\?|$)/i.test(file)) return [mk(file, 'auto')];
      // Adaptive master → expose each rendition so the player gets a real
      // quality menu, with "auto" left first for adaptive switching.
      return fetch(file, { headers: { 'User-Agent': UA, 'Referer': base + '/' } }).then(function (mr) {
        var body = mr.body || '';
        var dir = file.replace(/[^/]*(\?.*)?$/, '');
        var vs = [], m, re = /#EXT-X-STREAM-INF:[^\n]*?RESOLUTION=\d+x(\d+)[^\n]*\r?\n([^\r\n#]+)/gi;
        while ((m = re.exec(body)) !== null) {
          var uri = String(m[2]).replace(/^\s+|\s+$/g, '');
          if (!uri) continue;
          vs.push({ h: parseInt(m[1], 10), url: /^https?:/i.test(uri) ? uri : (dir + uri) });
        }
        vs.sort(function (a, b) { return b.h - a.h; });
        var out = [mk(file, 'auto')];
        for (var k = 0; k < vs.length; k++) out.push(mk(vs[k].url, vs[k].h + 'p'));
        return out;
      }).catch(function () { return [mk(file, 'auto')]; });
    });
  });
}
