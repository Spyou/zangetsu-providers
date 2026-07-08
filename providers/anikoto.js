// AniKoto — anime source for the Zangetsu provider repo (anikototv.to).
//
// anikototv.to is an aniwatch-style site. Streams are NOT keyed by the episode
// id — each episode carries an encrypted `data-ids` (server_ids) blob, and the
// real player is resolved through the site's own two-step server chain, then
// extracted from MegaPlay (plain m3u8 + subtitle tracks, no decryption):
//   /filter?keyword=            -> slug
//   /watch/<slug>               -> anime id (data-id) + metadata
//   /ajax/episode/list/<id>     -> [{ data-id, num, sub, dub, data-ids(server_ids) }]
//   /ajax/server/list?servers=<server_ids> -> server list (VidPlay/HD/Vidstream/…)
//   /ajax/server?get=<link_id>  -> { url: <megaplay embed>, skip_data }
//   megaplay.buzz/stream/getSources?id=<embed data-id> -> m3u8 + subs
//
// Home = /home spotlight (hero) + recent from the JSON API (anikotoapi.site);
// slugs are shared with the site, so those cards resolve through getDetail.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'anikoto';

var SITE = 'https://anikototv.to';
var API = 'https://anikotoapi.site';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Hosts whose /stream/getSources returns a plain m3u8 (MegaPlay + its clone).
var MEGA_RE = /^https?:\/\/(?:[a-z0-9-]+\.)?(?:megaplay\.[a-z]+|vidwish\.[a-z]+)/i;

