// AnimeKai — anime source for the Zangetsu provider repo (anikai.cc, the
// canonical AnimeKai). This targets the anikai.cc site family, NOT animekai.at
// (a clone that wrongly chunks long series into "parts"). The whole point of
// this rewrite is the FULL episode list for long series: anikai.cc renders
// every episode anchor inline on the watch page, so One Piece returns ~1165 and
// Naruto ~220 from a SINGLE page fetch — no pagination, no AJAX windowing.
//
// THE CHAIN (every hop verified live against www3.anikai.cc, June 2026):
//
//   search   GET /ajax/search?keyword=<q>         (HTML grid of .aitem cards)
//            (the SSR /browser?keyword= also works but returns fewer cards.)
//   home     GET /ajax/widget/<alias>?page=1       (same .aitem card grid)
//            aliases: trending, recently-updated, most-popular, top-airing, ...
//   popular  GET /browser?sort=most-popular        (.aitem grid)
//   detail   GET /watch/<slug>                      ONE page carries everything:
//              - <a class="title d-title" data-en data-jp itemprop="name">
//              - <img itemprop="image" src="<poster>">
//              - <div class="desc text-expand">synopsis</div>
//              - a labelled <div class="detail"> block (Genres/Status/Studios/
//                Premiered/Date aired/Country)
//              - the FULL episode list as <a href="/watch/<slug>/ep-N"
//                data-num="N" data-jp="<ep title>" data-sub data-dub data-hsub>
//                anchors (1165 of them for One Piece) — we parse them all.
//   video    The episode page (/watch/<slug>/ep-N — or the base /watch/<slug>,
//            which IS ep-1) embeds language server groups:
//              <div class="server-items lang-group" data-id="sub|hsub|dub">
//                ... <... class="server-video" data-video="<EMBED_URL>"> ...
//            We pick servers for the chosen language, then resolve each embed.
//            Live embed hosts are MegaCloud/JWPlayer-style players that expose a
//            PLAIN HLS master directly in the embed page HTML:
//              bibiemb.xyz / vibeplayer.site -> `const src = "<master.m3u8>"`
//              (NO decryption, NO /media/ call). The subtitle, when present, is
//              the embed URL's own ?sub=/?caption_1=/?c1_file= query param.
//            otakuhg.site / otakuvid.online are deprioritized (packed JWPlayer,
//            harder to reverse) and playmogo.com is hard-Cloudflare-walled.
//
// CLOUDFLARE: anikai.cc sits behind Cloudflare. It currently answers plain
// requests, but the challenge can switch on, so every anikai.cc request goes
// through the native WebView solver via { browser: true }. IMPORTANT: when
// browser:true is set we must NOT also send our own User-Agent — the bridge
// forces the cf_clearance-matching UA, and a mismatched UA would 403. So
// anikai.cc requests carry only Referer/Accept; the embed hosts (bibiemb,
// vibeplayer, ...) are plain hosts and DO get our explicit UA + Referer.
//
// enc-dec.app / MegaUp decMega: NOT needed for the current live embed hosts
// (they hand back a plain m3u8). A MegaUp fallback (/media/<id> -> dec-mega) is
// implemented for resilience in case anikai rotates back to a megaup-family
// embed, but it is last-resort behind the plain-m3u8 hosts.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'animekai';

// anikai.cc redirects to the active numbered mirror (currently www3). We pin a
// known-good mirror and fall back across the family if it stops resolving.
var BASE = 'https://www3.anikai.cc';
var MIRRORS = ['https://www3.anikai.cc', 'https://www1.anikai.cc',
  'https://www2.anikai.cc', 'https://www4.anikai.cc', 'https://anikai.cc'];

// UA for the EMBED hosts only (NOT anikai.cc — that uses the solver's UA).
var EMBED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) '
  + 'Gecko/20100101 Firefox/134.0';

// MegaUp-family hosts (used only by the last-resort decMega fallback).
var MEGA_HOSTS = ['megaup.nl', 'megaup.live', 'megaup.cc', 'megaup22.online',
  '4spromax.site'];

