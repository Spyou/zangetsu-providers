// AniKoto — anime source for the Zangetsu provider repo (anikototv.to).
//
// anikototv.to is an aniwatch-style site. Search is an HTML page (/filter);
// a show page (/watch/<slug>) carries the numeric anime id; the episode list
// (/ajax/episode/list/<id>) gives each episode's realid + sub/dub flags. The
// realid feeds MegaPlay, whose getSources returns a PLAIN m3u8 + subtitle
// tracks (no decryption), exactly like the HiAnime provider. Chain:
//   /filter?keyword=   -> slug
//   /watch/<slug>      -> anime id (data-id) + metadata
//   /ajax/episode/list/<id> -> [{ realid, num, sub, dub }]
//   megaplay.buzz/stream/s-2/<realid>/<cat> -> data-id
//   megaplay.buzz/stream/getSources?id=<data-id> -> m3u8 + subs
//
// getHome uses the site's own JSON API (anikotoapi.site) for a clean "recent"
// row; slugs are shared with the site, so its cards resolve through getDetail.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'anikoto';

var SITE = 'https://anikototv.to';
var API = 'https://anikotoapi.site';
var MEGA = 'https://megaplay.buzz';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function getInfo() {
  return { name: 'AniKoto', lang: 'en', baseUrl: SITE,
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.0.0' };
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
// The /ajax routes wrap their HTML in { status, result }.
function _ajaxHtml(url) {
  return _get(url, SITE + '/', true).then(function (b) {
    var j; try { j = JSON.parse(b || 'null'); } catch (e) { j = null; }
    return (j && typeof j.result === 'string') ? j.result : '';
  });
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
    // Each result is a `<div class="item">…</div>` block; split on the opening
    // tag and pull slug / title / poster out of each chunk.
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

// ── Home: recent updates from the JSON API (slugs shared with the site) ─────
function _apiCard(a) {
  if (!a || !a.slug) return null;
  return { id: a.slug, title: a.title || a.alternative || a.slug, url: a.slug,
    cover: a.poster || null, type: 'anime', sourceId: SOURCE_ID,
    subCount: a.is_sub ? 1 : 0, dubCount: 0 };
}
function getHome(opts) {
  return _json(API + '/recent-anime?page=1&per_page=24').then(function (j) {
    var rows = (j && j.data) || [];
    var items = [];
    for (var i = 0; i < rows.length; i++) { var c = _apiCard(rows[i]); if (c) items.push(c); }
    return items.length ? [{ title: 'Recently Updated', items: items }] : [];
  }).catch(function () { return []; });
}

// ── Detail + episodes ───────────────────────────────────────────────────────
function _cleanTitle(og) {
  return String(og || '').replace(/^Watch\s+/i, '')
    .replace(/\s+Anime\s+Online\s*\|.*$/i, '')
    .replace(/\s*\|\s*Anikoto.*$/i, '').trim();
}
function _genres(html) {
  var g = [], re = /href="[^"]*\/genre\/[^"]*"[^>]*>([^<]+)</g, m;
  while ((m = re.exec(html)) !== null && g.length < 8) {
    var t = htmlText(m[1]).trim(); if (t) g.push(t);
  }
  return g;
}

// Episode url: anikoto://<cat>/<realid>/<sub><dub>/<num>. The player rewrites
// the leading <cat> segment for its Sub/Dub toggle, so getVideoSources just
// rebuilds the MegaPlay embed for whichever category it is handed.
function _epUrl(cat, realid, sub, dub, num) {
  return 'anikoto://' + cat + '/' + realid + '/' + (sub ? 1 : 0) + (dub ? 1 : 0) + '/' + num;
}

function getDetail(url, opts) {
  var slug = String(url);
  var cat = _mode(opts);
  return _get(SITE + '/watch/' + encodeURIComponent(slug), SITE + '/').then(function (html) {
    var animeId = (html.match(/data-id="(\d+)"/) || [])[1];
    var title = _cleanTitle((html.match(/og:title"\s+content="([^"]+)"/) || [])[1]) || slug;
    var poster = (html.match(/og:image"\s+content="([^"]+)"/) || [])[1] || null;
    var synopsis = (html.match(/class="synopsis[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
    var base = {
      id: slug, title: title, url: slug, cover: poster,
      description: htmlText(synopsis).trim(), status: 'unknown',
      genres: _genres(html), studios: [], type: 'anime', sourceId: SOURCE_ID,
      episodes: [], year: _year(html), malId: null, subCount: 0, dubCount: 0
    };
    if (!animeId) return base;
    return _ajaxHtml(SITE + '/ajax/episode/list/' + animeId).then(function (lhtml) {
      var out = [], subN = 0, dubN = 0, mal = null;
      var re = /<a\b([^>]*\bdata-id="\d+"[^>]*)>/g, m;
      while ((m = re.exec(lhtml)) !== null) {
        var attrs = m[1];
        var realid = (attrs.match(/data-id="(\d+)"/) || [])[1];
        if (!realid) continue;
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
          url: _epUrl(initCat, realid, sub, dub, num) });
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

// ── Streams: MegaPlay embed → getSources (plain m3u8 + subtitle tracks) ──────
function getVideoSources(episodeUrl) {
  var raw = String(episodeUrl).replace('anikoto://', '');
  var parts = raw.split('/');
  var cat = (parts[0] === 'dub') ? 'dub' : 'sub';
  var realid = parts[1];
  if (!realid) return Promise.reject(new Error('AniKoto: no episode id'));

  var embed = MEGA + '/stream/s-2/' + realid + '/' + cat;
  return _get(embed, SITE + '/').then(function (mhtml) {
    var dataId = (mhtml.match(/data-id="(\d+)"/) || [])[1] || realid;
    return fetch(MEGA + '/stream/getSources?id=' + dataId, {
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
      var hdrs = { 'User-Agent': UA, 'Referer': MEGA + '/', 'Origin': MEGA };
      var mk = function (u, q) {
        return { url: u, quality: q, container: /\.m3u8(\?|$)/i.test(u) ? 'hls' : 'mp4',
          headers: hdrs, kind: cat, audioLang: cat === 'dub' ? 'en' : 'ja', subtitles: subs };
      };
      if (!/\.m3u8(\?|$)/i.test(file)) return [mk(file, 'auto')];
      // Adaptive master playlist → expose each rendition for a real quality menu.
      return fetch(file, { headers: { 'User-Agent': UA, 'Referer': MEGA + '/' } }).then(function (mr) {
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