function getInfo() {
  return { name: 'AniKoto', lang: 'en', baseUrl: SITE,
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.0.2' };
}

function _mode(opts) { return (opts && opts.category === 'dub') ? 'dub' : 'sub'; }

// GET a page as text. `xhr` sets the ajax header the /ajax routes expect.
function _get(url, ref, xhr) {
  var h = { 'User-Agent': UA, 'Referer': ref || SITE + '/' };
  if (xhr) h['X-Requested-With'] = 'XMLHttpRequest';
  return fetch(url, { headers: h })
    .then(function (r) { return r.body || ''; })
    .catch(function () { return ''; });
}
function _json(url, ref) {
  return _get(url, ref).then(function (b) {
    var j; try { j = JSON.parse(b || 'null'); } catch (e) { j = null; } return j;
  });
}
// The site's /ajax routes wrap their payload in { status, result }. `result` is
// an HTML string (episode/server list) or an object (server?get).
function _ajax(path) {
  return _get(SITE + path, SITE + '/', true).then(function (b) {
    var j; try { j = JSON.parse(b || 'null'); } catch (e) { j = null; } return j;
  }).catch(function () { return null; });
}

function _year(s) { var m = String(s || '').match(/(19|20)\d{2}/); return m ? m[0] : null; }
function _slugFromWatch(href) {
  var m = String(href || '').match(/\/watch\/([^/"?#]+)/);
  return m ? m[1] : null;
}

// ── Search: scrape /filter?keyword= result cards ────────────────────────────
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 1) return Promise.resolve([]);
  var url = SITE + '/filter?keyword=' + encodeURIComponent(q) + '&page=' + (page || 1);
  return _get(url, SITE + '/').then(function (html) {
    var out = [], seen = {};
    var chunks = html.split('<div class="item');
    for (var i = 1; i < chunks.length; i++) {
      var c = chunks[i];
      var slug = _slugFromWatch((c.match(/href="([^"]*\/watch\/[^"]+)"/) || [])[1]);
      if (!slug || seen[slug]) continue;
      var title = (c.match(/class="name d-title"[^>]*>([^<]+)</) || [])[1]
        || (c.match(/data-jp="([^"]+)"/) || [])[1];
      var poster = (c.match(/<img[^>]+data-src="([^"]+)"/) || c.match(/<img[^>]+src="([^"]+)"/) || [])[1];
      if (!title) continue;
      seen[slug] = 1;
      out.push({ id: slug, title: htmlText(title).trim(), url: slug,
        cover: poster || null, type: 'anime', sourceId: SOURCE_ID });
    }
    return out;
  }).catch(function () { return []; });
}

// ── Home: /home spotlight (hero) + recent from the JSON API ──────────────────
function _apiCard(a) {
  if (!a || !a.slug) return null;
  return { id: a.slug, title: a.title || a.alternative || a.slug, url: a.slug,
    cover: a.poster || null, type: 'anime', sourceId: SOURCE_ID,
    subCount: a.is_sub ? 1 : 0, dubCount: 0 };
}
// Slice the /home page into its section containers (#hotest / #top-anime /
// #recent-update), each bounded by the next section so cards don't bleed across.
function _sections(html) {
  var ids = ['hotest', 'top-anime', 'recent-update'], marks = [];
  for (var i = 0; i < ids.length; i++) {
    var k = html.indexOf('id="' + ids[i] + '"');
    if (k >= 0) marks.push({ id: ids[i], at: k });
  }
  marks.sort(function (a, b) { return a.at - b.at; });
  var res = {};
  for (var j = 0; j < marks.length; j++) {
    var end = (j + 1 < marks.length) ? marks[j + 1].at : marks[j].at + 30000;
    res[marks[j].id] = html.substring(marks[j].at, end);
  }
  return res;
}
// Spotlight (#hotest) cards carry the title in an <h2 …d-title> + a bg-image.
function _spotlight(seg) {
  var out = [], seen = {}, chunks = seg.split('swiper-slide item');
  for (var i = 1; i < chunks.length; i++) {
    var c = chunks[i];
    var slug = _slugFromWatch((c.match(/href="([^"]*\/watch\/[^"]+)"/) || [])[1]);
    if (!slug || seen[slug]) continue;
    var title = (c.match(/class="title d-title"[^>]*>\s*([^<]+?)\s*</) || [])[1]
      || (c.match(/data-jp="([^"]+)"/) || [])[1];
    if (!title) continue;
    var img = (c.match(/background-image:\s*url\(([^)]+)\)/)
      || c.match(/<img[^>]+data-src="([^"]+)"/) || c.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    if (img) img = img.replace(/^['"]|['"]$/g, '');
    seen[slug] = 1;
    out.push({ id: slug, title: htmlText(title).trim(), url: slug,
      cover: img || null, type: 'anime', sourceId: SOURCE_ID });
  }
  return out;
}
// Generic grid (#top-anime a.item, #recent-update div.item) → cards.
function _gridCards(seg) {
  var out = [], seen = {}, items = String(seg || '').split('class="item');
  for (var i = 1; i < items.length; i++) {
    var c = items[i];
    var slug = _slugFromWatch((c.match(/href="([^"]*\/watch\/[^"]+)"/) || [])[1]);
    if (!slug || seen[slug]) continue;
    var title = (c.match(/class="(?:name|title)[^"]*d-title"[^>]*>\s*([^<]+?)\s*</) || [])[1]
      || (c.match(/class="name"[^>]*>\s*([^<]+?)\s*</) || [])[1]
      || (c.match(/data-jp="([^"]+)"/) || [])[1];
    var poster = (c.match(/<img[^>]+data-src="([^"]+)"/) || c.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    if (!title) continue;
    seen[slug] = 1;
    out.push({ id: slug, title: htmlText(title).trim(), url: slug,
      cover: poster || null, type: 'anime', sourceId: SOURCE_ID });
  }
  return out;
}
function getHome(opts) {
  return _get(SITE + '/home', SITE + '/').then(function (html) {
    var s = _sections(html), rows = [];
    var spot = _spotlight(s.hotest || html);
    if (spot.length) rows.push({ title: 'Spotlight', items: spot });
    var top = _gridCards(s['top-anime']);
    if (top.length) rows.push({ title: 'Top Anime', items: top });
    var recent = _gridCards(s['recent-update']);
    if (recent.length) rows.push({ title: 'Recently Updated', items: recent });
    return rows;
  }).catch(function () { return []; }).then(function (rows) {
    if (rows.length) return rows;
    // Fallback: the JSON API's recent list if the /home scrape yielded nothing.
    return _json(API + '/recent-anime?page=1&per_page=24').then(function (j) {
      var data = (j && j.data) || [], items = [];
      for (var k = 0; k < data.length; k++) { var cc = _apiCard(data[k]); if (cc) items.push(cc); }
      return items.length ? [{ title: 'Recently Updated', items: items }] : [];
    }).catch(function () { return []; });
  });
}

// ── Detail + episodes ───────────────────────────────────────────────────────
function _cleanTitle(og) {
  var t = String(og || '');
  t = t.replace(/\s*[|-]\s*Anikoto.*$/i, '');        // trailing site name
  t = t.replace(/^Watch\s+/i, '').replace(/^Anime\s+/i, ''); // leading fluff
  t = t.replace(/\s+Anime\s+Online.*$/i, '');         // "X Anime Online …"
  t = t.replace(/\s+Watch\s+Online.*$/i, '');         // "X Watch Online Free"
  t = t.replace(/\s+Online\s+(with|free)\b.*$/i, ''); // "X Online with SUB/DUB"
  return t.trim();
}
function _genres(html) {
  var g = [], re = /href="[^"]*\/genre\/[^"]*"[^>]*>([^<]+)</g, m;
  while ((m = re.exec(html)) !== null && g.length < 8) {
    var t = htmlText(m[1]).trim(); if (t) g.push(t);
  }
  return g;
}

// Episode url: anikoto://<cat>/<encoded server_ids>/<sub><dub>/<num>. The player
// rewrites the leading <cat> segment for its Sub/Dub toggle; getVideoSources
// resolves the server list from the (per-episode) server_ids blob.
function _epUrl(cat, serverIds, sub, dub, num) {
  return 'anikoto://' + cat + '/' + encodeURIComponent(serverIds) + '/'
    + (sub ? 1 : 0) + (dub ? 1 : 0) + '/' + num;
}

function getDetail(url, opts) {
  var slug = String(url);
  var cat = _mode(opts);
  return _get(SITE + '/watch/' + encodeURIComponent(slug), SITE + '/').then(function (html) {
    var animeId = (html.match(/data-id="(\d+)"/) || [])[1];
    // The canonical clean title is the <h1 class="… d-title">; og:title is
    // marketing fluff ("Watch X Anime Online Free"), used only as a fallback.
    var title = htmlText((html.match(/<h1[^>]*class="[^"]*d-title[^"]*"[^>]*>([^<]+)<\/h1>/) || [])[1] || '').trim()
      || _cleanTitle((html.match(/og:title"\s+content="([^"]+)"/) || [])[1]) || slug;
    var poster = (html.match(/og:image"\s+content="([^"]+)"/) || [])[1] || null;
    var synopsis = (html.match(/class="synopsis[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
    var base = {
      id: slug, title: title, url: slug, cover: poster,
      description: htmlText(synopsis).trim(), status: 'unknown',
      genres: _genres(html), studios: [], type: 'anime', sourceId: SOURCE_ID,
      episodes: [], year: _year(html), malId: null, subCount: 0, dubCount: 0
    };
    if (!animeId) return base;
    return _ajax('/ajax/episode/list/' + animeId).then(function (j) {
      var lhtml = (j && typeof j.result === 'string') ? j.result : '';
      var out = [], subN = 0, dubN = 0, mal = null;
      var re = /<a\b([^>]*\bdata-id="\d+"[^>]*)>/g, m;
      while ((m = re.exec(lhtml)) !== null) {
        var attrs = m[1];
        var serverIds = (attrs.match(/data-ids="([^"]+)"/) || [])[1];
        if (!serverIds) continue; // no servers → not playable
        var num = parseInt((attrs.match(/data-num="(\d+)"/) || [])[1] || '0', 10);
        var sub = (attrs.match(/data-sub="(\d+)"/) || [])[1] === '1';
        var dub = (attrs.match(/data-dub="(\d+)"/) || [])[1] === '1';
        if (!sub && !dub) continue;
        if (!mal) mal = (attrs.match(/data-mal="(\d+)"/) || [])[1] || null;
        if (sub) subN++;
        if (dub) dubN++;
        var initCat = (cat === 'dub' && dub) || (cat === 'sub' && !sub && dub) ? 'dub' : 'sub';
        var title2 = (attrs.match(/title="([^"]+)"/) || [])[1];
        out.push({ id: cat + ':' + num, number: num,
          title: title2 ? htmlText(title2).trim() : ('Episode ' + num),
          url: _epUrl(initCat, serverIds, sub, dub, num) });
      }
      base.episodes = out;
      base.subCount = subN;
      base.dubCount = dubN;
      base.malId = mal ? parseInt(mal, 10) : null;
      return base;
    }).catch(function () { return base; });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// ── Streams: server_ids → server list → server?get → MegaPlay getSources ─────
function _parseServers(html) {
  var servers = [], re = /data-type="(\w+)"([\s\S]*?)(?=data-type="|$)/g, tm;
  while ((tm = re.exec(html)) !== null) {
    var type = tm[1], block = tm[2], lm, lre = /data-link-id="([^"]+)"[^>]*>([^<]*)</g;
    while ((lm = lre.exec(block)) !== null) {
      servers.push({ type: type, linkId: lm[1], name: (lm[2] || '').trim() });
    }
  }
  return servers;
}
// Prefer MegaPlay-backed servers (Vidstream/HD → megaplay.buzz) — plain m3u8.
function _srvRank(name) {
  var n = String(name || '').toLowerCase();
  if (n.indexOf('vidstream') > -1) return 0;
  if (n.indexOf('hd') > -1) return 1;
  if (n.indexOf('vidcloud') > -1) return 2;
  return 5;
}

function getVideoSources(episodeUrl) {
  var raw = String(episodeUrl).replace('anikoto://', '');
  var parts = raw.split('/');
  var cat = (parts[0] === 'dub') ? 'dub' : 'sub';
  var serverIds = parts[1] ? decodeURIComponent(parts[1]) : '';
  if (!serverIds) return Promise.reject(new Error('AniKoto: no server ids'));

  return _ajax('/ajax/server/list?servers=' + encodeURIComponent(serverIds)).then(function (j) {
    var lhtml = (j && typeof j.result === 'string') ? j.result : '';
    var servers = _parseServers(lhtml);
    var want = [];
    for (var i = 0; i < servers.length; i++) {
      var s = servers[i];
      var ok = (cat === 'dub') ? (s.type === 'dub') : (s.type === 'sub' || s.type === 'hsub');
      if (ok) want.push(s);
    }
    if (!want.length) want = servers;
    want.sort(function (a, b) { return _srvRank(a.name) - _srvRank(b.name); });
    return _tryServers(want, 0, cat);
  });
}

// Resolve servers in preference order; take the first that yields a MegaPlay
// (or clone) embed, then extract its m3u8.
function _tryServers(list, i, cat) {
  if (i >= list.length) return Promise.reject(new Error('AniKoto: no playable server'));
  return _ajax('/ajax/server?get=' + encodeURIComponent(list[i].linkId)).then(function (j) {
    var url = j && j.result && (typeof j.result === 'object' ? j.result.url : null);
    if (url && MEGA_RE.test(url)) return _extractMega(url, cat);
    return _tryServers(list, i + 1, cat);
  }).catch(function () { return _tryServers(list, i + 1, cat); });
}

// MegaPlay embed page → data-id → getSources (plain m3u8 + subtitle tracks).
function _extractMega(embed, cat) {
  var base = (embed.match(/^(https?:\/\/[^/]+)/) || [])[1] || 'https://megaplay.buzz';
  return _get(embed, SITE + '/').then(function (mhtml) {
    var dataId = (mhtml.match(/data-id="(\d+)"/) || [])[1];
    if (!dataId) throw new Error('AniKoto: no MegaPlay id');
    return fetch(base + '/stream/getSources?id=' + dataId, {
      headers: { 'User-Agent': UA, 'Referer': embed, 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function (r) {
      var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { throw new Error('AniKoto: bad getSources'); }
      var s = j && j.sources;
      var file = s ? (s.file || (s[0] && s[0].file)) : null;
      if (!file) throw new Error('AniKoto: no stream file');
      var subs = [];
      var tracks = (j && j.tracks) || [];
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
      return fetch(file, { headers: { 'User-Agent': UA, 'Referer': base + '/' } }).then(function (mr) {
        var body = mr.body || '';
        var dir = file.replace(/[^/]*(\?.*)?$/, '');
        var vs = [], m2, re = /#EXT-X-STREAM-INF:[^\n]*?RESOLUTION=\d+x(\d+)[^\n]*\r?\n([^\r\n#]+)/gi;
        while ((m2 = re.exec(body)) !== null) {
          var h = parseInt(m2[1], 10);
          var uri = String(m2[2]).replace(/^\s+|\s+$/g, '');
          if (!uri) continue;
          vs.push({ h: h, url: /^https?:/i.test(uri) ? uri : (dir + uri) });
        }
        vs.sort(function (a, b) { return b.h - a.h; });
        var outv = [mk(file, 'auto')];
        for (var k = 0; k < vs.length; k++) outv.push(mk(vs[k].url, vs[k].h + 'p'));
        return outv;
      }).catch(function () { return [mk(file, 'auto')]; });
    });
  });
}