function getInfo() {
  return { name: 'AnimeKai', lang: 'en', baseUrl: BASE,
    logo: BASE + '/favicon.ico', type: 'anime', version: '3.0.0' };
}

function _mode(opts) { return (opts && opts.category === 'dub') ? 'dub' : 'sub'; }

// ── HTTP helpers ─────────────────────────────────────────────────────────────
// anikai.cc request: route through the CF solver (browser:true) and DO NOT set
// User-Agent (the bridge forces the cf_clearance-matching UA; a provider UA
// would mismatch and 403). Only Referer/Accept are safe to send.
function _kai(url, opts) {
  opts = opts || {};
  var headers = {
    'Referer': opts.referer || (BASE + '/'),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  if (opts.xhr) headers['X-Requested-With'] = 'XMLHttpRequest';
  return fetch(url, {
    method: 'GET', headers: headers, browser: true,
    timeoutMs: opts.timeoutMs || 20000
  }).then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}

// Plain (non-anikai) host fetch: explicit UA + Referer.
function _get(url, ref) {
  return fetch(url, {
    headers: { 'User-Agent': EMBED_UA, 'Referer': ref || (BASE + '/') },
    timeoutMs: 20000
  }).then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}

function _attr(tag, name) {
  var m = String(tag || '').match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? m[1] : '';
}
function _year(s) { var m = String(s || '').match(/(19|20)\d{2}/); return m ? m[0] : null; }

// path of /watch/<slug> (drop /ep-N suffix, host, query, hash) → "watch/<slug>".
function _slugFromHref(href) {
  href = String(href || '').split('#')[0].split('?')[0];
  href = href.replace(/^https?:\/\/[^\/]+/i, '');
  // /watch/<slug>(/ep-N)? -> keep just /watch/<slug>
  var m = href.match(/\/watch\/([a-z0-9][a-z0-9-]*)/i);
  if (m) return 'watch/' + m[1];
  return href.replace(/^\//, '').replace(/\/$/, '');
}

// ── card parsing ─────────────────────────────────────────────────────────────
// Catalog cards are `<div class="aitem">` blocks:
//   <a class="poster" href="/watch/<slug>(/ep-N)?"> <img (data-src|src)="<poster>">
//   <a class="title d-title" data-jp data-en title>Title</a>
//   <div class="info"> <span class="sub">..N</span> <span class="dub">..N</span> ...
function _card(block) {
  var poster = block.match(/<a[^>]+class="[^"]*\bposter\b[^"]*"[^>]*href="([^"]+)"/i)
            || block.match(/href="([^"]+)"[^>]*class="[^"]*\bposter\b/i);
  var href = poster ? poster[1] : '';
  if (!href) {
    var any = block.match(/href="(\/watch\/[^"]+)"/i);
    href = any ? any[1] : '';
  }
  var slug = _slugFromHref(href);
  if (!slug || slug.indexOf('watch/') !== 0) return null;

  var titleTag = (block.match(/<a[^>]+class="[^"]*\btitle\b[^"]*"[^>]*>/i) || [])[0] || '';
  var title = _attr(titleTag, 'data-en') || _attr(titleTag, 'title') || '';
  var jp = _attr(titleTag, 'data-jp') || null;
  if (!title) {
    var inner = block.match(/<a[^>]+class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    title = inner ? htmlText(inner[1]) : '';
  }
  if (!title) {
    var img = block.match(/<img[^>]+alt="([^"]+)"/i);
    title = img ? img[1] : 'Untitled';
  }

  var imgM = block.match(/<img[^>]+(?:data-src|src)="([^"]+)"/i);
  var cover = imgM ? imgM[1] : null;

  var sub = parseInt((block.match(/class="sub"[\s\S]{0,120}?(\d+)\s*<\/span>/i) || [])[1] || '0', 10) || 0;
  var dub = parseInt((block.match(/class="dub"[\s\S]{0,120}?(\d+)\s*<\/span>/i) || [])[1] || '0', 10) || 0;

  return {
    id: slug, title: title, englishTitle: title, japaneseTitle: jp,
    cover: cover ? absUrl(cover, BASE) : null, url: slug, type: 'anime',
    sourceId: SOURCE_ID, subCount: sub, dubCount: dub
  };
}
function _cards(html) {
  var out = [], seen = {};
  var parts = String(html || '').split(/<div[^>]*class="[^"]*\baitem\b/i);
  for (var i = 1; i < parts.length; i++) {
    var c = _card('<div class="aitem' + parts[i].slice(0, 2600));
    if (c && !seen[c.id]) { seen[c.id] = 1; out.push(c); }
  }
  return out;
}

