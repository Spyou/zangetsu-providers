// HiAnime — anime source for the Zangetsu provider repo (hianimes.se).
//
// hianimes.se is a Next.js front-end over a JSON API at animedata.cfd. The API
// hands us episode "player" links (animeplay.cfd / megaplay.buzz); MegaPlay's
// getSources returns a PLAIN m3u8 + subtitle tracks (no decryption needed), so
// the chain is entirely API/JSON + one regex hop for the player file id:
//   search/home/detail/episodes (animedata.cfd/api)  ->  episode player link
//   ->  megaplay.buzz data-id  ->  /stream/getSources?id=  ->  m3u8 + subs.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'hianime';

var API = 'https://animedata.cfd/api';
var SITE = 'https://hianimes.se';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function getInfo() {
  return { name: 'HiAnime', lang: 'en', baseUrl: SITE,
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.0.7' };
}

function _mode(opts) { return (opts && opts.category === 'dub') ? 'dub' : 'sub'; }

function _api(path) {
  return fetch(API + path, { headers: { 'User-Agent': UA, 'Referer': SITE + '/' } })
    .then(function (r) { var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { j = null; } return j; })
    .catch(function () { return null; });
}
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || SITE + '/' } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _year(s) { var m = String(s || '').match(/(19|20)\d{2}/); return m ? m[0] : null; }

// The /episodes endpoint returns only the first 100; `?start=N` returns the
// rest (uncapped). Page through until we've collected `total` episodes so long
// anime (One Piece, Naruto, ...) aren't capped at 100.
function _allEpisodes(id) {
  return _api('/episodes/' + encodeURIComponent(id)).then(function (e) {
    var all = (e && e.episodes) || [];
    var total = (e && typeof e.total === 'number') ? e.total : all.length;
    function finish() {
      all.sort(function (x, y) { return (x.episodeNumber || 0) - (y.episodeNumber || 0); });
      return all;
    }
    function more(depth) {
      if (all.length >= total || depth > 40) return finish();
      var start = all.length + 1;
      return _api('/episodes/' + encodeURIComponent(id) + '?start=' + start).then(function (e2) {
        var batch = (e2 && e2.episodes) || [];
        var have = {};
        for (var i = 0; i < all.length; i++) have[all[i].episodeNumber] = 1;
        var added = 0;
        for (var k = 0; k < batch.length; k++) {
          var ep = batch[k];
          if (ep && !have[ep.episodeNumber]) { all.push(ep); added++; }
        }
        if (added === 0) return finish();
        return more(depth + 1);
      }).catch(function () { return finish(); });
    }
    return more(0);
  }).catch(function () { return []; });
}
function _genres(a) {
  var g = a.genres || [];
  return g.map(function (x) { return typeof x === 'string' ? x : (x && (x.name || x.title)); })
          .filter(Boolean).slice(0, 6);
}

// ── Episode thumbnails (Kitsu, keyed by the anime's mal_id) ──────────────────
// The API gives no per-episode image, so the app falls back to the series
// poster. Kitsu has broad per-episode thumbnails (incl. older anime) and is
// reachable where TMDB is ISP-blocked. Map mal_id -> Kitsu id, then page its
// episodes. Strictly best-effort: any failure leaves the poster fallback and
// never affects playback. Returns { episodeNumber: thumbnailUrl }.
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

// One API anime object → a Zangetsu card. Detail is keyed by a slug; home/detail
// objects expose `slug` (string), search results expose `slugs` (array).
function _slugOf(a) {
  if (a.slug) return a.slug;
  if (Array.isArray(a.slugs) && a.slugs.length) return a.slugs[0];
  if (typeof a.slugs === 'string') return a.slugs;
  return null;
}
function _card(a) {
  if (!a) return null;
  var inner = a.anime || a; // home rows sometimes wrap the anime
  var slug = inner && _slugOf(inner);
  if (!slug) return null;
  return {
    id: slug, title: inner.English || inner.title || inner.Japanese || 'Untitled',
    englishTitle: inner.English || null, cover: inner.image || inner.landScapeImage || null,
    url: slug, type: 'anime', sourceId: SOURCE_ID,
    subCount: inner.totalSub || inner.totalSubbed || 0,
    dubCount: inner.totalDub || inner.totalDubbed || 0
  };
}
function _cards(list) {
  var out = []; list = list || [];
  for (var i = 0; i < list.length; i++) { var c = _card(list[i]); if (c) out.push(c); }
  return out;
}

