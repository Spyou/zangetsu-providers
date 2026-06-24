// MovieBox — movie/series source for the Zangetsu provider repo.
//
// Talks to the MovieBox mobile BFF API (api3.aoneroom.com) directly. The API
// requires two signed headers per request:
//   x-client-token : "<ts>,<md5(reverse(ts))>"
//   x-tr-signature : "<ts>|2|<base64(hmac-md5(canonical, key))>"
// The runtime only exposes sha256, so MD5 + HMAC-MD5 are implemented here in
// pure JS. The canonical string + the signing key match the official client.
//
// Chain: subject-api/search/v2 (POST) -> subject-api/get + season-info (GET) ->
// subject-api/play-info (GET) -> direct streams (mp4 / m3u8 / mpd).

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'moviebox';

var HOST = 'https://api3.aoneroom.com';
var BFF = '/wefeed-mobile-bff';
// base64( base64( key ) ) — decoded twice to the raw HMAC-MD5 key bytes.
var KEY_B64 = 'NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==';
var UA = 'com.community.oneroom/50020088 (Linux; U; Android 13; en_US; '
  + 'Pixel 7; Build/TQ3A.230901.001; Cronet/145.0.7582.0)';

// ── pure-JS MD5 / HMAC-MD5 / base64 (the runtime only ships sha256) ───────────
function _utf8(str) {
  var o = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) o.push(c);
    else if (c < 0x800) { o.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c < 0xd800 || c >= 0xe000) {
      o.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      i++; var c2 = str.charCodeAt(i);
      var cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      o.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return o;
}
function _add(a, b) { // 32-bit add without float precision loss
  var lo = (a & 0xffff) + (b & 0xffff);
  var hi = (a >> 16) + (b >> 16) + (lo >> 16);
  return ((hi & 0xffff) << 16) | (lo & 0xffff);
}
function _rol(n, c) { return (n << c) | (n >>> (32 - c)); }
var _MD5K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
  0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
  0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391];
var _MD5S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
// MD5 of a byte array -> 16-byte array.
function _md5bytes(bytes) {
  var msg = bytes.slice();
  var bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // 64-bit LE length. JS shifts are mod-32, so only the low 4 bytes are derived
  // from bitLen; the high 4 are 0 (our inputs are far under 512 MB).
  for (var b = 0; b < 8; b++) msg.push(b < 4 ? ((bitLen >>> (8 * b)) & 0xff) : 0);
  var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (var off = 0; off < msg.length; off += 64) {
    var M = [];
    for (var j = 0; j < 16; j++) {
      M[j] = msg[off + j * 4] | (msg[off + j * 4 + 1] << 8) |
        (msg[off + j * 4 + 2] << 16) | (msg[off + j * 4 + 3] << 24);
    }
    var A = a0, B = b0, C = c0, D = d0;
    for (var i = 0; i < 64; i++) {
      var F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = _add(_add(_add(F, A), _MD5K[i]), M[g]);
      A = D; D = C; C = B;
      B = _add(B, _rol(F, _MD5S[i]));
    }
    a0 = _add(a0, A); b0 = _add(b0, B); c0 = _add(c0, C); d0 = _add(d0, D);
  }
  var out = [];
  var words = [a0, b0, c0, d0];
  for (var w = 0; w < 4; w++)
    for (var k = 0; k < 4; k++) out.push((words[w] >>> (8 * k)) & 0xff);
  return out;
}
function _toHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
  return s;
}
function _md5hex(str) { return _toHex(_md5bytes(_utf8(str))); }
function _hmacMd5(keyBytes, msgBytes) {
  var key = keyBytes.slice();
  if (key.length > 64) key = _md5bytes(key);
  while (key.length < 64) key.push(0);
  var ipad = [], opad = [];
  for (var i = 0; i < 64; i++) { ipad.push(key[i] ^ 0x36); opad.push(key[i] ^ 0x5c); }
  var inner = _md5bytes(ipad.concat(msgBytes));
  return _md5bytes(opad.concat(inner));
}
var _B64A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function _b64enc(bytes) {
  var o = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0,
      b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    o += _B64A[b0 >> 2] + _B64A[((b0 & 3) << 4) | (b1 >> 4)];
    o += i + 1 < bytes.length ? _B64A[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    o += i + 2 < bytes.length ? _B64A[b2 & 63] : '=';
  }
  return o;
}
function _b64dec(str) {
  var look = {}; for (var i = 0; i < _B64A.length; i++) look[_B64A[i]] = i;
  str = String(str).replace(/[^A-Za-z0-9+/]/g, '');
  var o = [], bits = 0, val = 0;
  for (var j = 0; j < str.length; j++) {
    var c = look[str[j]]; if (c === undefined) continue;
    val = (val << 6) | c; bits += 6;
    if (bits >= 8) { bits -= 8; o.push((val >>> bits) & 0xff); }
  }
  return o;
}

