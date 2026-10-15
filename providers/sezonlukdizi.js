// ============================================================
//  sezonlukdizi — Nuvio scraper                                  v1.1.0
//  Site: https://sezonlukdizi.cc  (yalnızca dizi)
//  Akış: TMDB -> başlık/slug -> bölüm sayfası (bölüm id'si)
//        -> dataAlternatif3.asp (dublaj + altyazı) -> dataEmbed.asp
//        -> Pixeldrain / VidMoly / Filemoon -> oynatılabilir akış
// ============================================================

var AYAR = {
  SITE: 'https://sezonlukdizi.cc',
  EKLENTI_ADI: 'SezonlukDizi',
  DEBUG_MODU: true,      // true: akış çıkmazsa nedenini "DEBUG" satırlarıyla gösterir
  MAKS_AKIS: 12,
  MAKS_ALTERNATIF: 6,    // her dil için denenecek en fazla alternatif sayısı
  ISTEK_SURESI: 9000,
  GENEL_SURE: 50000
};

var TMDB_KEY = '000316508321ce461cf81e7c6815eec7';
var PROVIDER_ID = 'sezonlukdizi';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

var dbg = [];
var CUR_PAGE = '';
var PART = [];          // çözülen akışlar (zaman aşımında yine de döndürülür)
var CAP_PEEKED = false;
function note(m) { dbg.push(String(m).slice(0, 170)); }

