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
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.0.1' };
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
function _genres(a) {
  var g = a.genres || [];
  return g.map(function (x) { return typeof x === 'string' ? x : (x && (x.name || x.title)); })
          .filter(Boolean).slice(0, 6);
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
    subCount: inner.totalSubbed || 0, dubCount: inner.totalDubbed || 0
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
      episodes: [], year: _year(a.Aired), subCount: a.totalSubbed || 0, dubCount: a.totalDubbed || 0
    };
    if (!id) return base;
    return _api('/episodes/' + encodeURIComponent(id)).then(function (e) {
      var eps = (e && e.episodes) || a.episodes || [];
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
      return base;
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
        return [{
          url: file, quality: 'auto', container: /\.m3u8(\?|$)/i.test(file) ? 'hls' : 'mp4',
          headers: { 'User-Agent': UA, 'Referer': base + '/', 'Origin': base },
          kind: cat, audioLang: cat === 'dub' ? 'en' : 'ja', subtitles: subs
        }];
      });
    });
  });
}