// Search is a POST to /search with a JSON {title} body; returns an array.
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 2) return Promise.resolve([]);
  return fetch(API + '/search', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Referer': SITE + '/', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: q })
  }).then(function (r) {
    var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { j = null; }
    var list = Array.isArray(j) ? j : ((j && (j.animes || j.results || j.data)) || []);
    return _cards(list);
  }).catch(function () { return []; });
}

// Each /home row is either an array (featured) or an {animes:[...]} object
// (trending/popular/...) — normalise to the underlying list.
function _rowItems(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.animes)) return v.animes;
  if (v && Array.isArray(v.results)) return v.results;
  if (v && Array.isArray(v.data)) return v.data;
  return [];
}

function getHome(opts) {
  return _api('/home').then(function (j) {
    if (!j) return [];
    var rows = [
      { title: 'Trending', key: 'trending' },
      { title: 'Popular', key: 'popular' },
      { title: 'Currently Airing', key: 'currentlyAiring' },
      { title: 'Latest', key: 'latestAnime' },
      { title: 'Recently Completed', key: 'finishedAiring' }
    ];
    var out = rows.map(function (r) { return { title: r.title, items: _cards(_rowItems(j[r.key])) }; })
                  .filter(function (r) { return r.items.length; });
    // The app uses the FIRST section as the hero carousel, so make sure it has
    // several items: lead with the featured spotlight, then trending.
    var feat = _cards(_rowItems(j.featured));
    if (out.length) {
      var seen = {}, merged = [];
      feat.concat(out[0].items).forEach(function (c) { if (c && !seen[c.id]) { seen[c.id] = 1; merged.push(c); } });
      out[0] = { title: out[0].title, items: merged };
    } else if (feat.length) {
      out = [{ title: 'Spotlight', items: feat }];
    }
    return out;
  }).catch(function () { return []; });
}

// Episode url packs the chosen category + its player link, resolved lazily.
function _epUrl(cat, playerUrl) { return 'hianime://' + cat + '|' + encodeURIComponent(playerUrl || ''); }

