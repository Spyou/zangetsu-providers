// AnimeKai — anime source for the Zangetsu provider repo (animekai.at).
//
// animekai.at is a WordPress anime site (theme "animekai", localized JS objects
// named `hianime_*`). It is reachable with a plain desktop browser User-Agent —
// there is no hard Cloudflare wall — so every request here is a normal fetch.
//
// THE CHAIN (each hop verified live against animekai.at, June 2026):
//
//   search   GET /filter/?keyword=<q>                (HTML grid of .flw-item cards)
//   home     homepage + /most-popular/ /subbed-anime/ /dubbed-anime/ /genre/<g>/
//            (same .flw-item card grid)
//   detail   the card href is a WATCH/EPISODE page, e.g. /<slug>-episode-1/ or
//            /<slug>-movie/. That page carries:
//              <div id="ani_detail" data-anime-id="<seriesId>" data-id="<curEpId>">
//              a #hianime_ep_ajax localized JSON with `episode_nonce`
//              a .anisc-detail block (title, poster, synopsis, sub/dub/eps ticks)
//              a .film-name <a href="/anime/<slug>/"> link to the landing page
//            The landing page /anime/<slug>/ has clean labelled metadata
//            (Status / Aired / Genres / Studios) which we fetch to enrich detail.
//   episodes POST /wp-admin/admin-ajax.php
//              action=hianime_episode_list & anime_id=<seriesId> & nonce=<episode_nonce>
//            -> { status, totalItems, html } ; html has <a class="ssl-item ep-item"
//               data-number data-id href> per episode (data-id = episode_id).
//   servers  POST /wp-admin/admin-ajax.php
//              action=hianime_episode_servers & episode_id=<epId> & nonce=<episode_nonce>
//            -> { status, html } ; html has
//               <div class="item server-item" data-type="sub|dub"
//                    data-server-name="..." data-hash="<base64(embedUrl)>">
//            The embed url (base64-decoded data-hash) is a MegaPlay embed:
//               https://megaplay.buzz/stream/mal/<malId>/<ep>/<sub|dub>
//   video    MegaPlay embed -> inner iframe (/stream/s-5/<id>/<cat>) -> data-id
//            -> GET {megaBase}/stream/getSources?id=<dataId>
//            -> { sources:{file:<master.m3u8>}, tracks:[{file,label,kind}] }
//            MegaPlay returns a PLAIN m3u8 + subtitle tracks — NO decryption.
//
// IMPORTANT: the AJAX nonce IS enforced server-side ("Security check failed" on a
// bad nonce). It is currently stable site-wide but can rotate, so we always
// scrape the live `episode_nonce` from the watch page rather than hardcoding it.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'animekai';

var BASE = 'https://animekai.at';
var AJAX = BASE + '/wp-admin/admin-ajax.php';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function getInfo() {
  return { name: 'AnimeKai', lang: 'en', baseUrl: BASE,
    logo: BASE + '/favicon.ico', type: 'anime', version: '2.0.0' };
}

function _mode(opts) { return (opts && opts.category === 'dub') ? 'dub' : 'sub'; }

// ── HTTP helpers ─────────────────────────────────────────────────────────────
// Plain browser request. `browser:true` is a Cloudflare safety-net only — the
// site answers a normal fetch, so we don't depend on the native solver.
function _get(url, ref) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': ref || (BASE + '/') }
  }).then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}

// POST to admin-ajax.php as application/x-www-form-urlencoded -> parsed JSON.
function _ajaxPost(fields, ref) {
  var body = [];
  for (var k in fields) {
    if (fields.hasOwnProperty(k)) {
      body.push(encodeURIComponent(k) + '=' + encodeURIComponent(fields[k]));
    }
  }
  return fetch(AJAX, {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Referer': ref || (BASE + '/'),
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    body: body.join('&')
  }).then(function (r) {
    var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { j = null; }
    return j;
  }).catch(function () { return null; });
}