// ── search / home / popular ──────────────────────────────────────────────────
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 1) return Promise.resolve([]);
  var p = parseInt(page, 10) || 1;
  var url = BASE + '/ajax/search?keyword=' + encodeURIComponent(q)
    + (p > 1 ? '&page=' + p : '');
  return _kai(url, { xhr: true }).then(function (html) {
    var cards = _cards(html);
    if (cards.length) return cards;
    // Fallback to the SSR browser route if the ajax endpoint returns nothing.
    return _kai(BASE + '/browser?keyword=' + encodeURIComponent(q))
      .then(function (h2) { return _cards(h2); });
  }).catch(function () { return []; });
}

function popular(opts) {
  return _kai(BASE + '/browser?sort=most-popular')
    .then(function (html) { return _cards(html); })
    .catch(function () { return []; });
}

// Home rows from the homepage widget endpoints (each returns a .aitem grid).
function getHome(opts) {
  var rows = [
    { title: 'Trending',         alias: 'trending' },
    { title: 'Recently Updated', alias: 'recently-updated' },
    { title: 'Most Popular',     alias: 'most-popular' },
    { title: 'Top Airing',       alias: 'top-airing' },
    { title: 'Recently Added',   alias: 'recently-added' }
  ];
  return Promise.all(rows.map(function (r) {
    return _kai(BASE + '/ajax/widget/' + r.alias + '?page=1', { xhr: true })
      .then(function (html) { return { title: r.title, items: _cards(html) }; })
      .catch(function () { return { title: r.title, items: [] }; });
  })).then(function (out) {
    return out.filter(function (r) { return r.items.length; });
  }).catch(function () { return []; });
}

// ── detail / episodes ────────────────────────────────────────────────────────
// Episode url packs: category | watch-slug | ep-number. getVideoSources rebuilds
// the episode page URL (/watch/<slug>/ep-<num>) and resolves servers from it.
function _epUrl(cat, slug, num) {
  return 'animekai://' + cat + '|' + encodeURIComponent(slug || '')
    + '|' + encodeURIComponent(String(num));
}

// Labelled rows in the watch page's <div class="detail"> block:
//   Genres: <span> <a>..</a><a>..</a> </span>   Status: <span>..</span>  etc.
function _detailField(html, label) {
  var re = new RegExp(label + '\\s*:?\\s*<\\/?[a-z]*>?\\s*<span[^>]*>([\\s\\S]{0,1200}?)<\\/span>', 'i');
  var m = html.match(re);
  if (m) return m[1];
  // looser: the label text immediately followed by a <span> value
  var re2 = new RegExp(label + '\\s*:?[\\s\\S]{0,40}?<span[^>]*>([\\s\\S]{0,1200}?)<\\/span>', 'i');
  m = html.match(re2);
  return m ? m[1] : '';
}

