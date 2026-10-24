// SezonlukDizi - Nuvio scraper (sadece dizi)
// CloudStream SezonlukDizi.kt eklentisinin Nuvio karşılığı. Promise zincirleri kullanır (async/await yok).
// Akış: TMDB id -> başlık -> site araması -> bölüm sayfaları (altyazı + /dublaj/)
//       -> ajax kaynak listeleri (dataAlternatif / dataEmbed) -> Byse (AES-GCM) / Vidmoly / genel m3u8
// Not: CloudflareKiller ve WebView (Turnstile kapısı) JS tarafında yok; o kısımlar atlanır.

// TMDB anahtarı (SezonlukDizi.kt dosyandaki anahtar). Başka bir anahtar kullanacaksan değiştir.
var TMDB_KEY = '000316508321ce461cf81e7c6815eec7';

var BASE = 'https://sezonlukdizi.cc';
var LISTE = '/diziler.asp';

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

var DEBUG = false;

// Hız sınırında (Cloudflare 1015) beklemek için toplam süre bütçesi (ms)
var WAIT_BUDGET = 12000;

var jars = {}; // host -> { çerez adı: değer }
var altEndpoints = null;
var embedEndpoints = null;
var goodKeys = {}; // daha önce çalışan kaynaklar: sonraki bölümlerde öne alınır

function log() {
    if (DEBUG && typeof console !== 'undefined') {
        console.log.apply(console, ['[SezonlukDizi]'].concat([].slice.call(arguments)));
    }
}

// ------------------------------------------------------------------
// Genel yardımcılar
// ------------------------------------------------------------------
function hostOf(u) {
    var m = /^https?:\/\/([^\/?#]+)/i.exec(u || '');
    return m ? m[1].toLowerCase() : '';
}

function originOf(u) {
    var m = /^(https?:\/\/[^\/]+)/i.exec(u || '');
    return m ? m[1] : BASE;
}

function resolveUrl(base, ref) {
    if (!ref) return base;
    if (/^https?:\/\//i.test(ref)) return ref;
    if (ref.indexOf('//') === 0) return 'https:' + ref;
    var o = originOf(base);
    if (ref.charAt(0) === '/') return o + ref;
    var dir = base.replace(/[?#].*$/, '');
    dir = dir.substring(0, dir.lastIndexOf('/') + 1);
    return dir + ref;
}

function absUrl(u) {
    if (/^https?:\/\//i.test(u)) return u;
    if (u.indexOf('//') === 0) return 'https:' + u;
    if (u.charAt(0) === '/') return BASE + u;
    return BASE + '/' + u;
}

function decodeEntities(s) {
    return String(s)
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function stripTags(s) {
    return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attrOf(tag, name) {
    var m = new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(tag);
    return m ? decodeEntities(m[1]) : '';
}

function seq(arr, fn) {
    var out = [];
    var p = Promise.resolve();
    arr.forEach(function (x, i) {
        p = p.then(function () {
            return fn(x, i);
        }).then(function (r) {
            out.push(r);
        });
    });
    return p.then(function () {
        return out;
    });
}

function sleep(ms) {
    return new Promise(function (r) {
        setTimeout(r, ms);
    });
}

function formBody(o) {
    var a = [];
    for (var k in o) a.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k]));
    return a.join('&');
}

// ------------------------------------------------------------------
// HTTP + çerez deposu
// ------------------------------------------------------------------
function cookieHeader(host) {
    var j = jars[host];
    if (!j) return '';
    var a = [];
    for (var k in j) a.push(k + '=' + j[k]);
    return a.join('; ');
}

function storeCookies(host, sc) {
    if (!sc) return;
    var j = jars[host] || (jars[host] = {});
    String(sc).split(/,(?=\s*[^;,=\s]+=)/).forEach(function (c) {
        var m = /^\s*([^=;\s]+)=([^;]*)/.exec(c);
        if (m) j[m[1]] = m[2];
    });
}

function http(method, url, opt) {
    opt = opt || {};
    var h = {};
    var src = opt.headers || {};
    for (var k in src) h[k] = src[k];
    if (!h['User-Agent']) h['User-Agent'] = UA;
    var host = hostOf(url);
    var ck = cookieHeader(host);
    if (ck && !h['Cookie']) h['Cookie'] = ck;
    var init = { method: method, headers: h };
    if (opt.body != null) init.body = opt.body;
    return new Promise(function (resolve) {
        var done = false;
        var t = setTimeout(function () {
            if (!done) {
                done = true;
                resolve(null);
            }
        }, opt.timeout || 15000);
        var fin = function (v) {
            if (!done) {
                done = true;
                clearTimeout(t);
                resolve(v);
            }
        };
        try {
            fetch(url, init).then(function (res) {
                var sc = null;
                try {
                    sc = res.headers.get('set-cookie');
                } catch (e) {}
                return res.text().then(function (text) {
                    storeCookies(host, sc);
                    fin({ status: res.status, text: text, url: url });
                });
            }).catch(function () {
                fin(null);
            });
        } catch (e) {
            fin(null);
        }
    });
}

function getText(url, headers) {
    return http('GET', url, { headers: headers || {} }).then(function (r) {
        return r ? r.text : '';
    });
}

// Cloudflare kontrol sayfası mı?
function isChallenge(code, body) {
    body = body || '';
    return code === 403 || code === 503 ||
        /<title>Just a moment/i.test(body) ||
        /cf-browser-verification/i.test(body) ||
        body.indexOf('/cdn-cgi/challenge-platform/h/b/orchestrate') >= 0;
}

function siteGet(url, referer, timeout) {
    return http('GET', url, {
        headers: { 'User-Agent': UA, Referer: referer || (BASE + '/') },
        timeout: timeout || 15000
    });
}

function sitePost(url, form, referer) {
    return http('POST', url, {
        headers: {
            'User-Agent': UA,
            'X-Requested-With': 'XMLHttpRequest',
            Referer: referer,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Accept: '*/*'
        },
        body: formBody(form)
    });
}

// ------------------------------------------------------------------
// Base64 / UTF-8 / AES (şifre çözme + GCM için şifreleme bloğu)
// ------------------------------------------------------------------
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64bin(s) {
    var c = String(s).trim().replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
    var out = [];
    var buf = 0;
    var bits = 0;
    for (var i = 0; i < c.length; i++) {
        buf = (buf << 6) | B64.indexOf(c.charAt(i));
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buf >> bits) & 255);
            buf &= (1 << bits) - 1;
        }
    }
    return out;
}

function latin1(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 255);
    return s;
}

function utf8Decode(bytes) {
    var s = '';
    var i = 0;
    while (i < bytes.length) {
        var b = bytes[i++];
        if (b < 128) {
            s += String.fromCharCode(b);
        } else if (b >= 192 && b < 224) {
            s += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
        } else if (b >= 224 && b < 240) {
            s += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
        } else {
            var cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
            cp -= 0x10000;
            s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
        }
    }
    return s;
}

var SBOX = new Array(256);
(function () {
    function rotl8(x, s) {
        return ((x << s) | (x >> (8 - s))) & 255;
    }
    var p = 1;
    var q = 1;
    do {
        p = (p ^ (p << 1) ^ ((p & 0x80) ? 0x1B : 0)) & 255;
        q = (q ^ (q << 1)) & 255;
        q = (q ^ (q << 2)) & 255;
        q = (q ^ (q << 4)) & 255;
        if (q & 0x80) q ^= 0x09;
        var x = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4);
        SBOX[p] = (x ^ 0x63) & 255;
    } while (p !== 1);
    SBOX[0] = 0x63;
})();