function _attr(html, name) {
  var m = String(html || '').match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? m[1] : '';
}
function _year(s) { var m = String(s || '').match(/(19|20)\d{2}/); return m ? m[0] : null; }

// poster src/data-src often comes through the i0.wp.com image proxy with a
// `?fit=WxH` resize — strip the resize so the app gets the full-size poster.
function _cleanImg(u) {
  if (!u) return null;
  u = String(u).replace(/&#0?38;/g, '&');
  u = u.replace(/[?&](fit|resize|w|h|ssl|quality)=[^&]*/gi, '');
  u = u.replace(/[?&]+$/, '');
  return u;
}

// ── card parsing ─────────────────────────────────────────────────────────────
// Catalog cards are `<div class="flw-item">` blocks. Inside:
//   <div class="tick-item tick-sub">N</div>  (sub count)
//   <div class="tick-item tick-dub">N</div>  (dub count, optional)
//   <img class="film-poster-img" data-src|src="<poster>">
//   <a href="<watch-page>" class="film-poster-ahref item-qtip" title="<Title>" data-id="N">
//   <h3 class="film-name"><a href="<watch-page>" data-jname="<jp>">Title</a></h3>
// The href is a WATCH page (/<slug>-episode-N/, /<slug>-movie/, ...) — we store
// the full slug (path without the leading slash) as id/url so getDetail can
// re-fetch the exact watch page.
function _slugFromHref(href) {
  href = String(href || '').split('#')[0].split('?')[0];
  href = href.replace(/^https?:\/\/[^\/]+\//i, '').replace(/^\//, '').replace(/\/$/, '');
  return href;
}
function _card(block) {
  var aMatch = block.match(/<a[^>]+class="[^"]*film-poster-ahref[^"]*"[^>]*>/i)
            || block.match(/href="(https?:\/\/[^"]+)"[^>]*class="[^"]*film-poster-ahref/i);
  var ahref = '';
  if (aMatch) ahref = _attr(aMatch[0], 'href');
  if (!ahref) {
    var fn = block.match(/class="film-name"[\s\S]{0,120}?<a[^>]+href="([^"]+)"/i);
    ahref = fn ? fn[1] : '';
  }
  var slug = _slugFromHref(ahref);
  if (!slug) return null;

  var title = _attr((block.match(/class="film-poster-ahref[^>]*>/i) || [])[0] || '', 'title');
  if (!title) {
    var fnm = block.match(/class="film-name"[\s\S]{0,200}?<a[^>]*>([\s\S]*?)<\/a>/i);
    title = fnm ? htmlText(fnm[1]) : '';
  }
  if (!title) title = _attr(block, 'alt') || 'Untitled';

  var jp = (block.match(/data-jname="([^"]*)"/i) || [])[1] || null;
  var img = (block.match(/<img[^>]+(?:data-src|src)="([^"]+)"/i) || [])[1] || null;

  var sub = parseInt((block.match(/tick-sub[^>]*>(?:<i[^>]*><\/i>)?\s*(\d+)/i) || [])[1] || '0', 10) || 0;
  var dub = parseInt((block.match(/tick-dub[^>]*>(?:<i[^>]*><\/i>)?\s*(\d+)/i) || [])[1] || '0', 10) || 0;

  return {
    id: slug, title: title, englishTitle: title, japaneseTitle: jp,
    cover: img ? _cleanImg(absUrl(img, BASE)) : null, url: slug, type: 'anime',
    sourceId: SOURCE_ID, subCount: sub, dubCount: dub
  };
}
// Split an HTML chunk into `.flw-item` blocks and parse each into a card.
function _cards(html) {
  var out = [], seen = {};
  var parts = String(html || '').split(/<div[^>]*class="[^"]*\bflw-item\b/i);
  for (var i = 1; i < parts.length; i++) {
    var c = _card('<div class="flw-item' + parts[i].slice(0, 2200));
    if (c && !seen[c.id]) { seen[c.id] = 1; out.push(c); }
  }
  return out;
}

// ── search / home ────────────────────────────────────────────────────────────
// Search is WordPress's native ?s=<q> (verified: it actually filters; the
// /filter/?keyword= route does NOT — it always returns the default grid). The
// results page reuses the same .flw-item card grid. Pagination is /page/N/?s=.
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 1) return Promise.resolve([]);
  var p = parseInt(page, 10) || 1;
  var url = (p > 1)
    ? BASE + '/page/' + p + '/?s=' + encodeURIComponent(q)
    : BASE + '/?s=' + encodeURIComponent(q);
  return _get(url, BASE + '/').then(function (html) { return _cards(html); })
    .catch(function () { return []; });
}

function popular(opts) {
  return _get(BASE + '/most-popular/', BASE + '/')
    .then(function (html) { return _cards(html); })
    .catch(function () { return []; });
}

// Home rows from listing routes that survive on the live site (verified). We do
// NOT split by language — sub vs dub is a per-title choice the app exposes via
// its own toggle (subCount/dubCount), so language-split rows just duplicate the
// same titles and read confusingly. Use normal discovery rows instead.
function getHome(opts) {
  var rows = [
    { title: 'Latest Episodes',  url: BASE + '/' },
    { title: 'Most Popular',     url: BASE + '/most-popular/' },
    { title: 'Recently Updated', url: BASE + '/recently-updated/' },
    { title: 'Action',           url: BASE + '/genre/action/' }
  ];
  return Promise.all(rows.map(function (r) {
    return _get(r.url, BASE + '/').then(function (html) {
      return { title: r.title, items: _cards(html) };
    }).catch(function () { return { title: r.title, items: [] }; });
  })).then(function (out) {
    return out.filter(function (r) { return r.items.length; });
  }).catch(function () { return []; });
}

// ── detail / episodes ────────────────────────────────────────────────────────
// Episode url packs: category | episode_id | watch-slug. The episode_id +
// the (re-scraped) nonce are resolved to servers/streams in getVideoSources.
function _epUrl(cat, epId, slug) {
  return 'animekai://' + cat + '|' + encodeURIComponent(epId || '')
    + '|' + encodeURIComponent(slug || '');
}

// Pull the series id + current episode id + episode_nonce off a watch page.
function _watchMeta(html) {
  var det = (html.match(/id="ani_detail"[^>]*>/i) || [])[0] || '';
  var animeId = (det.match(/data-anime-id="(\d+)"/i) || [])[1] || '';
  var curEp = (det.match(/data-id="(\d+)"/i) || [])[1] || '';
  // #hianime_ep_ajax = {"ajax_url":"...","episode_nonce":"...."}
  var nonce = (html.match(/hianime_ep_ajax\s*=\s*\{[^}]*episode_nonce"\s*:\s*"([^"]+)"/i) || [])[1]
           || (html.match(/episode_nonce"\s*:\s*"([^"]+)"/i) || [])[1] || '';
  return { animeId: animeId, curEp: curEp, nonce: nonce };
}

// Scrape series metadata from the watch page (title, poster, synopsis, ticks)
// and the /anime/<slug>/ landing link (status, year, genres, studios).
function _detailFromWatch(html, slug) {
  var det = (html.match(/class="anisc-detail"[\s\S]*?class="film-description/i) || [])[0] || html;
  var title = (det.match(/class="film-name"[\s\S]{0,200}?<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1];
  title = title ? htmlText(title) : (slug.replace(/-episode-\d+$/, '').replace(/-movie$/, '').replace(/-/g, ' '));
  var jp = (det.match(/class="film-name"[\s\S]{0,200}?data-jname="([^"]*)"/i) || [])[1] || null;

  var poster = (html.match(/class="film-poster"[\s\S]{0,300}?<img[^>]+src="([^"]+)"/i) || [])[1]
            || (html.match(/class="anis-cover"[^>]*style="[^"]*url\(([^)]+)\)/i) || [])[1] || null;
  if (poster) poster = poster.replace(/['"]/g, '');

  var desc = htmlText((html.match(/class="film-description[^"]*"[\s\S]{0,80}?class="text">([\s\S]*?)<\/div>/i) || [])[1] || '');

  var sub = parseInt((det.match(/tick-sub[^>]*>(?:<i[^>]*><\/i>)?\s*(\d+)/i) || [])[1] || '0', 10) || 0;
  var dub = parseInt((det.match(/tick-dub[^>]*>(?:<i[^>]*><\/i>)?\s*(\d+)/i) || [])[1] || '0', 10) || 0;

  // /anime/<slug>/ landing link for richer metadata.
  var landing = (html.match(/class="anisc-detail"[\s\S]{0,300}?href="(https?:\/\/[^"]*\/anime\/[^"]+)"/i) || [])[1]
             || (html.match(/href="(https?:\/\/[^"]*\/anime\/[^"]+)"/i) || [])[1] || null;

  return {
    id: slug, title: title, englishTitle: title, japaneseTitle: jp,
    cover: poster ? _cleanImg(absUrl(poster, BASE)) : null, url: slug,
    description: desc, status: 'unknown', genres: [], studios: [],
    type: 'anime', sourceId: SOURCE_ID, episodes: [], year: null,
    malId: null, subCount: sub, dubCount: dub, _landing: landing
  };
}

// Labelled rows on /anime/<slug>/: <span class="item-head">Label:</span><span|a class="name">value</...>
function _landingField(html, label) {
  // The genre/studio rows list many <a> tags before the row's closing </div>,
  // so allow a generous window before the (non-greedy) </div> terminator.
  var re = new RegExp('item-head">\\s*' + label + '\\s*:?\\s*<\\/span>([\\s\\S]{0,1500}?)<\\/div>', 'i');
  var m = html.match(re);
  return m ? m[1] : '';
}
function _enrichFromLanding(base, html) {
  var statusSeg = _landingField(html, 'Status');
  var status = htmlText((statusSeg.match(/class="name">([\s\S]*?)<\/span>/i) || [])[1] || '');
  if (status) base.status = status.toLowerCase();

  var airedSeg = _landingField(html, 'Aired') || _landingField(html, 'Premiered') || _landingField(html, 'Date aired');
  var year = _year(htmlText(airedSeg));
  if (year) base.year = year;

  var genreSeg = _landingField(html, 'Genres');
  var genres = [], gm, gre = /<a[^>]*>([^<]+)<\/a>/gi;
  while ((gm = gre.exec(genreSeg)) !== null) { var g = htmlText(gm[1]); if (g) genres.push(g); }
  if (genres.length) base.genres = genres.slice(0, 10);

  var studioSeg = _landingField(html, 'Studios');
  var studios = [], sm, sre = /<a[^>]*>([^<]+)<\/a>/gi;
  while ((sm = sre.exec(studioSeg)) !== null) { var s = htmlText(sm[1]); if (s) studios.push(s); }
  if (studios.length) base.studios = studios.slice(0, 6);
  return base;
}

function getDetail(url, opts) {
  var slug = _slugFromHref(String(url));
  var cat = _mode(opts);
  // If the caller handed an /anime/<slug>/ landing slug, it has no player — but
  // the card hrefs we emit are watch pages, so this is the normal path.
  var watchUrl = BASE + '/' + slug + '/';
  return _get(watchUrl, BASE + '/').then(function (html) {
    var meta = _watchMeta(html);
    var base = _detailFromWatch(html, slug);
    var landing = base._landing; delete base._landing;

    var landingP = landing
      ? _get(landing, watchUrl).then(function (lh) { return _enrichFromLanding(base, lh); })
                               .catch(function () { return base; })
      : Promise.resolve(base);

    return landingP.then(function (b) {
      if (!meta.animeId || !meta.nonce) return b;
      return _episodeList(meta.animeId, meta.nonce, watchUrl).then(function (eps) {
        var out = [];
        for (var i = 0; i < eps.length; i++) {
          var ep = eps[i];
          if (!ep.id) continue;
          out.push({
            id: cat + ':' + ep.number,
            number: ep.number,
            title: ep.title || ('Episode ' + ep.number),
            url: _epUrl(cat, ep.id, slug)
          });
        }
        b.episodes = out;
        return b;
      }).catch(function () { return b; });
    });
  });
}

// POST hianime_episode_list -> { html } of <a class="ssl-item ep-item"
// data-number data-id href> rows. data-id is the episode_id used by the servers
// endpoint. We resolve the watch page nonce upstream and pass it in.
function _episodeList(animeId, nonce, watchUrl) {
  return _ajaxPost({
    action: 'hianime_episode_list', anime_id: animeId, nonce: nonce
  }, watchUrl).then(function (j) {
    if (!j || !j.status || !j.html) return [];
    var html = String(j.html);
    var eps = [], m, re = /<a\b([^>]*\bssl-item\b[^>]*)>([\s\S]*?)<\/a>/gi;
    while ((m = re.exec(html)) !== null) {
      var attrs = '<a ' + m[1] + '>';
      var epId = _attr(attrs, 'data-id');
      if (!epId) continue;
      var num = parseFloat(_attr(attrs, 'data-number')) || (eps.length + 1);
      var title = _attr(attrs, 'title')
        || htmlText((m[2].match(/class="ep-name[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
      // "Episode N" is the site's placeholder when no real episode name exists —
      // drop it so getDetail's own "Episode <n>" fallback applies consistently.
      if (/^episode\s*\d+$/i.test(String(title).trim())) title = null;
      eps.push({ id: epId, number: num, title: title });
    }
    eps.sort(function (a, b) { return a.number - b.number; });
    return eps;
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// ── video sources ────────────────────────────────────────────────────────────
// episode url -> servers AJAX -> MegaPlay embed(s) for the chosen category ->
// getSources (plain m3u8 + subs). Re-scrape the watch page for a fresh nonce.
function getVideoSources(episodeUrl) {
  var raw = String(episodeUrl).replace('animekai://', '');
  var parts = raw.split('|');
  var cat = parts[0] || 'sub';
  var epId = parts[1] ? decodeURIComponent(parts[1]) : '';
  var slug = parts[2] ? decodeURIComponent(parts[2]) : '';
  if (!epId) return Promise.reject(new Error('AnimeKai: no episode id'));
  var watchUrl = BASE + '/' + slug + '/';

  return _get(watchUrl, BASE + '/').then(function (html) {
    var nonce = _watchMeta(html).nonce;
    if (!nonce) throw new Error('AnimeKai: no ajax nonce');
    return _ajaxPost({
      action: 'hianime_episode_servers', episode_id: epId, nonce: nonce
    }, watchUrl).then(function (j) {
      if (!j || !j.status || !j.html) throw new Error('AnimeKai: no servers');
      var embeds = _serverEmbeds(j.html, cat);
      if (!embeds.length) throw new Error('AnimeKai: no ' + cat + ' server');
      var jobs = embeds.map(function (e) {
        return _megaplay(e, cat).catch(function () { return []; });
      });
      return Promise.all(jobs).then(function (lists) {
        var out = [], seen = {};
        for (var i = 0; i < lists.length; i++) {
          var arr = lists[i] || [];
          for (var k = 0; k < arr.length; k++) {
            var s = arr[k];
            if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); }
          }
        }
        if (!out.length) throw new Error('AnimeKai: no playable sources');
        return out;
      });
    });
  });
}

// Parse server-item rows for the chosen category. Each carries data-type
// (sub|dub) and data-hash = base64(embedUrl). Returns the decoded embed urls.
function _serverEmbeds(html, cat) {
  var out = [], m;
  var re = /<div[^>]*class="[^"]*\bserver-item\b[^"]*"([^>]*)>/gi;
  while ((m = re.exec(html)) !== null) {
    var attrs = '<x ' + m[1] + '>';
    var type = (_attr(attrs, 'data-type') || '').toLowerCase();
    if (type && type !== cat) continue;
    var hash = _attr(attrs, 'data-hash');
    if (!hash) continue;
    var url = '';
    try {
      var bytes = base64ToBytes(hash);
      for (var i = 0; i < bytes.length; i++) url += String.fromCharCode(bytes[i] & 255);
    } catch (e) { url = ''; }
    if (/^https?:\/\//i.test(url)) out.push(url);
  }
  return out;
}

// MegaPlay embed -> inner iframe -> data-id -> /stream/getSources -> m3u8 + subs.
// (Same player backend HiAnime resolves; returns plain media, no decryption.)
function _megaplay(embedUrl, cat) {
  return _get(embedUrl, BASE + '/').then(function (html) {
    // The /stream/mal/... page wraps an inner iframe (/stream/s-5/<id>/<cat>);
    // that inner page carries the numeric data-id. Some embeds already are it.
    var inner = embedUrl;
    var ifr = (html.match(/<iframe[^>]+class="s5-embed"[^>]+src="([^"]+)"/i)
            || html.match(/<iframe[^>]+src="([^"]*\/stream\/s-\d+\/[^"]+)"/i)
            || html.match(/<iframe[^>]+src="([^"]+)"/i) || [])[1];
    if (ifr) inner = absUrl(ifr, embedUrl);

    var innerP = (inner === embedUrl) ? Promise.resolve(html) : _get(inner, embedUrl);
    return innerP.then(function (ih) {
      var dataId = (ih.match(/data-id="(\d+)"/i) || [])[1]
                || (ih.match(/id="(\d+)"/i) || [])[1];
      if (!dataId) throw new Error('AnimeKai: no MegaPlay id');
      var megaBase = (inner.match(/^(https?:\/\/[^/]+)/) || [])[1] || 'https://megaplay.buzz';
      return fetch(megaBase + '/stream/getSources?id=' + dataId, {
        headers: { 'User-Agent': UA, 'Referer': inner, 'X-Requested-With': 'XMLHttpRequest' }
      }).then(function (r) {
        var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { throw new Error('AnimeKai: bad getSources'); }
        var s = j && j.sources;
        var file = s ? (s.file || (s[0] && s[0].file)) : null;
        if (!file) throw new Error('AnimeKai: no stream file');

        var subs = [];
        var tracks = (j && j.tracks) || [];
        for (var i = 0; i < tracks.length; i++) {
          var t = tracks[i];
          if (!t || !t.file) continue;
          if (t.kind && t.kind !== 'captions' && t.kind !== 'subtitles') continue;
          subs.push({ url: t.file, lang: t.label || 'Sub', label: t.label || 'Sub',
            format: /\.srt(\?|$)/i.test(t.file) ? 'srt' : 'vtt', 'default': !!t['default'] });
        }
        subs.sort(function (a, b) { return (b['default'] ? 1 : 0) - (a['default'] ? 1 : 0); });

        var hdrs = { 'User-Agent': UA, 'Referer': megaBase + '/', 'Origin': megaBase };
        var mk = function (u, q) {
          return { url: u, quality: q,
            container: /\.m3u8(\?|$)/i.test(u) ? 'hls' : 'mp4',
            headers: hdrs, kind: cat, audioLang: cat === 'dub' ? 'en' : 'ja',
            subtitles: subs };
        };
        if (!/\.m3u8(\?|$)/i.test(file)) return [mk(file, 'auto')];

        // Adaptive master -> expose each rendition for a real quality menu.
        return fetch(file, { headers: { 'User-Agent': UA, 'Referer': megaBase + '/' } }).then(function (mr) {
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

// No per-source settings UI for AnimeKai.
function getSettings() { return []; }