function _detailFromWatch(html, slug) {
  var titleTag = (html.match(/<[a-z0-9]+[^>]*\bitemprop="name"[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>/i)
               || html.match(/<a[^>]+class="[^"]*\btitle\b[^"]*"[^>]*>/i) || [])[0] || '';
  var title = _attr(titleTag, 'data-en') || _attr(titleTag, 'title') || '';
  var jp = _attr(titleTag, 'data-jp') || null;
  if (!title) {
    var in1 = html.match(/itemprop="name"[^>]*>([^<]+)</i);
    title = in1 ? htmlText(in1[1]) : slug.replace(/^watch\//, '').replace(/-/g, ' ');
  }

  var poster = (html.match(/<img[^>]+itemprop="image"[^>]+src="([^"]+)"/i)
             || html.match(/<img[^>]+(?:data-src|src)="([^"]+)"[^>]*alt="[^"]*"/i) || [])[1] || null;

  var desc = htmlText((html.match(/class="desc[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');

  var base = {
    id: slug, title: title, englishTitle: title, japaneseTitle: jp,
    cover: poster ? absUrl(poster, BASE) : null, url: slug,
    description: desc, status: 'unknown', genres: [], studios: [],
    type: 'anime', sourceId: SOURCE_ID, episodes: [], year: null,
    malId: null, subCount: 0, dubCount: 0
  };

  var statusSeg = _detailField(html, 'Status');
  var status = htmlText(statusSeg);
  if (status) base.status = status.toLowerCase();

  var airedSeg = _detailField(html, 'Premiered') || _detailField(html, 'Date aired')
    || _detailField(html, 'Aired');
  var year = _year(htmlText(airedSeg));
  if (year) base.year = year;

  var genreSeg = _detailField(html, 'Genres');
  var genres = [], gm, gre = /<a[^>]*>([^<]+)<\/a>/gi;
  while ((gm = gre.exec(genreSeg)) !== null) {
    var g = htmlText(gm[1]).replace(/^,\s*/, '');
    if (g) genres.push(g);
  }
  if (genres.length) base.genres = genres.slice(0, 10);

  var studioSeg = _detailField(html, 'Studios');
  var studios = [], sm, sre = /<a[^>]*>([^<]+)<\/a>/gi;
  while ((sm = sre.exec(studioSeg)) !== null) {
    var s = htmlText(sm[1]).replace(/^,\s*/, '');
    if (s) studios.push(s);
  }
  if (studios.length) base.studios = studios.slice(0, 6);

  // MAL id (drives tracker sync). The detail block has a "MAL:" row; some pages
  // also expose a numeric mal id in a meta/link tag.
  var malM = html.match(/myanimelist\.net\/anime\/(\d+)/i)
          || html.match(/data-mal(?:-id)?="(\d+)"/i);
  if (malM && parseInt(malM[1], 10) > 0) base.malId = parseInt(malM[1], 10);

  return base;
}

// Parse EVERY episode anchor off the watch page. This is the whole point — the
// full list is rendered inline (One Piece ~1165, Naruto ~220), so no pagination.
// Each episode is:
//   <a href="/watch/<slug>/ep-N" data-num="N" data-sub data-dub data-hsub ...>
//     <num> <span data-jp="<episode title>">  <episode title>  </span>
//   </a>
// The display title lives in the CHILD <span data-jp="...">, not on the anchor.
function _parseEpisodes(html, slug, cat) {
  var eps = [], m, subN = 0, dubN = 0;
  // capture the open <a> tag attrs (m[1]) AND the anchor inner content (m[2]).
  var re = /<a\b([^>]*\bhref="\/watch\/[^"]*\/ep-[0-9.]+"[^>]*)>([\s\S]*?)<\/a>/gi;
  while ((m = re.exec(html)) !== null) {
    var tag = '<a ' + m[1] + '>';
    var inner = m[2] || '';
    var href = _attr(tag, 'href');
    var numStr = _attr(tag, 'data-num');
    var num = parseFloat(numStr);
    if (!num && num !== 0) {
      var hm = href.match(/\/ep-([0-9.]+)/i);
      num = hm ? parseFloat(hm[1]) : NaN;
    }
    if (isNaN(num)) continue;
    var hasSub = _attr(tag, 'data-sub') === '1' || _attr(tag, 'data-hsub') === '1';
    var hasDub = _attr(tag, 'data-dub') === '1';
    if (hasSub) subN++;
    if (hasDub) dubN++;
    // Title: child <span data-jp="..."> attribute first, else the span's text.
    var t = (inner.match(/data-jp="([^"]*)"/i) || [])[1] || '';
    if (!t) t = htmlText(inner.replace(/^\s*\d+\s*/, ''));
    t = htmlText(t).replace(/^\d+\s+/, '');
    // The site sometimes uses the bare number as placeholder text — treat as none.
    if (/^\s*$/.test(t) || t === String(num) || /^episode\s*\d+$/i.test(t)) t = '';
    eps.push({ num: num, title: t || null, hasSub: hasSub, hasDub: hasDub });
  }
  // de-dup by number, keep order, sort ascending.
  var seen = {}, uniq = [];
  for (var i = 0; i < eps.length; i++) {
    if (seen[eps[i].num]) continue;
    seen[eps[i].num] = 1; uniq.push(eps[i]);
  }
  uniq.sort(function (a, b) { return a.num - b.num; });

  var out = [];
  for (var k = 0; k < uniq.length; k++) {
    var ep = uniq[k];
    out.push({
      id: cat + ':' + ep.num,
      number: ep.num,
      title: ep.title || ('Episode ' + ep.num),
      url: _epUrl(cat, slug, ep.num)
    });
  }
  return { episodes: out, subCount: subN, dubCount: dubN };
}

function getDetail(url, opts) {
  var slug = _slugFromHref(String(url));
  if (slug.indexOf('watch/') !== 0) slug = 'watch/' + slug.replace(/^\//, '');
  var cat = _mode(opts);
  var watchUrl = BASE + '/' + slug;
  return _kai(watchUrl).then(function (html) {
    if (!html) throw new Error('AnimeKai: empty watch page');
    var base = _detailFromWatch(html, slug);
    var ep = _parseEpisodes(html, slug, cat);
    base.episodes = ep.episodes;
    if (ep.subCount || ep.dubCount) { base.subCount = ep.subCount; base.dubCount = ep.dubCount; }
    return base;
  });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return d.episodes; });
}

// ── video sources ────────────────────────────────────────────────────────────
// episode url -> episode page -> server-items groups for the chosen language ->
// resolve each embed to a plain m3u8 (+ subtitle from the embed's query param).
function getVideoSources(episodeUrl) {
  var raw = String(episodeUrl).replace('animekai://', '');
  var parts = raw.split('|');
  var cat = parts[0] || 'sub';
  var slug = parts[1] ? decodeURIComponent(parts[1]) : '';
  var num = parts[2] ? decodeURIComponent(parts[2]) : '';
  if (slug.indexOf('watch/') !== 0) slug = 'watch/' + slug.replace(/^\//, '');
  if (!num) return Promise.reject(new Error('AnimeKai: no episode number'));

  var epPageUrl = BASE + '/' + slug + '/ep-' + num;

  return _kai(epPageUrl, { referer: BASE + '/' + slug }).then(function (html) {
    if (!html) throw new Error('AnimeKai: empty episode page');
    var servers = _parseServers(html);
    if (!servers.length) throw new Error('AnimeKai: no servers on episode page');

    // Language preference: dub -> [dub]; sub -> prefer hard-sub, then soft-sub.
    var langMap = {
      sub: ['hsub', 'sub', 'softsub'],
      dub: ['dub']
    };
    var wanted = langMap[cat] || ['hsub', 'sub'];
    var pool = servers.filter(function (s) { return wanted.indexOf(s.lang) !== -1; });
    if (!pool.length) pool = servers.slice();

    // Subtitles aren't on the stream — anikai attaches them as the embed URL's
    // own ?sub=/?caption_1= query param, and only SOME server variants carry it.
    // Collect every subtitle present anywhere in this language group so we can
    // attach it to whichever server we actually resolve.
    var groupSubs = [], subSeen = {};
    for (var si = 0; si < pool.length; si++) {
      var es = _embedSubtitles(pool[si].videoUrl);
      for (var ei = 0; ei < es.length; ei++) {
        if (!subSeen[es[ei].url]) { subSeen[es[ei].url] = 1; groupSubs.push(es[ei]); }
      }
    }

    // Prefer the plain-m3u8 hosts (bibiemb / vibeplayer) — they need no
    // decryption. Deprioritize CF-walled / packed hosts. Break ties toward the
    // embed variant that itself carries the subtitle param.
    pool.sort(function (a, b) {
      var d = _hostRank(b.videoUrl) - _hostRank(a.videoUrl);
      if (d) return d;
      return (_embedSubtitles(b.videoUrl).length ? 1 : 0)
           - (_embedSubtitles(a.videoUrl).length ? 1 : 0);
    });

    return _resolvePool(pool, cat, 0, groupSubs);
  });
}

// Score embed hosts: higher = try first (plain m3u8 in page = best).
function _hostRank(u) {
  u = String(u || '');
  if (/bibiemb\.|vibeplayer\./i.test(u)) return 5;       // plain `const src` m3u8
  if (/megaup|4spromax/i.test(u)) return 3;              // MegaUp -> decMega
  if (/otakuhg|otakuvid/i.test(u)) return 2;             // packed JWPlayer
  if (/playmogo/i.test(u)) return 1;                     // Cloudflare-walled
  return 0;
}

// Try each server in turn; return the first that yields sources. `groupSubs` is
// the subtitle set harvested across the whole language group (used as a fallback
// when the resolved embed didn't carry its own subtitle param).
function _resolvePool(pool, cat, idx, groupSubs) {
  if (idx >= pool.length) return Promise.reject(new Error('AnimeKai: no playable source'));
  var srv = pool[idx];
  return _resolveEmbed(srv, cat, groupSubs).then(function (sources) {
    if (sources && sources.length) return sources;
    return _resolvePool(pool, cat, idx + 1, groupSubs);
  }).catch(function () {
    return _resolvePool(pool, cat, idx + 1, groupSubs);
  });
}

// Parse <div class="server-items lang-group" data-id="LANG"> groups, each with
// <... class="server-video" data-video="EMBED"> entries. Mirror Sozo's parser.
function _parseServers(html) {
  var out = [];
  if (typeof html !== 'string') return out;
  var groupRe = /<[a-z0-9]+[^>]*\bclass="[^"]*\bserver-items\b[^"]*"[^>]*\bdata-id="([^"]+)"[^>]*>/gi;
  var groups = [], g;
  while ((g = groupRe.exec(html)) !== null) {
    groups.push({ lang: g[1].toLowerCase(), start: g.index + g[0].length });
  }
  for (var i = 0; i < groups.length; i++) {
    var cur = groups[i];
    var end = (i + 1 < groups.length) ? groups[i + 1].start : html.length;
    var inner = html.slice(cur.start, end);
    var srvRe = /<(?:span|div|li|a)\b([^>]*\bdata-video="([^"]+)"[^>]*)>([\s\S]*?)<\/(?:span|div|li|a)>/gi;
    var s;
    while ((s = srvRe.exec(inner)) !== null) {
      var attrs = s[1];
      var videoUrl = s[2];
      if (!/\bserver(?:-video)?\b/.test(attrs)) continue;
      var name = htmlText(s[3]) || 'Server';
      out.push({ lang: cur.lang, name: name, videoUrl: videoUrl });
    }
  }
  return out;
}