function getDetail(url, opts) {
  var slug = String(url);
  var cat = _mode(opts);
  return _api('/anime/' + encodeURIComponent(slug)).then(function (j) {
    var a = (j && (j.anime || j)) || {};
    var id = a._id;
    var base = {
      id: slug, title: a.English || a.title || slug, englishTitle: a.English || null,
      cover: a.image || a.landScapeImage || null, url: slug,
      description: htmlText(a.synopsis || ''), status: a.Status || 'unknown',
      genres: _genres(a), studios: [], type: 'anime', sourceId: SOURCE_ID,
      episodes: [], year: _year(a.Aired),
      // MAL id drives tracker sync (AniList/MAL/Simkl) in the app.
      malId: (a.mal_id != null) ? parseInt(a.mal_id, 10) : null,
      // The detail object uses totalSub/totalDub (NOT totalSubbed/totalDubbed);
      // overridden below with exact counts from the episode links.
      subCount: a.totalSub || a.totalSubbed || 0,
      dubCount: a.totalDub || a.totalDubbed || 0
    };
    if (!id) return base;
    return _allEpisodes(id).then(function (eps) {
      if (!eps.length && a.episodes) eps = a.episodes;
      // Exact sub/dub availability comes from the episodes' link sets — this
      // drives the player's Sub/Dub toggle and the download sheet's chips.
      var subN = 0, dubN = 0;
      for (var ci = 0; ci < eps.length; ci++) {
        var lk = (eps[ci] && eps[ci].link) || {};
        if (lk.sub && lk.sub.length) subN++;
        if (lk.dub && lk.dub.length) dubN++;
      }
      if (eps.length) { base.subCount = subN; base.dubCount = dubN; }
      var out = [];
      for (var i = 0; i < eps.length; i++) {
        var ep = eps[i];
        var link = (ep.link && ep.link[cat]) || [];
        var player = link[0];
        if (!player) continue; // no stream for this category
        var n = ep.episodeNumber != null ? ep.episodeNumber : (i + 1);
        out.push({ id: cat + ':' + n, number: n,
          title: ep.title || ('Episode ' + n), url: _epUrl(cat, player) });
      }
      base.episodes = out;
      // Best-effort: fill in real episode stills from Jikan by mal_id. Never
      // blocks or changes ids/numbers/urls — only adds `thumbnail` where found.
      return _kitsuStills(a.mal_id).then(function (stills) {
        if (stills) {
          for (var k = 0; k < out.length; k++) {
            var still = stills[out[k].number];
            if (still) out[k].thumbnail = still;
          }
        }
        return base;
      }).catch(function () { return base; });
    }).catch(function () { return base; });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// player link → MegaPlay file id → getSources (plain m3u8 + subtitle tracks).
function getVideoSources(episodeUrl) {
  var raw = String(episodeUrl).replace('hianime://', '');
  var cut = raw.indexOf('|');
  var cat = cut > -1 ? raw.slice(0, cut) : 'sub';
  var player = cut > -1 ? decodeURIComponent(raw.slice(cut + 1)) : '';
  if (!player) return Promise.reject(new Error('HiAnime: no player link'));

  return _get(player, SITE + '/').then(function (html) {
    // animeplay.cfd wraps an iframe to the real megaplay player; megaplay links
    // are already the player page.
    var mega = player;
    var ifr = (html.match(/<iframe[^>]+src="([^"]*megaplay[^"]*)"/i) ||
               html.match(/<iframe[^>]+src="([^"]+)"/i) || [])[1];
    if (ifr && ifr.indexOf('megaplay') !== -1) mega = absUrl(ifr, player);

    var pagePromise = (mega === player) ? Promise.resolve(html) : _get(mega, player);
    return pagePromise.then(function (mhtml) {
      var dataId = (mhtml.match(/data-id="(\d+)"/i) || [])[1];
      if (!dataId) throw new Error('HiAnime: no MegaPlay id');
      var base = (mega.match(/^(https?:\/\/[^/]+)/) || [])[1] || 'https://megaplay.buzz';
      return fetch(base + '/stream/getSources?id=' + dataId, {
        headers: { 'User-Agent': UA, 'Referer': mega, 'X-Requested-With': 'XMLHttpRequest' }
      }).then(function (r) {
        var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { throw new Error('HiAnime: bad getSources'); }
        var s = j && j.sources;
        var file = s ? (s.file || (s[0] && s[0].file)) : null;
        if (!file) throw new Error('HiAnime: no stream file');
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
        // Adaptive master playlist → expose each rendition so the player shows a
        // real quality menu (plus "auto" for adaptive switching).
        return fetch(file, { headers: { 'User-Agent': UA, 'Referer': base + '/' } }).then(function (mr) {
          var body = mr.body || '';
          var dir = file.replace(/[^/]*(\?.*)?$/, '');
          var vs = [], m, re = /#EXT-X-STREAM-INF:[^\n]*?RESOLUTION=\d+x(\d+)[^\n]*\r?\n([^\r\n#]+)/gi;
          while ((m = re.exec(body)) !== null) {
            var h = parseInt(m[1], 10);
            var uri = String(m[2]).replace(/^\s+|\s+$/g, '');
            if (!uri) continue;
            vs.push({ h: h, url: /^https?:/i.test(uri) ? uri : (dir + uri) });
          }
          vs.sort(function (a, b) { return b.h - a.h; });
          var out = [mk(file, 'auto')];
          for (var i = 0; i < vs.length; i++) out.push(mk(vs[i].url, vs[i].h + 'p'));
          return out;
        }).catch(function () { return [mk(file, 'auto')]; });
      });
    });
  });
}