function gmul(a, b) {
    var p = 0;
    for (var i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        var hi = a & 0x80;
        a = (a << 1) & 255;
        if (hi) a ^= 0x1B;
        b >>= 1;
    }
    return p;
}

var MUL2 = new Array(256);
var MUL3 = new Array(256);
(function () {
    for (var i = 0; i < 256; i++) {
        MUL2[i] = gmul(i, 2);
        MUL3[i] = gmul(i, 3);
    }
})();

function aesExpand(key) {
    var Nk = key.length / 4;
    var Nr = Nk + 6;
    var w = [];
    var i;
    for (i = 0; i < Nk; i++) w[i] = [key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]];
    var rcon = 1;
    for (i = Nk; i < 4 * (Nr + 1); i++) {
        var t = w[i - 1].slice();
        if (i % Nk === 0) {
            t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
            rcon = ((rcon << 1) ^ ((rcon & 0x80) ? 0x1B : 0)) & 255;
        } else if (Nk > 6 && i % Nk === 4) {
            t = [SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]];
        }
        w[i] = [w[i - Nk][0] ^ t[0], w[i - Nk][1] ^ t[1], w[i - Nk][2] ^ t[2], w[i - Nk][3] ^ t[3]];
    }
    return { w: w, Nr: Nr };
}

function aesEncBlock(ks, blk) {
    var s = blk.slice();
    var w = ks.w;
    var r;
    var c;
    var i;
    function addKey(round) {
        for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) s[4 * c + r] ^= w[4 * round + c][r];
    }
    function subShift() {
        var t = s.slice();
        for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) s[4 * c + r] = SBOX[t[4 * ((c + r) % 4) + r]];
    }
    function mix() {
        for (c = 0; c < 4; c++) {
            var a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
            s[4 * c] = MUL2[a0] ^ MUL3[a1] ^ a2 ^ a3;
            s[4 * c + 1] = a0 ^ MUL2[a1] ^ MUL3[a2] ^ a3;
            s[4 * c + 2] = a0 ^ a1 ^ MUL2[a2] ^ MUL3[a3];
            s[4 * c + 3] = MUL3[a0] ^ a1 ^ a2 ^ MUL2[a3];
        }
    }
    addKey(0);
    for (var round = 1; round < ks.Nr; round++) {
        subShift();
        mix();
        addKey(round);
    }
    subShift();
    addKey(ks.Nr);
    return s;
}

// GF(2^128) çarpımı (GHASH için); sadece IV 12 bayttan farklıysa gerekir
function gfMul(X, Y) {
    var Z = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var V = Y.slice();
    for (var i = 0; i < 128; i++) {
        if ((X[i >> 3] >> (7 - (i & 7))) & 1) for (var j = 0; j < 16; j++) Z[j] ^= V[j];
        var lsb = V[15] & 1;
        for (var k = 15; k > 0; k--) V[k] = ((V[k] >> 1) | ((V[k - 1] & 1) << 7)) & 255;
        V[0] = V[0] >> 1;
        if (lsb) V[0] ^= 0xE1;
    }
    return Z;
}

function ghash(H, data) {
    var Y = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (var off = 0; off < data.length; off += 16) {
        var blk = data.slice(off, off + 16);
        while (blk.length < 16) blk.push(0);
        for (var i = 0; i < 16; i++) Y[i] ^= blk[i];
        Y = gfMul(Y, H);
    }
    return Y;
}

function inc32(cb) {
    var o = cb.slice();
    for (var i = 15; i >= 12; i--) {
        o[i] = (o[i] + 1) & 255;
        if (o[i] !== 0) break;
    }
    return o;
}