// Resolve one server embed → array of Zangetsu source objects. The embed's own
// ?sub= param takes precedence; `groupSubs` fills in if it carried none.
function _resolveEmbed(srv, cat, groupSubs) {
  var embed = srv.videoUrl;
  // An anikai /iframe/ wrapper unwraps to the real embed.
  if (/anikai\.(?:to|cc)\/iframe\//i.test(embed)) {
    return _kai(embed).then(function (h) {
      var nested = (h.match(/<iframe[^>]+src="([^"]+)"/i) || [])[1];
      if (nested) return _resolveByHost(absUrl(nested, embed), srv, cat, groupSubs);
      return _resolveByHost(embed, srv, cat, groupSubs);
    });
  }
  return _resolveByHost(embed, srv, cat, groupSubs);
}

function _resolveByHost(embed, srv, cat, groupSubs) {
  if (/bibiemb\.|vibeplayer\./i.test(embed)) return _plainEmbed(embed, srv, cat, groupSubs);
  if (/\/e2?\/[^?#/]+/.test(embed) && /megaup|4spromax/i.test(embed)) return _megaUp(embed, srv, cat, groupSubs);
  // otakuhg/otakuvid/playmogo: best-effort generic m3u8 scrape.
  return _plainEmbed(embed, srv, cat, groupSubs);
}

// Merge subtitle lists by url (left wins on duplicates).
function _mergeSubs(a, b) {
  var out = (a || []).slice(), seen = {};
  for (var i = 0; i < out.length; i++) seen[out[i].url] = 1;
  for (var k = 0; k < (b || []).length; k++) {
    if (!seen[b[k].url]) { seen[b[k].url] = 1; out.push(b[k]); }
  }
  return out;
}

// Pull a subtitle URL out of the embed's own query string (anikai passes it as
// ?sub= / ?caption_1= / ?c1_file=). Returns [] or one subtitle entry.
function _embedSubtitles(embed) {
  var m = embed.match(/[?&](?:sub|caption_1|c1_file|sub_file|subtitle)=([^&]+)/i);
  if (!m) return [];
  var u = m[1];
  try { u = decodeURIComponent(u); } catch (e) { /* keep raw */ }
  if (!/^https?:\/\//i.test(u)) return [];
  var label = (embed.match(/[?&](?:sub_1|c1_label|caption_label)=([^&]+)/i) || [])[1] || 'English';
  try { label = decodeURIComponent(label); } catch (e) {}
  return [{ url: u, lang: label, label: label,
    format: /\.srt(\?|$)/i.test(u) ? 'srt' : 'vtt', 'default': true }];
}

// bibiemb / vibeplayer: the master m3u8 is in the page as `const src = "..."`
// (also matches a bare https://...master.m3u8). No decryption.
function _plainEmbed(embed, srv, cat, groupSubs) {
  var origin = (embed.match(/^(https?:\/\/[^\/]+)/i) || [])[1] || BASE;
  return _get(embed, BASE + '/').then(function (html) {
    var file = (html.match(/const\s+src\s*=\s*"([^"]+\.m3u8[^"]*)"/i)
             || html.match(/(?:"file"|file)\s*:\s*"([^"]+\.m3u8[^"]*)"/i)
             || html.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i) || [])[1];
    if (!file) throw new Error('AnimeKai: no m3u8 in embed');
    // Prefer this embed's own subtitle; fall back to the group's.
    var subs = _embedSubtitles(embed);
    if (!subs.length) subs = (groupSubs || []).slice();
    // In-page tracks (rare) — merge.
    var trkRe = /file\s*:\s*"([^"]+\.vtt[^"]*)"[\s\S]{0,80}?label\s*:\s*"([^"]*)"/gi, tm;
    while ((tm = trkRe.exec(html)) !== null) {
      subs.push({ url: tm[1], lang: tm[2] || 'Sub', label: tm[2] || 'Sub', format: 'vtt', 'default': false });
    }
    return _fanM3u8(file, origin, cat, subs);
  });
}