// ── request signing ──────────────────────────────────────────────────────────
var _keyBytes = null;
function _key() {
  if (_keyBytes) return _keyBytes;
  var s = ''; var first = _b64dec(KEY_B64);
  for (var i = 0; i < first.length; i++) s += String.fromCharCode(first[i]);
  _keyBytes = _b64dec(s); // double-decode -> raw HMAC key
  return _keyBytes;
}
function _now() { return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; }
function _clientToken(ts) {
  var rev = String(ts).split('').reverse().join('');
  return ts + ',' + _md5hex(rev);
}
function _canonical(method, accept, ctype, url, body, ts) {
  var path = url.replace(/^https?:\/\/[^/]+/, '');
  var qi = path.indexOf('?');
  var canonUrl = path;
  if (qi !== -1) {
    var base = path.slice(0, qi);
    var pairs = path.slice(qi + 1).split('&').filter(function (x) { return x; });
    pairs.sort();
    canonUrl = base + '?' + pairs.join('&');
  }
  var bodyHash = '', bodyLen = '';
  if (body != null) { var bb = _utf8(body); bodyLen = String(bb.length); bodyHash = _toHex(_md5bytes(bb)); }
  return method.toUpperCase() + '\n' + (accept || '') + '\n' + (ctype || '') +
    '\n' + bodyLen + '\n' + ts + '\n' + bodyHash + '\n' + canonUrl;
}
function _trSig(method, accept, ctype, url, body, ts) {
  var canon = _canonical(method, accept, ctype, url, body, ts);
  var sig = _b64enc(_hmacMd5(_key(), _utf8(canon)));
  return ts + '|2|' + sig;
}
// Guest auth: a request from a fresh device_id gets a JWT back in the x-user
// response header; play-info needs it as `Authorization: Bearer`. We mint one
// device_id per session and capture the token off the first response that
// carries it (the JWT is good for ~months, so once per session is plenty).
var _device = null, _token = null, _authPromise = null;
function _dev() { if (!_device) _device = _md5hex(String(_now()) + 'zmb').slice(0, 16); return _device; }
function _clientInfo() {
  return '{"package_name":"com.community.oneroom","version_name":"3.0.13.0325.03",'
    + '"version_code":50020088,"os":"android","os_version":"13","install_ch":"ps",'
    + '"device_id":"' + _dev() + '","install_store":"ps","gaid":'
    + '"1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d","brand":"Pixel 7","model":"Google",'
    + '"system_language":"en","net":"NETWORK_WIFI","region":"US","timezone":'
    + '"Asia/Calcutta","sp_code":"","X-Play-Mode":"1","X-Idle-Data":"1",'
    + '"X-Family-Mode":"0","X-Content-Mode":"0"}';
}
// Low-level signed call. GET when body is null, POST otherwise. Returns the raw
// response; captures the guest JWT from the x-user header when one appears.
function _call(path, body) {
  var url = HOST + path;
  var ts = _now();
  var isPost = body != null;
  var accept = 'application/json';
  var ctype = isPost ? 'application/json; charset=utf-8' : 'application/json';
  var headers = {
    'user-agent': UA, 'accept': accept, 'content-type': ctype, 'connection': 'keep-alive',
    'x-client-token': _clientToken(ts),
    'x-tr-signature': _trSig(isPost ? 'POST' : 'GET', accept, ctype, url, isPost ? body : null, ts),
    'x-client-info': _clientInfo(), 'x-client-status': '0'
  };
  if (_token) headers['authorization'] = 'Bearer ' + _token;
  var opts = { method: isPost ? 'POST' : 'GET', headers: headers };
  if (isPost) opts.body = body;
  return fetch(url, opts).then(function (r) {
    if (!_token && r && r.headers) {
      var xu = r.headers['x-user'] || r.headers['X-User'];
      if (xu) { try { var t = JSON.parse(xu).token; if (t) _token = t; } catch (e) { } }
    }
    return r;
  });
}
// Signed API call returning parsed JSON (or null).
function _api(path, body) {
  return _call(path, body).then(function (r) {
    try { return JSON.parse((r && r.body) || '{}'); } catch (e) { return null; }
  }).catch(function () { return null; });
}
// A stable, long-lived title — subject-api/get on it mints the guest token when
// we have no real subjectId yet (i.e. for the browse home).
var _REG_ID = '5038022591622040232';
// Mint a guest token if we don't have one. ranking-list (home) and play-info
// both 401 without it; subject-api/get returns the x-user JWT that _call grabs.
function _ensureAuth(subjectId) {
  if (_token) return Promise.resolve();
  // Share ONE in-flight registration: concurrent callers (e.g. getHome's rows
  // firing together) must WAIT for the token, not skip ahead while it's still
  // being minted — otherwise their requests go out unauthenticated and 401/null.
  if (_authPromise) return _authPromise;
  _authPromise = _call(BFF + '/subject-api/get?subjectId=' + (subjectId || _REG_ID), null)
    .then(function () { }).catch(function () { });
  return _authPromise;
}