// AES-GCM çözme (etiket doğrulanmaz; çağıran JSON geçerliliğiyle anahtarı doğrular).
// data = şifreli metin + 16 bayt etiket. onlyFirst: sadece ilk blok (hızlı ön kontrol).
function gcmDecrypt(key, iv, data, onlyFirst) {
    if (key.length !== 16 && key.length !== 24 && key.length !== 32) return null;
    if (data.length < 17 || !iv.length) return null;
    var ct = data.slice(0, data.length - 16);
    var ks = aesExpand(key);
    var j0;
    if (iv.length === 12) {
        j0 = iv.concat([0, 0, 0, 1]);
    } else {
        var H = aesEncBlock(ks, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        var padded = iv.slice();
        while (padded.length % 16 !== 0) padded.push(0);
        var lenBlock = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        var bits = iv.length * 8;
        lenBlock[12] = (bits >>> 24) & 255;
        lenBlock[13] = (bits >>> 16) & 255;
        lenBlock[14] = (bits >>> 8) & 255;
        lenBlock[15] = bits & 255;
        j0 = ghash(H, padded.concat(lenBlock));
    }
    var ctr = inc32(j0);
    var out = [];
    var limit = onlyFirst ? Math.min(16, ct.length) : ct.length;
    for (var off = 0; off < limit; off += 16) {
        var ksb = aesEncBlock(ks, ctr);
        for (var i = 0; i < 16 && off + i < limit; i++) out.push(ct[off + i] ^ ksb[i]);
        ctr = inc32(ctr);
    }
    return out;
}

// ------------------------------------------------------------------
// Packer (Filemoon vb. için) ve m3u8 / mp4 tarama
// ------------------------------------------------------------------
function unpackAll(text) {
    var out = [];
    var re = /\}\('((?:\\.|[^'\\])*)',\s*(\d+),\s*(\d+),\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/g;
    var m;
    while ((m = re.exec(text))) {
        try {
            var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
            var a = parseInt(m[2], 10);
            var c = parseInt(m[3], 10);
            var k = m[4].split('|');
            var enc = function (n) {
                var hi = n < a ? '' : enc(Math.floor(n / a));
                var r = n % a;
                return hi + (r > 35 ? String.fromCharCode(r + 29) : r.toString(36));
            };
            while (c-- > 0) {
                if (c < k.length && k[c]) {
                    var word = k[c];
                    var e = enc(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    p = p.replace(new RegExp('\\b' + e + '\\b', 'g'), function () {
                        return word;
                    });
                }
            }
            out.push(p);
        } catch (e) {}
    }
    return out;
}