// MegaUp fallback (only if anikai rotates back to a megaup-family embed):
//   GET {host}/media/{id} -> { result: <cipher> } -> dec-mega -> { sources, tracks }.
function _megaUp(embed, srv, cat, groupSubs) {
  var idm = embed.match(/\/e2?\/([^?#/]+)/);
  if (!idm) throw new Error('AnimeKai: bad mega id');
  var id = idm[1];
  var origHost = (embed.match(/^https?:\/\/([^\/]+)/i) || [])[1] || '';
  origHost = origHost.replace(/^www\./, '');
  var hosts = [], seen = {};
  if (origHost) { hosts.push(origHost); seen[origHost] = 1; }
  for (var i = 0; i < MEGA_HOSTS.length; i++) {
    if (!seen[MEGA_HOSTS[i]]) { hosts.push(MEGA_HOSTS[i]); seen[MEGA_HOSTS[i]] = 1; }
  }
  function tryHost(j) {
    if (j >= hosts.length) return Promise.reject(new Error('AnimeKai: mega hosts exhausted'));
    var host = hosts[j];
    return fetch('https://' + host + '/media/' + id, {
      headers: {
        'User-Agent': EMBED_UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.5',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://' + host + '/e/' + id, 'Origin': 'https://' + host
      }, timeoutMs: 15000
    }).then(function (r) {
      var j2; try { j2 = JSON.parse(r.body || 'null'); } catch (e) { j2 = null; }
      var cipher = j2 && j2.result;
      if (!cipher) throw new Error('no result');
      return _decMega(cipher, EMBED_UA).then(function (dec) {
        var sources = (dec && dec.sources) || [];
        var tracks = (dec && dec.tracks) || [];
        if (!sources.length) throw new Error('no sources');
        var subs = [];
        for (var t = 0; t < tracks.length; t++) {
          var tr = tracks[t];
          if (!tr || !tr.file) continue;
          if (tr.kind && tr.kind !== 'captions' && tr.kind !== 'subtitles') continue;
          subs.push({ url: tr.file, lang: tr.label || 'Sub', label: tr.label || 'Sub',
            format: /\.srt(\?|$)/i.test(tr.file) ? 'srt' : 'vtt', 'default': !!tr['default'] });
        }
        if (!subs.length) subs = (groupSubs || []).slice();
        var file = sources[0].file;
        var origin = 'https://' + host;
        return _fanM3u8(file, origin, cat, subs);
      });
    }).catch(function () { return tryHost(j + 1); });
  }
  return tryHost(0);
}

// enc-dec.app dec-mega: decrypt a MegaUp media cipher. `agent` MUST equal the UA
// used to fetch /media/ (server-side validates the UA). External dependency.
function _decMega(cipher, agent) {
  return fetch('https://enc-dec.app/api/dec-mega', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ text: cipher, agent: agent }),
    timeoutMs: 15000
  }).then(function (r) {
    var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { j = null; }
    if (!j) throw new Error('AnimeKai: dec-mega bad response');
    // service returns either {sources,tracks} or {result:{sources,tracks}}
    if (j.sources || j.tracks) return j;
    if (j.result && (j.result.sources || j.result.tracks)) return j.result;
    if (typeof j.result === 'string') { try { return JSON.parse(j.result); } catch (e) {} }
    return j;
  });
}

// A master m3u8 → "auto" + one source per rendition (real quality menu). Falls
// back to a single source if the master can't be read or isn't adaptive.
function _fanM3u8(file, origin, cat, subs) {
  var hdrs = { 'User-Agent': EMBED_UA, 'Referer': origin + '/', 'Origin': origin };
  subs = subs || [];
  subs.sort(function (a, b) { return (b['default'] ? 1 : 0) - (a['default'] ? 1 : 0); });
  function mk(u, q) {
    return { url: u, quality: q,
      container: /\.m3u8(\?|$)/i.test(u) ? 'hls' : 'mp4',
      headers: hdrs, kind: cat, audioLang: cat === 'dub' ? 'en' : 'ja',
      subtitles: subs };
  }
  if (!/\.m3u8(\?|$)/i.test(file)) return Promise.resolve([mk(file, 'auto')]);
  return _get(file, origin + '/').then(function (body) {
    body = body || '';
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
}

// No per-source settings UI for AnimeKai.
function getSettings() { return []; }