// ── helpers / models ─────────────────────────────────────────────────────────
function _type(subjectType) { return Number(subjectType) === 2 ? 'tv' : 'movie'; }
function _coverOf(s) {
  var c = s && s.cover;
  if (!c) return null;
  return (typeof c === 'string') ? c : (c.url || null);
}
function _item(s) {
  if (!s) return null;
  var id = s.subjectId || s.id; if (!id) return null;
  var title = s.title || s.name; if (!title) return null;
  return {
    id: String(id), title: title, cover: _coverOf(s),
    url: String(id), type: _type(s.subjectType), sourceId: SOURCE_ID,
    year: (s.releaseDate ? String(s.releaseDate).slice(0, 4) : null)
  };
}
// Pull subject objects out of any of MovieBox's response shapes.
function _collect(node, out, depth) {
  if (!node || depth > 6) return;
  if (node instanceof Array) {
    for (var i = 0; i < node.length; i++) _collect(node[i], out, depth + 1);
  } else if (typeof node === 'object') {
    if (node.subjectId && (node.title || node.name)) { var it = _item(node); if (it) out.push(it); }
    for (var k in node) if (node.hasOwnProperty(k) && typeof node[k] === 'object') _collect(node[k], out, depth + 1);
  }
}
function _uniqBy(items) {
  var seen = {}, o = [];
  for (var i = 0; i < items.length; i++) { var it = items[i]; if (it && !seen[it.id]) { seen[it.id] = 1; o.push(it); } }
  return o;
}