function findM3u8(text) {
    var t = String(text).replace(/\\\//g, '/');
    var m = /https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/.exec(t);
    return m ? m[0].replace(/&amp;/g, '&') : null;
}

// ------------------------------------------------------------------
// Başlık eşleme
// ------------------------------------------------------------------
function normTitle(s) {
    return String(s || '')
        .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
        .toLowerCase()
        .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
        .replace(/[^a-z0-9]+/g, '');
}

// Site windows-1254 kullanıyor; Türkçe harfli aramalar için aynı kodlama
var W1254 = { 'ç': 'E7', 'Ç': 'C7', 'ğ': 'F0', 'Ğ': 'D0', 'ı': 'FD', 'İ': 'DD', 'ö': 'F6', 'Ö': 'D6', 'ş': 'FE', 'Ş': 'DE', 'ü': 'FC', 'Ü': 'DC' };

function encQ1254(q) {
    var out = '';
    for (var i = 0; i < q.length; i++) {
        var ch = q.charAt(i);
        if (W1254[ch]) out += '%' + W1254[ch];
        else out += encodeURIComponent(ch).replace(/%20/g, '%20');
    }
    return out;
}

function cleanTitle(t) {
    return String(t || '')
        .replace(/\s*(izle)?\s*[-|–]\s*Sezonluk\s*Dizi.*$/i, '')
        .replace(/\s+izle$/i, '')
        .trim();
}

var reSeries = /^(?:https?:\/\/sezonlukdizi\.[a-z]+)?(\/diziler\/[^\/?#]+\.html)$/;
var reEp = /^(?:https?:\/\/sezonlukdizi\.[a-z]+)?\/([a-z0-9-]+)\/(?:dublaj\/)?(\d+)-sezon-(\d+)-bolum\.html/;

function slugOf(path) {
    var m = /\/diziler\/([^\/?#]+)\.html/.exec(path);
    return m ? m[1].replace(/-izle$/, '') : '';
}

// Sayfadaki dizi kartları: [{ path: '/diziler/x.html', title }]
function parseCards(html) {
    var out = [];
    var seen = {};
    var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html))) {
        var tag = m[1];
        var inner = m[2];
        if (!/<img\b/i.test(inner)) continue;
        var href = attrOf(tag, 'href').trim();
        if (!href) continue;
        var path;
        var key;
        var sm = reSeries.exec(href);
        var em = reEp.exec(href);
        if (sm) {
            path = sm[1];
            key = 's:' + slugOf(path);
        } else if (em) {
            path = '/diziler/' + em[1] + '.html';
            key = 's:' + em[1];
        } else continue;
        if (seen[key]) continue;
        var title = '';
        var tm = /class=["'][^"']*\b(?:title|description)\b[^"']*["'][^>]*>([^<]+)/i.exec(inner);
        if (tm) title = stripTags(tm[1]);
        if (!title) title = cleanTitle(attrOf(tag, 'title'));
        if (!title) {
            var im = /<img\b[^>]*\balt=["']([^"']+)["']/i.exec(inner);
            if (im) title = decodeEntities(im[1]).trim();
        }
        if (!title) continue;
        seen[key] = 1;
        out.push({ path: path, title: title });
    }
    return out;
}

// ------------------------------------------------------------------
// TMDB -> başlık -> dizi sayfası -> bölüm adresi
// ------------------------------------------------------------------
function tmdbTitles(tmdbId) {
    if (!TMDB_KEY || TMDB_KEY.indexOf('BURAYA') === 0) return Promise.resolve(null);
    var url = 'https://api.themoviedb.org/3/tv/' + tmdbId + '?api_key=' + TMDB_KEY + '&language=tr-TR';
    return getText(url, { Accept: 'application/json' }).then(function (t) {
        try {
            var o = JSON.parse(t);
            var out = [];
            if (o.name) out.push(o.name);
            if (o.original_name && out.indexOf(o.original_name) < 0) out.push(o.original_name);
            return out.length ? out : null;
        } catch (e) {
            return null;
        }
    });
}

function findSeries(titles) {
    var nt = titles.map(normTitle);
    function tryTitle(i) {
        if (i >= titles.length) return Promise.resolve(null);
        var q = titles[i].trim();
        if (q.length < 2) return tryTitle(i + 1);
        var urls = [BASE + LISTE + '?adi=' + encQ1254(q), BASE + LISTE + '?adi=' + encodeURIComponent(q)];
        if (urls[0] === urls[1]) urls = [urls[0]];
        function tryUrl(j) {
            if (j >= urls.length) return Promise.resolve(null);
            return siteGet(urls[j], BASE + '/', 10000).then(function (r) {
                if (!r || r.status < 200 || r.status > 299 || isChallenge(r.status, r.text)) return tryUrl(j + 1);
                var cards = parseCards(r.text);
                if (!cards.length) return tryUrl(j + 1);
                var exact = cards.filter(function (c) {
                    return nt.indexOf(normTitle(c.title)) >= 0;
                })[0];
                if (exact) return exact.path;
                var near = cards.filter(function (c) {
                    var n = normTitle(c.title);
                    return nt.some(function (x) {
                        return x && n && (n.indexOf(x) >= 0 || x.indexOf(n) >= 0);
                    });
                })[0];
                return near ? near.path : tryUrl(j + 1);
            });
        }
        return tryUrl(0).then(function (p) {
            return p || tryTitle(i + 1);
        });
    }
    return tryTitle(0);
}

// Dizi sayfasındaki bölüm bağlantılarından bölüm adresindeki dizi adını (slug) bulur
function episodeSlugs(seriesPath) {
    return siteGet(BASE + seriesPath, BASE + '/').then(function (r) {
        var out = [];
        if (r && r.status >= 200 && r.status < 300 && !isChallenge(r.status, r.text)) {
            var re = /href=["']([^"']+)["']/gi;
            var m;
            while ((m = re.exec(r.text))) {
                var em = reEp.exec(m[1].trim());
                if (em && out.indexOf(em[1]) < 0) out.push(em[1]);
            }
        }
        var hint = slugOf(seriesPath);
        if (hint && out.indexOf(hint) < 0) out.push(hint);
        return out.slice(0, 3);
    });
}

// ------------------------------------------------------------------
// Sayfa ayrıştırma: dil seçici, oynatıcı iframe'leri, ajax uçları
// ------------------------------------------------------------------
function pageBid(html) {
    var m = /<[^>]*\bid=["']dilsec["'][^>]*>/i.exec(html);
    return m ? attrOf(m[0], 'data-id') : '';
}

function pageActiveDil(html, pageUrl) {
    var idx = html.search(/\bid=["']dilsec["']/i);
    if (idx >= 0) {
        var rest = html.slice(idx, idx + 4000);
        var re = /<[^>]*\bclass=["'][^"']*["'][^>]*>/gi;
        var m;
        while ((m = re.exec(rest))) {
            var cls = attrOf(m[0], 'class');
            if (/\bitem\b/.test(cls) && /\bactive\b/.test(cls)) {
                var d = attrOf(m[0], 'data-dil');
                if (d === '0' || d === '1') return d;
            }
        }
    }
    return pageUrl.indexOf('/dublaj/') >= 0 ? '0' : '1';
}

function pageEmbeds(html) {
    var out = [];
    function add(u) {
        u = (u || '').trim();
        if (u && out.indexOf(u) < 0) out.push(u);
    }
    var tags = [];
    var re = /<iframe\b[^>]*>/gi;
    var m;
    while ((m = re.exec(html))) tags.push({ tag: m[0], pos: m.index });
    var embedPos = html.search(/\bid=["']embed["']/i);
    tags.forEach(function (t) {
        var isHs = /\bid=["']hs["']/i.test(t.tag);
        var inEmbed = embedPos >= 0 && t.pos > embedPos && t.pos < embedPos + 3000;
        if (isHs || inEmbed) {
            add(attrOf(t.tag, 'src'));
            add(attrOf(t.tag, 'data-src'));
        }
    });
    var real = out.filter(function (u) {
        return !/reCAPTCHA/i.test(u);
    });
    if (!real.length) {
        var t2 = html.replace(/\\\//g, '/');
        var br = /(?:https?:)?\/\/[^"'\\\s<>]*byse[^"'\\\s<>]*\/e\/[^"'\\\s<>]+/gi;
        var bm;
        while ((bm = br.exec(t2))) add(bm[0]);
        tags.forEach(function (t) {
            var u = attrOf(t.tag, 'src') || attrOf(t.tag, 'data-src');
            if (!u || u.indexOf('about:') === 0) return;
            if (/google|facebook|youtube|doubleclick|histats/i.test(u)) return;
            add(u);
        });
    }
    return out.slice(0, 3);
}

// Sitenin ajax servis adları zamanla değişiyor (dataAlternatif3, dataAlternatif22 ...)
function discoverEndpoints(html) {
    if (altEndpoints && embedEndpoints) return Promise.resolve();
    var srcs = [];
    var re = /<script\b[^>]*\bsrc=["']([^"']+)["']/gi;
    var m;
    while ((m = re.exec(html))) if (m[1].indexOf('site') >= 0) srcs.push(absUrl(decodeEntities(m[1])));
    srcs = srcs.slice(0, 3);
    return seq(srcs, function (u) {
        return siteGet(u, BASE + '/').then(function (r) {
            return r ? r.text : '';
        });
    }).then(function (texts) {
        var all = html + '\n' + texts.join('\n');
        function uniq(rx) {
            var o = [];
            var mm;
            while ((mm = rx.exec(all))) if (o.indexOf(mm[0]) < 0) o.push(mm[0]);
            return o;
        }
        altEndpoints = uniq(/\/ajax\/dataAlternatif\w*\.asp/g);
        if (!altEndpoints.length) altEndpoints = ['/ajax/dataAlternatif3.asp'];
        embedEndpoints = uniq(/\/ajax\/dataEmbed\w*\.asp/g);
        if (!embedEndpoints.length) embedEndpoints = ['/ajax/dataEmbed.asp'];
    });
}

// Alternatif listesi: JSON ({"data":[{"id":..,"baslik":..}]}) ya da HTML (data-id'li öğeler)
function altList(txt) {
    var out = [];
    var t = String(txt || '').trim();
    try {
        var arr = null;
        if (t.charAt(0) === '[') arr = JSON.parse(t);
        else if (t.charAt(0) === '{') {
            var o = JSON.parse(t);
            arr = o.data || o.veri || o.list;
        }
        if (arr && arr.length) {
            for (var i = 0; i < arr.length; i++) {
                var e = arr[i];
                if (!e) continue;
                var id = e.id != null ? String(e.id) : '';
                var nm = e.baslik || e.name || '';
                if (id) out.push({ id: id, name: String(nm) });
            }
        }
    } catch (e) {}
    if (!out.length) {
        var re = /data-id=["'](\d+)["'][^>]*>([^<]*)</g;
        var m;
        while ((m = re.exec(t))) out.push({ id: m[1], name: m[2].trim() });
    }
    return out;
}

var reAsset = /.*\.(js|css|png|jpe?g|gif|svg|ico|woff2?)(\?.*)?$/i;

function embedOf(txt0) {
    var txt = String(txt0).replace(/\\\//g, '/');
    var im = /<iframe[^>]+src=["']([^"']+)["']/i.exec(txt);
    if (im) return im[1];
    var re = /(?:src|data-src|file|source|url)["']?\s*[:=]\s*["']([^"']+)["']/gi;
    var m;
    while ((m = re.exec(txt))) {
        var u = m[1];
        if ((u.indexOf('http') === 0 || u.charAt(0) === '/') && !reAsset.test(u)) return u;
    }
    var r2 = /(?:https?:)?\/\/[^"'\\\s<>]+/g;
    while ((m = r2.exec(txt))) {
        if (m[0].indexOf('sezonlukdizi') < 0 && !reAsset.test(m[0])) return m[0];
    }
    return null;
}

function rl(x) {
    x = String(x || '');
    return x.indexOf('1015') >= 0 || /rate limit/i.test(x) || /too many/i.test(x);
}

function hostLabel(u) {
    var m = /^https?:\/\/(?:www\.)?([^.\/]+)/i.exec(u);
    if (!m) return 'Player';
    return m[1].charAt(0).toUpperCase() + m[1].slice(1);
}

function dilName(x) {
    return x === '0' ? 'Dublaj' : 'Altyazı';
}

// ------------------------------------------------------------------
// Akış nesneleri
// ------------------------------------------------------------------
function cdnHeaders(origin) {
    return { 'User-Agent': UA, Referer: origin + '/', Origin: origin };
}

// { url, res, type, headers, master }
function m3u8Item(url, embed) {
    var origin = originOf(embed);
    return { url: url, res: 0, type: 'm3u8', headers: cdnHeaders(origin), master: /master\.m3u8/i.test(url) };
}

// Ana listeden en yüksek çözünürlüğü okur (olmazsa 0)
function hlsMaxRes(item) {
    return getText(item.url, item.headers).then(function (body) {
        var best = 0;
        if (body.indexOf('#EXTM3U') >= 0) {
            var re = /RESOLUTION=\d+x(\d+)/g;
            var m;
            while ((m = re.exec(body))) best = Math.max(best, parseInt(m[1], 10));
        }
        return best;
    });
}

// ------------------------------------------------------------------
// Oynatıcı çözücüleri: Byse (AES-GCM), Vidmoly, genel
// ------------------------------------------------------------------
function extractByse(embed) {
    var origin = originOf(embed);
    var im = /\/e\/([^?\/#]+)/.exec(embed);
    if (!im) return Promise.resolve([]);
    var id = im[1];
    return http('GET', origin + '/api/videos/' + id, { headers: { 'User-Agent': UA, Referer: embed } }).then(function (r) {
        if (!r) return [];
        var o;
        try {
            o = JSON.parse(r.text);
        } catch (e) {
            return [];
        }
        var p = o && o.playback;
        if (!p || !p.key_parts || !p.key_parts.length || !p.iv || !p.payload) return [];
        var parts = p.key_parts.map(b64bin);
        var iv = b64bin(p.iv);
        var enc = b64bin(p.payload);
        var v = parseInt(p.version, 10) || 0;
        var n = parts.length;
        var valid = { 16: 1, 24: 1, 32: 1 };
        var cands = [];
        var seen = {};
        function addKey(k) {
            var s = k.join(',');
            if (!seen[s]) {
                seen[s] = 1;
                cands.push(k);
            }
        }
        // Gözlenen düzen: parts[version-1] + parts[n-version]
        if (v >= 1 && v <= n && (n - v) >= 0 && (n - v) < n && v - 1 !== n - v) addKey(parts[v - 1].concat(parts[n - v]));
        for (var i = 0; i < n; i++) {
            for (var j = 0; j < n; j++) {
                if (i !== j && valid[parts[i].length + parts[j].length]) addKey(parts[i].concat(parts[j]));
            }
        }
        parts.forEach(function (x) {
            if (valid[x.length]) addKey(x);
        });
        var json = null;
        for (var c = 0; c < cands.length && !json; c++) {
            try {
                var first = gcmDecrypt(cands[c], iv, enc, true);
                if (!first || first[0] !== 0x7B) continue; // '{' değilse bu anahtar yanlış
                var full = gcmDecrypt(cands[c], iv, enc, false);
                var obj = JSON.parse(utf8Decode(full));
                if (obj && obj.sources) json = obj;
            } catch (e) {}
        }
        if (!json) {
            log('byse çözülemedi, denenen anahtar', cands.length);
            return [];
        }
        var headers = cdnHeaders(origin);
        var out = [];
        json.sources.forEach(function (s) {
            var url = String(s.url || '').replace(/\\\//g, '/');
            if (url.indexOf('http') !== 0) return;
            var ql = s.label || '1080p';
            var mime = s.mime_type || '';
            var res = parseInt(ql, 10) || 0;
            if (url.indexOf('.m3u8') >= 0 || /mpegurl/i.test(mime)) {
                out.push({ url: url, res: res, type: 'm3u8', headers: headers, master: /master\.m3u8/i.test(url) });
            } else {
                out.push({ url: url, res: res, type: 'mp4', headers: headers, master: false });
            }
        });
        return out;
    });
}

// Vidmoly: oynatıcı sayfasında açık .m3u8 var
function extractVidmoly(embed) {
    var hm = /^https?:\/\/([^\/]+)/i.exec(embed);
    if (!hm) return Promise.resolve([]);
    var host0 = hm[1];
    var idm = /(?:embed-|\/w\/|\/e\/|\/embed\/)([A-Za-z0-9]{6,})/.exec(embed);
    var id = idm ? idm[1] : null;
    var hosts = [host0, 'vidmoly.biz', 'vidmoly.to', 'vidmoly.me', 'vidmoly.net'].filter(function (h, i, a) {
        return a.indexOf(h) === i;
    });
    function tryHost(i) {
        if (i >= hosts.length) return Promise.resolve([]);
        var host = hosts[i];
        var url;
        if (host === host0) url = embed;
        else if (id) url = 'https://' + host + '/embed-' + id + '.html';
        else return tryHost(i + 1);
        var origin = 'https://' + host;
        return http('GET', url, {
            headers: { 'User-Agent': UA, Referer: BASE + '/', 'Sec-Fetch-Dest': 'iframe' },
            timeout: 12000
        }).then(function (r) {
            if (!r) return tryHost(i + 1);
            var clean = r.text.replace(/\\\//g, '/');
            var fm = /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/.exec(clean) ||
                /["'](https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*)["']/.exec(clean);
            if (!fm) return tryHost(i + 1);
            var link = fm[1].replace(/&amp;/g, '&');
            var qm = /label\s*:\s*["'](\d{3,4})p/.exec(clean);
            return [{ url: link, res: qm ? parseInt(qm[1], 10) : 0, type: 'm3u8', headers: cdnHeaders(origin), master: true }];
        });
    }
    return tryHost(0);
}

// Packer'lı (Filemoon vb.) ya da düz sayfadaki m3u8'i bulur; bir iç iframe'e kadar iner
function extractGeneric(embed, depth) {
    return http('GET', embed, { headers: { 'User-Agent': UA, Referer: BASE + '/' }, timeout: 10000 }).then(function (r) {
        if (!r) return [];
        var texts = [r.text].concat(unpackAll(r.text));
        var m3 = null;
        for (var i = 0; i < texts.length && !m3; i++) m3 = findM3u8(texts[i]);
        if (m3) return [m3u8Item(m3, embed)];
        if ((depth || 0) < 1) {
            var im = /<iframe[^>]+src=["']([^"']+)["']/i.exec(r.text);
            if (im) {
                var inner = resolveUrl(embed, im[1]);
                if (/^https?:/i.test(inner) && !/sezonlukdizi/i.test(inner)) return extractGeneric(inner, (depth || 0) + 1);
            }
        }
        return [];
    });
}

function emitEmbed(embed) {
    var u = absUrl(embed);
    if (!/^https?:/i.test(u)) return Promise.resolve([]);
    var p = Promise.resolve([]);
    if (/byse/i.test(u)) p = extractByse(u).catch(function () {
        return [];
    });
    return p.then(function (r) {
        if (r.length) return r;
        if (/vidmoly/i.test(u)) {
            return extractVidmoly(u).catch(function () {
                return [];
            });
        }
        return r;
    }).then(function (r) {
        if (r.length) return r;
        return extractGeneric(u, 0).catch(function () {
            return [];
        });
    });
}

// ------------------------------------------------------------------
// Oynatma (CloudStream loadLinks karşılığı)
// ------------------------------------------------------------------
function captchaInner(st, u, ref, force) {
    var full = absUrl(u);
    var dec = full;
    try {
        dec = decodeURIComponent(full);
    } catch (e) {}
    var qi = dec.indexOf('?');
    var query = qi >= 0 ? dec.slice(qi + 1) : '';
    var re = /https?:\/\/[^\s"'&<>]+/g;
    var m;
    while ((m = re.exec(query))) {
        if (!/sezonlukdizi/i.test(m[0]) && !/recaptcha/i.test(m[0])) return Promise.resolve(m[0]);
    }
    if (force || !st.gateProbed) {
        st.gateProbed = true;
        return siteGet(full, ref, 10000).then(function (r) {
            if (!r) return null;
            var h = r.text.replace(/\\\//g, '/');
            var vm = /https?:\/\/[^\s"'<>\\]*(?:vidmoly|embed-)[^\s"'<>\\]*/i.exec(h);
            return vm ? vm[0] : null;
        });
    }
    return Promise.resolve(null);
}

// Bir kaynağın topladığımız bağlantılarından dil başına TEK bağlantı verir
function flush(st, dil, buf, suffix) {
    if (!buf.length) return Promise.resolve(false);
    if (st.emitted[dil] && !suffix) return Promise.resolve(true);
    var pick = buf.filter(function (b) {
        return b.master;
    })[0] || buf.slice().sort(function (a, b) {
        return b.res - a.res;
    })[0] || buf[0];
    var resP = pick.type === 'm3u8' && !pick.res ? hlsMaxRes(pick) : Promise.resolve(pick.res);
    return resP.then(function (res) {
        var title = 'Türkçe ' + dilName(dil) + (suffix ? ' - ' + suffix : '') + (res ? ' (' + res + 'p)' : '');
        st.streams.push({
            name: 'SezonlukDizi',
            title: title,
            url: pick.url,
            quality: res ? res + 'p' : 'Auto',
            headers: pick.headers,
            provider: 'sezonlukdizi',
            _dil: dil
        });
        if (!suffix) st.emitted[dil] = true;
        return true;
    });
}

// Bir gömülü oynatıcıyı verilen dil etiketiyle yayınlar (captcha kapısıysa içindeki adresi arar)
function emit(st, dil, embed0, suffix) {
    var embed = embed0;
    if (!embed) return Promise.resolve(false);
    var pre = Promise.resolve(embed);
    if (/reCAPTCHA/i.test(embed)) {
        if (st.captchaSeen[embed]) return Promise.resolve(false);
        st.captchaSeen[embed] = 1;
        pre = captchaInner(st, embed, BASE + '/', false).then(function (inner) {
            return inner || '';
        });
    }
    return pre.then(function (e2) {
        if (!e2) return false;
        if (st.seen[e2]) return false;
        st.seen[e2] = 1;
        var gather;
        if (/\.m3u8(\?|$)/.test(e2)) {
            var full = absUrl(e2);
            gather = Promise.resolve([m3u8Item(full, full)]);
        } else {
            gather = emitEmbed(e2);
        }
        return gather.then(function (buf) {
            return flush(st, dil, buf, suffix);
        }).then(function (ok) {
            log('kaynak', dilName(dil), e2, ok);
            if (ok && !suffix) {
                st.any = true;
                st.got[dil] = true;
            }
            return ok;
        });
    });
}

// Kaynak id'sinden gömülü oynatıcı adresini ister; hız sınırında bekleyip yeniden dener
function fetchEmbed(st, id, ref) {
    function attempt(a) {
        function tryEp(k) {
            if (k >= embedEndpoints.length) return Promise.resolve({ found: null, raw: '' });
            return sitePost(BASE + embedEndpoints[k], { id: id }, ref).then(function (r) {
                var raw = r ? ((r.status === 403 || r.status === 503) ? 'HATA ' + r.status : r.text) : 'HATA';
                var found = embedOf(raw);
                if (found) return { found: found, raw: raw };
                return tryEp(k + 1).then(function (nx) {
                    return nx.found ? nx : { found: null, raw: raw };
                });
            });
        }
        return tryEp(0).then(function (res) {
            if (res.found || !rl(res.raw) || st.waitBudget <= 0 || a >= 2) return res;
            var w = 3000 + a * 2000;
            st.waitBudget -= w;
            return sleep(w).then(function () {
                return attempt(a + 1);
            });
        });
    }
    return attempt(0);
}

function tryId(st, dil, id, ref, nm, idx, suffix) {
    return fetchEmbed(st, id, ref).then(function (res) {
        var f = res.found;
        if (!f) {
            st.retryQ.push({ dil: dil, id: id, ref: ref });
            return;
        }
        var cap = /reCAPTCHA/i.test(f);
        return emit(st, dil, f, suffix).then(function (ok) {
            if (cap && !ok) st.retryQ.push({ dil: dil, id: id, ref: ref });
            if (ok) {
                if (nm) goodKeys['n:' + nm.trim().toLowerCase()] = 1;
                if (idx >= 0) goodKeys['i:' + dil + ':' + idx] = 1;
            }
        });
    });
}

function fetchPage(st, pu) {
    return siteGet(pu, BASE + '/').then(function (r) {
        if (!r || r.status < 200 || r.status > 299 || isChallenge(r.status, r.text)) {
            log('sayfa alınamadı', pu, r ? r.status : 'yok');
            return;
        }
        var html = r.text;
        var bid = pageBid(html);
        var activeDil = pageActiveDil(html, pu);
        return discoverEndpoints(html).then(function () {
            var embeds = pageEmbeds(html);
            log('sayfa', pu, 'bid', bid, 'dil', activeDil, 'açık', embeds.length);
            st.pages.push({ url: pu, bid: bid, dil: activeDil });
            return seq(embeds, function (f) {
                return emit(st, activeDil, f, '');
            });
        });
    });
}

function prio(dil, idx, nm) {
    var n = (nm || '').trim().toLowerCase();
    if (n.indexOf('byse') >= 0 || n.indexOf('filemoon') >= 0) return 0;
    if (goodKeys['i:' + dil + ':' + idx]) return 1;
    if (n && goodKeys['n:' + n]) return 2;
    return 3;
}

function loadLinks(epSlug, s, e) {
    var st = {
        any: false, seen: {}, captchaSeen: {}, got: {}, emitted: {}, retryQ: [], streams: [],
        pages: [], waitBudget: WAIT_BUDGET, gateProbed: false
    };
    var pageUrls = [
        BASE + '/' + epSlug + '/' + s + '-sezon-' + e + '-bolum.html',
        BASE + '/' + epSlug + '/dublaj/' + s + '-sezon-' + e + '-bolum.html'
    ];
    var queues = {};
    var refs = {};

    // 2) Alternatif kaynak listeleri
    function buildQueues() {
        return seq(['0', '1'], function (dil) {
            var refPage = st.pages.filter(function (p) {
                return (dil === '0') === (p.url.indexOf('/dublaj/') >= 0);
            })[0] || st.pages[0];
            if (!refPage) return;
            var bid = refPage.bid || (st.pages.filter(function (p) {
                return p.bid;
            })[0] || {}).bid;
            if (!bid) return;
            function tryEp(k) {
                if (k >= altEndpoints.length) return Promise.resolve([]);
                function att(a) {
                    return sitePost(BASE + altEndpoints[k], { bid: bid, dil: dil }, refPage.url).then(function (r) {
                        var txt = r ? r.text : '';
                        if (rl(txt) && st.waitBudget > 0 && a < 2) {
                            st.waitBudget -= 5000;
                            return sleep(5000).then(function () {
                                return att(a + 1);
                            });
                        }
                        return altList(txt);
                    });
                }
                return att(0).then(function (alts) {
                    return alts.length ? alts : tryEp(k + 1);
                });
            }
            return tryEp(0).then(function (alts) {
                refs[dil] = refPage.url;
                queues[dil] = alts.map(function (a, i) {
                    return { id: a.id, name: a.name, idx: i };
                }).sort(function (x, y) {
                    return prio(dil, x.idx, x.name) - prio(dil, y.idx, y.name) || x.idx - y.idx;
                });
                log('bid', bid, 'dil', dil, 'alt', alts.length);
            });
        });
    }

    // İki dil sırayla (altyazı/dublaj dönüşümlü) denenir; bir dilde kaynak bulununca o dil durur
    function roundRobin() {
        var pos = {};
        var turn = 0;
        function step() {
            var job = null;
            for (var t = 0; t < 2 && !job; t++) {
                var d = (turn + t) % 2;
                var dil = d === 0 ? '0' : '1';
                if (st.got[dil]) continue;
                var q = queues[dil];
                if (!q) continue;
                var i = pos[dil] || 0;
                if (i >= q.length) continue;
                pos[dil] = i + 1;
                job = { dil: dil, cand: q[i] };
                turn = (d + 1) % 2;
            }
            if (!job) return Promise.resolve();
            return tryId(st, job.dil, job.cand.id, refs[job.dil] || pageUrls[0], job.cand.name, job.cand.idx, '')
                .then(function () {
                    return sleep(400);
                }).then(step);
        }
        return step();
    }

    // 3) Boş dönen / kapıya takılan kaynaklar bir kez daha denenir
    function retries() {
        return seq(['0', '1'], function (dil) {
            if (st.got[dil]) return;
            var todo = st.retryQ.filter(function (x) {
                return x.dil === dil;
            }).slice(0, 4);
            return seq(todo, function (t) {
                if (st.got[dil]) return;
                return sleep(1200).then(function () {
                    return tryId(st, dil, t.id, t.ref, '', -1, '');
                });
            });
        });
    }

    // 4) Vidmoly: ek bağlantı (kapı çözülemiyorsa atlanır)
    function vidmolyExtra() {
        return seq(['0', '1'], function (dil) {
            var q = queues[dil];
            var cand = q && q.filter(function (c) {
                return /vidmoly/i.test(c.name);
            })[0];
            if (!cand) return;
            var ref = refs[dil] || pageUrls[0];
            return fetchEmbed(st, cand.id, ref).then(function (res) {
                var f = res.found;
                if (!f) return;
                var pre = Promise.resolve(f);
                if (/reCAPTCHA/i.test(f)) {
                    pre = captchaInner(st, f, ref, true).then(function (inner) {
                        return inner || '';
                    });
                }
                return pre.then(function (f2) {
                    if (!f2 || /reCAPTCHA/i.test(f2) || st.seen[f2]) return;
                    return emitEmbed(absUrl(f2)).then(function (buf) {
                        return flush(st, dil, buf, 'Vidmoly');
                    });
                });
            });
        });
    }

    return seq(pageUrls, function (pu) {
        return fetchPage(st, pu);
    }).then(function () {
        if (!st.pages.length) return;
        return discoverEndpoints('').then(buildQueues).then(roundRobin).then(retries).then(vidmolyExtra);
    }).then(function () {
        var seen = {};
        return st.streams.filter(function (x) {
            if (seen[x.url]) return false;
            seen[x.url] = 1;
            return true;
        }).sort(function (a, b) {
            // Dublaj üstte
            return (a._dil === '0' ? 0 : 1) - (b._dil === '0' ? 0 : 1);
        }).map(function (x) {
            delete x._dil;
            return x;
        });
    });
}

// ------------------------------------------------------------------
// Nuvio giriş noktası
// ------------------------------------------------------------------
function getStreams(tmdbId, mediaType, season, episode) {
    if (mediaType !== 'tv') return Promise.resolve([]); // SezonlukDizi sadece dizi
    var s = season || 1;
    var e = episode || 1;
    return tmdbTitles(tmdbId).then(function (titles) {
        if (!titles) return [];
        return findSeries(titles).then(function (path) {
            if (!path) {
                log('dizi bulunamadı', titles);
                return [];
            }
            return episodeSlugs(path).then(function (slugs) {
                function tryNext(i) {
                    if (i >= slugs.length) return Promise.resolve([]);
                    return loadLinks(slugs[i], s, e).then(function (r) {
                        return r.length ? r : tryNext(i + 1);
                    });
                }
                return tryNext(0);
            });
        });
    }).catch(function (err) {
        log('hata', err && err.message);
        return [];
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams: getStreams };
} else if (typeof global !== 'undefined') {
    global.getStreams = getStreams;
}