// ---------------- Genel yardımcılar ----------------
function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}
function req(method, url, headers, body, label, tmo) {
  tmo = tmo || AYAR.ISTEK_SURESI;
  var opt = { method: method, headers: headers || {} };
  if (body != null) opt.body = body;
  return withTimeout(fetch(url, opt), tmo).then(function (res) {
    return withTimeout(res.text(), tmo).then(
      function (t) { return { status: res.status, text: t || '', url: res.url || url }; },
      function () { return { status: res.status, text: '', url: res.url || url }; }
    );
  }).catch(function (e) {
    return { status: 0, text: '', err: (e && e.message) || 'hata', url: url };
  }).then(function (r) {
    if (label) note(label + ' ' + (r.status || r.err || '?') + '/' + r.text.length);
    return r;
  });
}
function getJson(url) { return withTimeout(fetch(url), 10000).then(function (res) { return res.json(); }); }
function uniq(list) { var out = []; list.forEach(function (x) { if (x !== undefined && x !== null && x !== '' && out.indexOf(x) === -1) out.push(x); }); return out; }
function formEnc(pairs) {
  return pairs.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&');
}
var TR_MAP = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
function trFold(s) {
  return String(s || '').replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase().replace(/[çğıöşüâîû]/g, function (c) { return TR_MAP[c]; });
}
function norm(s) { return trFold(s).replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); }
// Sitenin adres biçimi: "It's Always Sunny" -> its-always-sunny, "Finn & Jake" -> finn-jake
function slugify(s) {
  return trFold(s).replace(/['’`´]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function absUrl(u) {
  u = String(u || '').trim().replace(/&amp;/g, '&');
  if (/^\/\//.test(u)) return 'https:' + u;
  if (/^\//.test(u)) return AYAR.SITE + u;
  return u;
}
function hostOf(u) { var m = String(u).match(/^https?:\/\/([^\/?#]+)/i); return m ? m[1].toLowerCase() : ''; }
function qualityOf(s) { var m = String(s).match(/(2160|1440|1080|720|480|360)/); return m ? m[1] + 'p' : 'Auto'; }
function debugStream(msg) {
  if (!AYAR.DEBUG_MODU) return [];
  return [msg].concat(dbg.slice(0, 90)).map(function (r) {
    return { name: 'DEBUG ' + r, title: 'DEBUG ' + r, url: 'https://debug.invalid/', quality: 'Auto', provider: PROVIDER_ID };
  });
}

// ---------------- Bayt / AES-GCM (Filemoon şifreli yanıtı için) ----------------
var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64decode(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
  var out = [], i, n, a, b, c, d;
  for (i = 0; i < s.length; i += 4) {
    a = B64C.indexOf(s.charAt(i)); b = B64C.indexOf(s.charAt(i + 1));
    c = i + 2 < s.length ? B64C.indexOf(s.charAt(i + 2)) : -1; d = i + 3 < s.length ? B64C.indexOf(s.charAt(i + 3)) : -1;
    n = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    out.push((n >> 16) & 255);
    if (c >= 0) out.push((n >> 8) & 255);
    if (d >= 0) out.push(n & 255);
  }
  return out;
}
function utf8Decode(b) {
  var s = '', i = 0, c, c2, c3, c4, cp;
  while (i < b.length) {
    c = b[i++];
    if (c < 128) s += String.fromCharCode(c);
    else if (c < 224) { c2 = b[i++]; s += String.fromCharCode(((c & 31) << 6) | (c2 & 63)); }
    else if (c < 240) { c2 = b[i++]; c3 = b[i++]; s += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63)); }
    else { c2 = b[i++]; c3 = b[i++]; c4 = b[i++]; cp = (((c & 7) << 18) | ((c2 & 63) << 12) | ((c3 & 63) << 6) | (c4 & 63)) - 0x10000; s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023)); }
  }
  return s;
}
var SBOX = null;
function aesInit() {
  if (SBOX) return;
  SBOX = new Array(256);
  var p = 1, q = 1, x;
  function rotl8(v, s) { return ((v << s) | (v >> (8 - s))) & 255; }
  do {
    p = (p ^ ((p << 1) & 255) ^ ((p & 0x80) ? 0x1b : 0)) & 255;
    q ^= (q << 1) & 255; q ^= (q << 2) & 255; q ^= (q << 4) & 255;
    if (q & 0x80) q ^= 0x09;
    x = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4);
    SBOX[p] = (x ^ 0x63) & 255;
  } while (p !== 1);
  SBOX[0] = 0x63;
}
function xtime(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 255; }
function aesExpand(key) {
  aesInit();
  var nk = key.length / 4, nr = nk + 6, w = [], i, t, rcon = 1, j;
  for (i = 0; i < nk; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  for (i = nk; i < 4 * (nr + 1); i++) {
    t = w[i - 1].slice();
    if (i % nk === 0) { t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]; rcon = xtime(rcon); }
    else if (nk > 6 && i % nk === 4) t = [SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]];
    w.push([w[i - nk][0] ^ t[0], w[i - nk][1] ^ t[1], w[i - nk][2] ^ t[2], w[i - nk][3] ^ t[3]]);
  }
  var rk = [];
  for (i = 0; i <= nr; i++) { var r = []; for (j = 0; j < 4; j++) r = r.concat(w[4 * i + j]); rk.push(r); }
  return rk;
}
function aesBlock(rk, blk) {
  var nr = rk.length - 1, s = blk.slice(), r, i, t, a, b, c, d;
  for (i = 0; i < 16; i++) s[i] ^= rk[0][i];
  for (r = 1; r <= nr; r++) {
    for (i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    t = s.slice();
    s[1] = t[5]; s[5] = t[9]; s[9] = t[13]; s[13] = t[1];
    s[2] = t[10]; s[6] = t[14]; s[10] = t[2]; s[14] = t[6];
    s[3] = t[15]; s[7] = t[3]; s[11] = t[7]; s[15] = t[11];
    if (r < nr) {
      for (i = 0; i < 16; i += 4) {
        a = s[i]; b = s[i + 1]; c = s[i + 2]; d = s[i + 3];
        s[i] = xtime(a) ^ (xtime(b) ^ b) ^ c ^ d;
        s[i + 1] = a ^ xtime(b) ^ (xtime(c) ^ c) ^ d;
        s[i + 2] = a ^ b ^ xtime(c) ^ (xtime(d) ^ d);
        s[i + 3] = (xtime(a) ^ a) ^ b ^ c ^ xtime(d);
      }
    }
    for (i = 0; i < 16; i++) s[i] ^= rk[r][i];
  }
  return s;
}
function ghashMul(X, H) {
  var Z0 = 0, Z1 = 0, Z2 = 0, Z3 = 0, V0 = H[0], V1 = H[1], V2 = H[2], V3 = H[3], i, bit, lsb;
  for (i = 0; i < 128; i++) {
    bit = (X[i >> 5] >>> (31 - (i & 31))) & 1;
    if (bit) { Z0 ^= V0; Z1 ^= V1; Z2 ^= V2; Z3 ^= V3; }
    lsb = V3 & 1;
    V3 = (V3 >>> 1) | (V2 << 31); V2 = (V2 >>> 1) | (V1 << 31); V1 = (V1 >>> 1) | (V0 << 31); V0 = V0 >>> 1;
    if (lsb) V0 ^= 0xe1000000;
  }
  return [Z0 | 0, Z1 | 0, Z2 | 0, Z3 | 0];
}
function words(b, o) { return [((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) | 0, ((b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7]) | 0, ((b[o + 8] << 24) | (b[o + 9] << 16) | (b[o + 10] << 8) | b[o + 11]) | 0, ((b[o + 12] << 24) | (b[o + 13] << 16) | (b[o + 14] << 8) | b[o + 15]) | 0]; }
function ghash(H, data) {
  var Y = [0, 0, 0, 0], i, blk, k, X;
  for (i = 0; i < data.length; i += 16) {
    blk = data.slice(i, i + 16); while (blk.length < 16) blk.push(0);
    X = words(blk, 0);
    for (k = 0; k < 4; k++) Y[k] ^= X[k];
    Y = ghashMul(Y, H);
  }
  return Y;
}
function padTo16(a) { var r = a.slice(); while (r.length % 16) r.push(0); return r; }
function lenBlock(abits, cbits) {
  function be(n) { var hi = Math.floor(n / 4294967296), lo = n >>> 0; return [(hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255]; }
  return be(abits).concat(be(cbits));
}
function wordsToBytes(w) { var o = [], i; for (i = 0; i < 4; i++) o.push((w[i] >>> 24) & 255, (w[i] >>> 16) & 255, (w[i] >>> 8) & 255, w[i] & 255); return o; }
function inc32(cb) { var c = cb.slice(), i = 15; while (i >= 12) { c[i] = (c[i] + 1) & 255; if (c[i] !== 0) break; i--; } return c; }
// ct: şifreli metin + 16 baytlık etiket birleşik. Başarılıysa düz metin baytları, değilse null
function gcmDecryptCombined(key, iv, ct16) {
  if (ct16.length < 17) return null;
  var tag = ct16.slice(ct16.length - 16), ct = ct16.slice(0, ct16.length - 16);
  var rk = aesExpand(key), H = words(aesBlock(rk, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 0), j0, i, k, ctr, ks, out = [];
  if (iv.length === 12) j0 = iv.concat([0, 0, 0, 1]);
  else j0 = wordsToBytes(ghash(H, padTo16(iv).concat(lenBlock(0, iv.length * 8))));
  var gh = ghash(H, padTo16(ct).concat(lenBlock(0, ct.length * 8)));
  var ek = aesBlock(rk, j0), gb = wordsToBytes(gh);
  for (i = 0; i < 16; i++) if ((gb[i] ^ ek[i]) !== tag[i]) return null;
  ctr = inc32(j0);
  for (i = 0; i < ct.length; i += 16) {
    ks = aesBlock(rk, ctr);
    for (k = 0; k < 16 && i + k < ct.length; k++) out.push(ct[i + k] ^ ks[k]);
    ctr = inc32(ctr);
  }
  return out;
}

// ---------------- p.a.c.k.e.d açıcı ----------------
function unpack(src) {
  var m = String(src).match(/eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'), a = parseInt(m[2], 10), c = parseInt(m[3], 10), k = m[4].split('|');
  function e(n) { return (n < a ? '' : e(parseInt(n / a, 10))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36)); }
  while (c--) if (k[c]) p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]);
  return p;
}
function findM3u8(text) {
  var t = String(text || '').replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  var m = t.match(/["'](https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*)["']/i) || t.match(/(https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*)/i);
  return m ? m[1] : null;
}

// ---------------- Barındırıcı çözücüler ----------------
function resolvePixeldrain(u) {
  var m = u.match(/pixeldrain\.[a-z]+\/(?:u|api\/file)\/([A-Za-z0-9]+)/i);
  if (!m) { note('pixel id yok'); return Promise.resolve(null); }
  return Promise.resolve({ url: 'https://pixeldrain.com/api/file/' + m[1], type: 'mp4', headers: {} });
}

function resolveVidmoly(u) {
  var h = { 'User-Agent': UA, 'Referer': AYAR.SITE + '/' };
  return req('GET', u, h, null, 'VM').then(function (r) {
    var m = findM3u8(r.text);
    if (!m) { var un = unpack(r.text); if (un) m = findM3u8(un); }
    if (!m) { note('vidmoly m3u8 yok'); return null; }
    return { url: m, type: 'hls', headers: { 'User-Agent': UA, 'Referer': 'https://' + (hostOf(u) || 'vidmoly.net') + '/' } };
  });
}

function embedParent() { return CUR_PAGE || (AYAR.SITE + '/'); }
function siteHost() { return hostOf(AYAR.SITE); }
function copyObj(o) { var r = {}, k; for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; return r; }
function rndHex(n) { var t = '', i; for (i = 0; i < n; i++) t += Math.floor(Math.random() * 16).toString(16); return t; }

// Byse/Filemoon videoları "izinli alan adı" ile kilitli. Sunucu, gömen siteyi
// X-Embed-Origin / X-Embed-Parent / X-Embed-Referer başlıklarından okur.
// Bu başlıklar eksikse Origin'e (bysejikuar.com) düşer ve 403 "embedding from ... not allowed" verir.
function embedHeaderSets(u, host) {
  var page = embedParent(), site = AYAR.SITE, own = 'https://' + host;
  function mk(ref, org, par, xo, xr) {
    return { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      'Referer': ref, 'Origin': org, 'X-Embed-Parent': par, 'X-Embed-Origin': xo, 'X-Embed-Referer': xr };
  }
  return [
    mk(u, own, page, site, page),
    mk(site + '/', site, page, site, page),
    mk(u, own, site, site, site + '/'),
    mk(u, own, siteHost(), siteHost(), page)
  ];
}

function fmDetails(host, code, hd) {
  var d = copyObj(hd); d['Accept'] = 'application/json';
  return req('GET', 'https://' + host + '/api/videos/' + code + '/embed/details', d, null, null).then(function (r) {
    var o = null; try { o = JSON.parse(r.text); } catch (e) { o = null; }
    var frame = (o && (o.embed_frame_url || o.embedFrameUrl || o.embed_url)) || '';
    return { status: r.status, text: r.text, frame: frame };
  });
}

function fmParsePlayback(r) {
  var o = null; try { o = JSON.parse(r.text); } catch (e) { o = null; }
  var pb = o && o.playback;
  if (!pb || !pb.iv || !pb.payload || !pb.key_parts) return { err: r.status + ' ' + snip(r.text, 140) };
  var key = []; pb.key_parts.forEach(function (p) { key = key.concat(b64decode(p)); });
  var plain = null;
  try { plain = gcmDecryptCombined(key, b64decode(pb.iv), b64decode(pb.payload)); } catch (e2) { plain = null; }
  if (!plain) return { err: 'sifre cozulemedi' };
  var txt = utf8Decode(plain), j = null; try { j = JSON.parse(txt); } catch (e3) { j = null; }
  var src = j && j.sources && j.sources[0];
  var u2 = (src && (src.url || src.file)) || findM3u8(txt);
  return u2 ? { url: String(u2).replace(/\\\//g, '/') } : { err: 'kaynak yok ' + snip(txt, 80) };
}

function fmPlayback(host, code, hd) {
  var url = 'https://' + host + '/api/videos/' + code + '/embed/playback';
  return req('GET', url, hd, null, null).then(function (r) {
    var p = fmParsePlayback(r);
    if (p.url) return p;
    if ([400, 401, 405, 415, 422].indexOf(r.status) >= 0) {
      var hp = copyObj(hd); hp['Content-Type'] = 'application/json';
      var body = JSON.stringify({ fingerprint: { token: '', viewer_id: rndHex(32), device_id: rndHex(32), confidence: 0.5 } });
      return req('POST', url, hp, body, null).then(function (r2) {
        var p2 = fmParsePlayback(r2);
        return p2.url ? p2 : { err: 'GET ' + p.err + ' | POST ' + p2.err };
      });
    }
    return p;
  });
}

// Oynatıcı JS paketinden gerçek başlık adlarını bul (yöntem değiştiyse kendini uyarlar)
function discoverHeaders(u, host) {
  return req('GET', u, { 'User-Agent': UA, 'Referer': embedParent() }, null, 'FP').then(function (r) {
    var srcs = [], re = /<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi, m;
    while ((m = re.exec(r.text))) {
      var su = m[1];
      if (/^\/\//.test(su)) su = 'https:' + su; else if (/^\//.test(su)) su = 'https://' + host + su; else if (!/^https?:/i.test(su)) su = 'https://' + host + '/' + su;
      srcs.push(su);
    }
    srcs = uniq(srcs).slice(0, 3);
    return Promise.all(srcs.map(function (su) {
      return req('GET', su, { 'User-Agent': UA, 'Referer': u }, null, null, 9000).then(function (jr) { return jr.text; });
    })).then(function (texts) {
      var all = texts.join('\n'), names = [], re2 = /["'`](x-[a-z0-9\-]*(?:embed|parent|origin|referer|referrer|host|domain)[a-z0-9\-]*)["'`]/gi, m2;
      while ((m2 = re2.exec(all))) names.push(m2[1].toLowerCase());
      names = uniq(names);
      note('hdr ' + (names.join(',') || 'yok') + (/fingerprint/i.test(all) ? ' fp' : ''));
      if (!names.length) return null;
      var h = embedHeaderSets(u, host)[0];
      names.forEach(function (n) {
        var v = null;
        if (/parent|referer|referrer/.test(n)) v = embedParent();
        else if (/origin/.test(n)) v = AYAR.SITE;
        else if (/host|domain/.test(n)) v = siteHost();
        if (v) h[n] = v;
      });
      return h;
    });
  });
}

function fmViaPage(u, host) {
  return req('GET', u, { 'User-Agent': UA, 'Referer': embedParent() }, null, null).then(function (r) {
    var m = findM3u8(r.text);
    if (!m) { var un = unpack(r.text); if (un) m = findM3u8(un); }
    return m ? { url: m, host: host } : null;
  });
}

function resolveFilemoon(u) {
  var code = (u.match(/\/(?:e|d|embed)\/([A-Za-z0-9]+)/) || [])[1];
  var host = hostOf(u);
  var done = function (x) {
    if (!x) return null;
    var h = x.host || host;
    return { url: x.url, type: /\.m3u8/i.test(x.url) ? 'hls' : 'mp4',
      headers: { 'User-Agent': UA, 'Referer': 'https://' + h + '/', 'Origin': 'https://' + h } };
  };
  if (!code) return fmViaPage(u, host).then(done);

  var sets = embedHeaderSets(u, host), tried = 0, discovered = false;
  function seqHosts(hosts, i, hd, tag) {
    if (i >= hosts.length) return Promise.resolve(null);
    return fmPlayback(hosts[i], code, hd).then(function (p) {
      if (p.url) return { url: p.url, host: hosts[i] };
      note('pb ' + tag + ' ' + hosts[i].slice(0, 14) + ' ' + p.err);
      return seqHosts(hosts, i + 1, hd, tag);
    });
  }
  function next() {
    if (tried >= sets.length) {
      if (discovered) return Promise.resolve(null);
      discovered = true;
      return discoverHeaders(u, host).then(function (ex) {
        if (ex) sets.push(ex);
        return tried < sets.length ? next() : null;
      });
    }
    var hd = sets[tried], tag = 'v' + (tried + 1); tried++;
    return fmDetails(host, code, hd).then(function (d) {
      note('fd ' + tag + ' ' + d.status + (d.status === 200 ? '' : ' ' + snip(d.text, 130)));
      var hosts = [host];
      if (d.frame) { var fh = hostOf(absUrl(d.frame)); if (fh && fh !== host) hosts.push(fh); }
      return seqHosts(hosts, 0, hd, tag).then(function (x) { return x || next(); });
    });
  }
  return next().then(function (x) { return x || fmViaPage(u, host); }).then(done);
}

function peek(text, tag) {
  var t = String(text || '').replace(/\s+/g, ' ');
  var re = /(\$\.post|\$\.ajax|\$\.get|fetch\(|XMLHttpRequest|grecaptcha|sitekey|<iframe|atob\(|location\.|\.asp|https?:\/\/[^\s"'<>]+)/gi, m, last = -999, n = 0;
  while ((m = re.exec(t)) && n < 9) {
    if (m.index < last + 70) continue;
    last = m.index; n++;
    note(tag + n + ' ' + t.slice(Math.max(0, m.index - 15), m.index + 95));
  }
}
function strip(u) { return String(u || '').replace(/^https?:\/\//i, ''); }
function outLinks(text, selfHost) {
  var t = String(text || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  var re = /https?:\/\/[^"'\s<>\\)]+/gi, m, out = [];
  while ((m = re.exec(t))) {
    var h = hostOf(m[0]);
    if (/w3\.org|google|gstatic|facebook|twitter|schema\.org|cloudflare|jquery|bootstrap|fontawesome|jsdelivr|cdnjs|yandex|doubleclick/i.test(h)) continue;
    out.push(m[0]);
  }
  return uniq(out);
}
function findPlayable(text, pageUrl) {
  var t = String(text || '');
  var packed = unpack(t);
  var hay = [t, packed || ''];
  var host = hostOf(pageUrl);
  var i, m, hdrs = { 'User-Agent': UA, 'Referer': 'https://' + host + '/' };
  for (i = 0; i < hay.length; i++) {
    m = findM3u8(hay[i]);
    if (m) return { url: m, type: 'hls', headers: hdrs };
  }
  for (i = 0; i < hay.length; i++) {
    var tt = hay[i].replace(/\\\//g, '/').replace(/&amp;/g, '&');
    m = tt.match(/["'](https?:\/\/[^"'\s<>\\]+\.(?:mp4|mkv|webm)[^"'\s<>\\]*)["']/i);
    if (m) return { url: m[1], type: 'mp4', headers: hdrs };
    m = tt.match(/\bfile["']?\s*[:=]\s*["'](https?:\/\/[^"'\s<>\\]+)["']/i);
    if (m && !/\.(?:js|css|png|jpe?g|gif|svg|vtt|srt)(\?|$)/i.test(m[1]) && hostOf(m[1]) !== host) return { url: m[1], type: /\.m3u8/i.test(m[1]) ? 'hls' : 'mp4', headers: hdrs };
  }
  // atob("...") içinde saklanmış adresler
  var re = /atob\(\s*["']([A-Za-z0-9+\/=_\-]{16,})["']\s*\)/g;
  for (i = 0; i < hay.length; i++) {
    while ((m = re.exec(hay[i]))) {
      var dec = '';
      try { dec = utf8Decode(b64decode(m[1])); } catch (e) { dec = ''; }
      var mm = findM3u8(dec);
      if (mm) return { url: mm, type: 'hls', headers: hdrs };
    }
  }
  return null;
}
function resolveGeneric(u, depth) {
  return req('GET', u, { 'User-Agent': UA, 'Referer': (hostOf(u).indexOf('sezonlukdizi') >= 0 && CUR_PAGE) ? CUR_PAGE : AYAR.SITE + '/' }, null, 'GN').then(function (r) {
    var hit = findPlayable(r.text, u);
    if (hit) return hit;
    // iç içe iframe / yönlendirme
    var nxt = null;
    var ifr = r.text.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (ifr) nxt = ifr[1];
    if (!nxt) { var lo = r.text.match(/(?:location\.(?:href|replace)\s*[=(]\s*|content=["']\d+;\s*url=)["']?([^"'\s)<>]+)/i); if (lo) nxt = lo[1]; }
    if (nxt && depth < 3) {
      nxt = absUrl(nxt.replace(/&amp;/g, '&'));
      if (/^https?:\/\//i.test(nxt) && nxt !== u) { note('ic ' + strip(nxt).slice(0, 100)); return resolveEmbed(nxt, depth + 1); }
    }
    note('desteklenmeyen ' + strip(u).slice(0, 100));
    return null;
  });
}
function resolveEmbed(u, depth) {
  depth = depth || 0;
  u = absUrl(u);
  if (/\.m3u8(\?|$)/i.test(u)) return Promise.resolve({ url: u, type: 'hls', headers: { 'User-Agent': UA } });
  if (/\.(mp4|mkv|webm)(\?|$)/i.test(u)) return Promise.resolve({ url: u, type: 'mp4', headers: { 'User-Agent': UA } });
  if (/pixeldrain\./i.test(u)) return resolvePixeldrain(u);
  if (/vidmoly\./i.test(u)) return resolveVidmoly(u);
  if (/filemoon|moonplayer|bysezoxexe|bysekoze|f16px|fmoon|kerapoxy|\/e\/[a-z0-9]+$/i.test(u)) return resolveFilemoon(u);
  return resolveGeneric(u, depth);
}

// ---------------- Site: bölüm sayfası bulma ----------------
function getBid(html) {
  var m = String(html).match(/<div[^>]*id=["']dilsec["'][^>]*>/i);
  if (!m) return null;
  var d = m[0].match(/data-id=["'](\d+)["']/i);
  return d ? d[1] : null;
}
function tryEpisode(slug, season, episode) {
  var url = AYAR.SITE + '/' + slug + '/' + season + '-sezon-' + episode + '-bolum.html';
  return req('GET', url, { 'User-Agent': UA }, null, 'E').then(function (r) {
    var bid = r.status === 200 ? getBid(r.text) : null;
    return bid ? { url: url, bid: bid, html: r.text } : null;
  });
}
function searchSlugs(title, titles) {
  var q = encodeURIComponent(title);
  return req('GET', AYAR.SITE + '/diziler.asp?adi=' + q, { 'User-Agent': UA }, null, 'S').then(function (r) {
    var re = /href=["']\/diziler\/([a-z0-9\-]+)\.html["']/gi, m, slugs = [];
    while ((m = re.exec(r.text))) slugs.push(m[1]);
    slugs = uniq(slugs);
    var want = titles.map(norm).filter(Boolean);
    var exact = slugs.filter(function (s) { return want.indexOf(norm(s)) >= 0; });
    var part = slugs.filter(function (s) { return exact.indexOf(s) < 0 && want.some(function (w) { return w.length > 3 && (norm(s).indexOf(w) >= 0 || w.indexOf(norm(s)) >= 0); }); });
    note('ara ' + slugs.length + ' ' + exact.length + '/' + part.length);
    return exact.concat(part).slice(0, 3);
  });
}
function findEpisode(titles, season, episode) {
  var slugs = uniq(titles.map(slugify)).slice(0, 3);
  function seq(list, i) {
    if (i >= list.length) return Promise.resolve(null);
    return tryEpisode(list[i], season, episode).then(function (r) { return r || seq(list, i + 1); });
  }
  return seq(slugs, 0).then(function (r) {
    if (r) return r;
    return searchSlugs(titles[0], titles).then(function (found) {
      found = found.filter(function (s) { return slugs.indexOf(s) < 0; });
      return seq(found, 0);
    });
  });
}

// ---------------- Site: alternatifler ve gömme adresleri ----------------
function ajaxPost(path, pairs, referer, label) {
  return req('POST', AYAR.SITE + path, {
    'User-Agent': UA, 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Referer': referer, 'Origin': AYAR.SITE
  }, formEnc(pairs), label);
}
function parseAlt(text) {
  var out = [], o;
  try {
    o = JSON.parse(text);
    var arr = Array.isArray(o) ? o : (o.data || o.veri || []);
    if (Array.isArray(arr)) arr.forEach(function (a) { if (a && a.id !== undefined) out.push({ id: String(a.id), ad: String(a.baslik || a.name || a.isim || '') }); });
  } catch (e) {
    var re = /"id"\s*:\s*"?(\d+)"?[^}]*?"baslik"\s*:\s*"([^"]*)"/g, m;
    while ((m = re.exec(String(text)))) out.push({ id: m[1], ad: m[2] });
  }
  return out;
}
function iframesOf(text) {
  var t = String(text || '').replace(/\\\//g, '/').replace(/\\"/g, '"');
  var re = /<iframe[^>]+?(?:data-src|src)=["']([^"']+)["']/gi, m, out = [];
  while ((m = re.exec(t))) out.push(absUrl(m[1].replace(/&amp;/g, '&')));
  if (!out.length) { var mm = t.match(/(https?:\/\/[^"'\s<>]+)/i); if (mm) out.push(absUrl(mm[1])); }
  return out;
}
function tryCaptchaPage(cu, pageUrl) {
  return req('GET', cu, { 'User-Agent': UA, 'Referer': pageUrl, 'Accept': 'text/html,*/*' }, null, 'CP').then(function (r) {
    var hit = findPlayable(r.text, cu);
    if (hit) return hit;
    var cand = outLinks(r.text).filter(function (x) { return /pixeldrain|vidmoly|filemoon|bysejikuar|bysezoxexe|bysekoze/i.test(hostOf(x)); });
    var ifr = iframeOf(r.text);
    if (ifr) cand.unshift(ifr);
    if (cand.length) return resolveEmbed(cand[0]);
    if (!CAP_PEEKED) { CAP_PEEKED = true; peek(r.text, 'cp'); }
    note('  atlandi: insan dogrulamasi (Turnstile) arkasinda');
    return null;
  });
}
function isCaptcha(u) { return /recaptcha|captcha/i.test(String(u)); }
function iframeOf(text) {
  var good = iframesOf(text).filter(function (x) { return !isCaptcha(x); });
  return good.length ? good[0] : null;
}
function snip(t, n) { return String(t || '').replace(/\s+/g, ' ').slice(0, n || 90); }

// Sayfadaki (ve sayfanın .js dosyalarındaki) ajax adreslerini bul
function ajaxPathsIn(text) {
  var out = [], re = /["'`(=]\s*(\/?ajax\/[A-Za-z0-9_\-]+(?:\.[A-Za-z]{2,5})?)/gi, m, p;
  var t = String(text || '');
  while ((m = re.exec(t))) { p = m[1]; if (p.charAt(0) !== '/') p = '/' + p; out.push(p); }
  return uniq(out);
}
function scriptSrcs(html) {
  var out = [], re = /<script[^>]+src=["']([^"']+)["']/gi, m, u;
  while ((m = re.exec(String(html || '')))) {
    u = m[1].replace(/&amp;/g, '&');
    if (/^\/\//.test(u)) u = 'https:' + u;
    else if (/^\//.test(u)) u = AYAR.SITE + u;
    else if (!/^https?:/i.test(u)) u = AYAR.SITE + '/' + u;
    if (hostOf(u).indexOf('sezonlukdizi') >= 0 && /\.js(\?|$)/i.test(u)) out.push(u);
  }
  return uniq(out).slice(0, 5);
}
function discoverAjax(html) {
  var found = ajaxPathsIn(html);
  var srcs = scriptSrcs(html);
  note('js ' + srcs.length + ' iframe ' + ((String(html).match(/<iframe/gi) || []).length));
  return Promise.all(srcs.map(function (u) {
    return req('GET', u, { 'User-Agent': UA, 'Referer': AYAR.SITE + '/' }, null, null, 8000).then(function (r) { return ajaxPathsIn(r.text); });
  })).then(function (lists) {
    lists.forEach(function (l) { found = found.concat(l); });
    return uniq(found);
  });
}
function withExt(p) { return /\.[A-Za-z]{2,5}$/.test(p) ? [p] : [p, p + '.asp']; }
function altCandidates(found) {
  var fromPage = [];
  found.filter(function (p) { return /alternatif/i.test(p); }).forEach(function (p) { fromPage = fromPage.concat(withExt(p)); });
  var guess = ['3', '4', '5', '2', '6', '7', '8', ''].map(function (x) { return '/ajax/dataAlternatif' + x + '.asp'; });
  return uniq(fromPage.concat(guess));
}
function embedCandidates(altPath, found) {
  var fromPage = [];
  found.filter(function (p) { return /embed/i.test(p); }).forEach(function (p) { fromPage = fromPage.concat(withExt(p)); });
  var derived = altPath ? [String(altPath).replace(/alternatif/i, 'Embed')] : [];
  return uniq(fromPage.concat(derived, ['/ajax/dataEmbed.asp']));
}
// Adayları sırayla dener; 404 olmayan ilk adresi "path" olarak hatırlar
function probeAlt(bid, dil, pageUrl, cands) {
  var okPath = null;
  function step(i) {
    if (i >= cands.length) return Promise.resolve({ alts: [], path: okPath });
    var path = cands[i];
    return ajaxPost(path, [['bid', bid], ['dil', dil]], pageUrl, path.replace('/ajax/', '').replace('.asp', '') + ' d' + dil).then(function (r) {
      if (r.status === 404 || r.status === 0) return step(i + 1);
      if (!okPath) okPath = path;
      var alts = parseAlt(r.text);
      if (alts.length) return { alts: alts, path: path };
      note('yanit ' + snip(r.text, 80));
      return step(i + 1);
    });
  }
  return step(0);
}
function embedFetch(id, altPath, pageUrl, found) {
  var paths = embedCandidates(altPath, found);
  var cap = null;
  function step(i, lastText) {
    if (i >= paths.length) return Promise.resolve({ iu: cap, text: lastText });
    return ajaxPost(paths[i], [['id', id]], pageUrl).then(function (er) {
      if (er.status === 404) return step(i + 1, lastText);
      var iu = iframeOf(er.text);
      if (iu) return { iu: iu, text: er.text };
      if (!cap) { var c = iframesOf(er.text).filter(isCaptcha)[0]; if (c) cap = c; }
      return step(i + 1, er.text);
    });
  }
  return step(0, '');
}
function streamsFromProbe(pr, dil, pageUrl, found) {
  var etiket = dil === 0 ? 'Türkçe Dublaj' : 'Altyazı';
  var alts = pr.alts.slice(0, AYAR.MAKS_ALTERNATIF);
  note('dil' + dil + ' alt ' + alts.length + (pr.path ? ' ' + pr.path.replace('/ajax/', '') : ''));
  return Promise.all(alts.map(function (a) {
    return embedFetch(a.id, pr.path, pageUrl, found).then(function (er) {
      if (!er.iu) { note('embed yok ' + a.ad + ' ' + snip(er.text, 50)); return null; }
      note('emb ' + snip(a.ad, 14) + ' ' + strip(er.iu).slice(0, 80));
      var job = isCaptcha(er.iu) ? tryCaptchaPage(er.iu, pageUrl) : resolveEmbed(er.iu);
      return job.catch(function () { return null; }).then(function (res) {
        if (!res) return null;
        var item = { ad: a.ad, etiket: etiket, dil: dil, r: res };
        PART.push(item);
        return item;
      });
    });
  }));
}

// ---------------- Ana akış ----------------
function buildStreams(all) {
  var seen = {};
  all = all.filter(function (x) { if (seen[x.r.url]) return false; seen[x.r.url] = 1; return true; });
  all.sort(function (a, b) { return a.dil - b.dil; }); // dublaj önce
  return all.slice(0, AYAR.MAKS_AKIS).map(function (x) {
    var q = qualityOf(x.r.url);
    return {
      name: AYAR.EKLENTI_ADI + ' - ' + x.ad + ' (' + x.etiket + ')',
      title: AYAR.EKLENTI_ADI + ' | ' + x.etiket + ' | ' + x.ad + (q !== 'Auto' ? ' | ' + q : ''),
      url: x.r.url, quality: q, headers: x.r.headers, type: x.r.type, provider: PROVIDER_ID
    };
  });
}

function getStreamsInner(tmdbId, mediaType, season, episode, holder) {
  dbg = ['v1.1.0']; PART = []; CAP_PEEKED = false;
  if (mediaType !== 'tv' && mediaType !== 'series') return Promise.resolve(debugStream('sadece dizi destekleniyor'));
  season = parseInt(season, 10) || 1; episode = parseInt(episode, 10) || 1;
  var base = 'https://api.themoviedb.org/3/tv/' + tmdbId + '?api_key=' + TMDB_KEY;
  return Promise.all([getJson(base + '&language=en-US'), getJson(base + '&language=tr-TR').catch(function () { return {}; })]).then(function (both) {
    var en = both[0] || {}, tr = both[1] || {};
    var titles = uniq([en.name, en.original_name, tr.name]);
    if (!titles.length) return debugStream('TMDB bilgisi eksik');
    note('dizi ' + titles[0] + ' ' + season + 'x' + episode);
    return findEpisode(titles, season, episode).then(function (ep) {
      if (!ep) return debugStream('bolum sayfasi bulunamadi');
      note('bid ' + ep.bid);
      CUR_PAGE = ep.url;
      return discoverAjax(ep.html).then(function (found) {
        found.slice(0, 6).forEach(function (p) { note('ajax ' + p); });
        var cands = altCandidates(found);
        return probeAlt(ep.bid, 0, ep.url, cands).then(function (p0) {
          var c1 = p0.path ? [p0.path] : cands;
          return Promise.all([
            streamsFromProbe(p0, 0, ep.url, found),
            probeAlt(ep.bid, 1, ep.url, c1).then(function (p1) { return streamsFromProbe(p1, 1, ep.url, found); })
          ]);
        });
      }).then(function (lists) {
        var all = [];
        lists.forEach(function (l) { l.forEach(function (x) { if (x) all.push(x); }); });
        holder.streams = buildStreams(all);
        return holder.streams.length ? holder.streams : debugStream('kaynak cikmadi');
      });
    });
  }).catch(function (e) { return holder.streams.length ? holder.streams : debugStream('hata ' + (e && e.message)); });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return new Promise(function (resolve) {
    var done = false, holder = { streams: [] };
    var timer = setTimeout(function () {
      if (!done) { done = true; var part = buildStreams(PART.slice()); resolve(part.length ? part : debugStream('zaman asimi')); }
    }, AYAR.GENEL_SURE);
    getStreamsInner(tmdbId, mediaType, season, episode, holder).then(function (r) {
      if (!done) { done = true; clearTimeout(timer); resolve(r || []); }
    }, function () {
      if (!done) { done = true; clearTimeout(timer); resolve(holder.streams); }
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