// ── episode url packing: mb://<subjectId>/<se>/<ep> ───────────────────────────
function _ep(subjectId, se, ep) { return 'mb://' + subjectId + '/' + se + '/' + ep; }
function _unEp(url) {
  var m = String(url).match(/^mb:\/\/([^/]+)\/(\d+)\/(\d+)/);
  if (m) return { id: m[1], se: parseInt(m[2], 10), ep: parseInt(m[3], 10) };
  return { id: String(url).replace(/^mb:\/\//, ''), se: 0, ep: 0 };
}

function getInfo() {
  return {
    name: 'MovieBox', lang: 'en', baseUrl: 'https://moviebox.ph',
    logo: 'https://moviebox.ph/favicon.ico', type: 'movie', version: '1.1.0'
  };
}

function search(query, page, opts) {
  var body = JSON.stringify({ page: page || 1, perPage: 20, keyword: String(query || '') });
  return _api(BFF + '/subject-api/search/v2', body).then(function (j) {
    var out = [];
    var results = j && j.data && j.data.results;
    if (results instanceof Array) {
      for (var i = 0; i < results.length; i++) {
        var subs = results[i] && results[i].subjects;
        if (subs instanceof Array) for (var k = 0; k < subs.length; k++) { var it = _item(subs[k]); if (it) out.push(it); }
      }
    }
    return _uniqBy(out);
  }).catch(function () { return []; });
}

function getHome(opts) {
  // TEMP on-screen diagnostic: fetch ONE row and report the in-app body/parse
  // state in the section title (the device's logcat/fetch capture is unreliable;
  // a screenshot is not). Reverted once the root cause is found.
  return _ensureAuth().then(function () {
    return _call(BFF + '/tab/ranking-list?tabId=0&categoryType=4516404531735022304&page=1&perPage=10', null).then(function (r) {
      var bt = r ? (typeof r.body) : 'noR';
      var bl = (r && typeof r.body === 'string') ? r.body.length : -1;
      var st = r ? r.status : 'noR';
      var j = null, perr = '';
      try { j = JSON.parse((r && r.body) || '{}'); } catch (e) { perr = String(e).slice(0, 40); }
      var subs = (j && j.data && j.data.subjects) || [];
      var t = 'DBG st=' + st + ' bt=' + bt + ' bl=' + bl + ' j=' + (j ? 1 : 0)
        + ' code=' + (j ? j.code : 'x') + ' subs=' + subs.length + (perr ? (' E=' + perr) : '');
      return [{ title: t, items: [{ id: 'd1', title: 'diag', cover: null, url: 'd1', type: 'movie', sourceId: SOURCE_ID }] }];
    }).catch(function (e) {
      return [{ title: 'DBG CALL-THREW ' + String(e).slice(0, 60), items: [{ id: 'd2', title: 'diag', cover: null, url: 'd2', type: 'movie', sourceId: SOURCE_ID }] }];
    });
  }).catch(function (e) {
    return [{ title: 'DBG AUTH-THREW ' + String(e).slice(0, 55), items: [{ id: 'd3', title: 'diag', cover: null, url: 'd3', type: 'movie', sourceId: SOURCE_ID }] }];
  });
}

function getDetail(url, opts) {
  var id = String(url).replace(/^mb:\/\//, '').split('/')[0];
  return _api(BFF + '/subject-api/get?subjectId=' + id, null).then(function (j) {
    var d = (j && j.data) || {};
    var subjectType = d.subjectType || (d.subject && d.subject.subjectType) || 1;
    var info = d.subject || d;
    var base = {
      id: String(id), title: info.title || info.name || 'Untitled',
      cover: _coverOf(info), url: String(id),
      description: info.description || info.intro || '',
      status: 'unknown', genres: _genres(info), studios: [],
      type: _type(subjectType), sourceId: SOURCE_ID,
      year: (info.releaseDate ? String(info.releaseDate).slice(0, 4) : null),
      subCount: 0, dubCount: 0, episodes: []
    };
    if (Number(subjectType) !== 2) {
      base.episodes = [{ id: 'movie', title: base.title, number: 1, url: _ep(id, 0, 0) }];
      base.subCount = 1;
      return base;
    }
    // Series: season-info -> seasons[].maxEp.
    return _api(BFF + '/subject-api/season-info?subjectId=' + id, null).then(function (sj) {
      var seasons = sj && sj.data && sj.data.seasons;
      var eps = [];
      if (seasons instanceof Array && seasons.length) {
        for (var s = 0; s < seasons.length; s++) {
          var se = seasons[s].se != null ? seasons[s].se : (s + 1);
          var maxEp = seasons[s].maxEp || seasons[s].epCount || 0;
          for (var e = 1; e <= maxEp; e++) {
            eps.push({
              id: 's' + se + 'e' + e,
              title: (seasons.length > 1 ? 'S' + se + ' ' : '') + 'Episode ' + e,
              number: e, season: se, url: _ep(id, se, e)
            });
          }
        }
      }
      if (!eps.length) eps = [{ id: 'e1', title: base.title, number: 1, url: _ep(id, 1, 1) }];
      base.episodes = eps; base.subCount = eps.length;
      return base;
    }).catch(function () {
      base.episodes = [{ id: 'e1', title: base.title, number: 1, url: _ep(id, 1, 1) }];
      base.subCount = 1; return base;
    });
  }).catch(function () { return null; });
}
function _genres(info) {
  var g = info && (info.genre || info.genres);
  if (!g) return [];
  if (typeof g === 'string') return g.split(/[,/]/).map(function (x) { return x.replace(/^\s+|\s+$/g, ''); }).filter(Boolean);
  if (g instanceof Array) return g.map(function (x) { return (x && (x.name || x.title)) || String(x); });
  return [];
}

function getVideoSources(episodeUrl) {
  var e = _unEp(episodeUrl);
  var p = BFF + '/subject-api/play-info?subjectId=' + e.id + '&se=' + e.se + '&ep=' + e.ep;
  return _ensureAuth(e.id).then(function () { return _api(p, null); }).then(function (j) {
    var streams = j && j.data && j.data.streams;
    var out = [];
    if (streams instanceof Array) {
      for (var i = 0; i < streams.length; i++) {
        var st = streams[i]; var u = st && st.url; if (!u) continue;
        var res = st.resolutions || st.resolution || '';
        var q = _quality(res) || _quality(u) || '720p';
        var headers = { 'Referer': 'https://moviebox.ph/', 'User-Agent': UA };
        if (st.signCookie) headers['Cookie'] = String(st.signCookie);
        out.push({ url: String(u), quality: q, label: 'MovieBox' + (res ? ' [' + res + 'p]' : ''), headers: headers });
      }
    }
    return out;
  }).catch(function () { return []; });
}
function _quality(s) {
  var m = String(s || '').match(/(\d{3,4})/);
  if (m) { var n = parseInt(m[1], 10); if (n >= 100) return (n > 200 ? n : n * 10) + 'p'; }
  return null;
}
