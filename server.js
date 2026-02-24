const http = require('http');
const https = require('https');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const DEFAULT_SETTINGS = { dnsServer: '1.1.1.1', adBlockEnabled: true };

const BLOCKED_DOMAIN_KEYWORDS = [
  'doubleclick', 'googlesyndication', 'adservice', 'taboola', 'outbrain', 'popads',
  'propellerads', 'adnxs', 'mgid', 'exoclick', 'adsterra', 'trafficjunky', 'revcontent'
];

const SUSPICIOUS_REDIRECT_KEYWORDS = [
  'click', 'redirect', 'out', 'jump', 'go', 'ad', 'aff', 'track', 'offer', 'sponsor'
];

const FAKE_BUTTON_TEXT = ['download', 'play', 'watch', 'continue', 'start', 'install', 'open'];

ensureDataFiles();

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);

    if (urlObj.pathname.startsWith('/api/')) {
      return handleApi(req, res, urlObj);
    }

    if (urlObj.pathname === '/proxy') {
      return handleProxy(req, res, urlObj);
    }

    return serveStatic(req, res, urlObj.pathname);
  } catch (err) {
    json(res, 500, { error: 'Sunucu hatası', details: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Minimal browser running at http://localhost:${PORT}`);
});

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
}

function getSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function getHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveHistory(items) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(items.slice(0, 200), null, 2));
}

function addHistoryItem(item) {
  const items = getHistory();
  items.unshift({ ...item, visitedAt: new Date().toISOString() });
  saveHistory(items);
}

async function handleApi(req, res, urlObj) {
  if (urlObj.pathname === '/api/settings' && req.method === 'GET') {
    return json(res, 200, getSettings());
  }

  if (urlObj.pathname === '/api/settings' && req.method === 'POST') {
    const body = await readJson(req);
    const next = {
      dnsServer: String(body?.dnsServer || DEFAULT_SETTINGS.dnsServer).trim(),
      adBlockEnabled: Boolean(body?.adBlockEnabled)
    };
    saveSettings(next);
    return json(res, 200, next);
  }

  if (urlObj.pathname === '/api/history' && req.method === 'GET') {
    return json(res, 200, getHistory());
  }

  if (urlObj.pathname === '/api/history' && req.method === 'DELETE') {
    saveHistory([]);
    return json(res, 200, { ok: true });
  }

  if (urlObj.pathname === '/api/dns-resolve' && req.method === 'GET') {
    const host = urlObj.searchParams.get('host');
    if (!host) return json(res, 400, { error: 'host gerekli' });
    const settings = getSettings();
    try {
      const ip = await resolveWithDns(host, settings.dnsServer);
      return json(res, 200, { host, dnsServer: settings.dnsServer, ip });
    } catch (err) {
      return json(res, 500, { error: 'DNS çözümlemesi başarısız', details: err.message });
    }
  }

  return json(res, 404, { error: 'Bulunamadı' });
}

async function handleProxy(req, res, urlObj) {
  const target = urlObj.searchParams.get('url');
  if (!target) return html(res, 400, '<h1>url parametresi gerekli</h1>');

  let targetUrl;
  try {
    targetUrl = normalizeUrl(target);
  } catch {
    return html(res, 400, '<h1>Geçersiz URL</h1>');
  }

  const settings = getSettings();
  if (settings.adBlockEnabled && isBlockedUrl(targetUrl)) {
    return html(res, 403, '<h1>Bu bağlantı reklam/güvensiz olarak engellendi.</h1>');
  }

  try {
    const result = await fetchThroughDns(targetUrl, settings.dnsServer, 5, settings.adBlockEnabled);
    const contentType = (result.headers['content-type'] || '').toLowerCase();

    addHistoryItem({ title: targetUrl, url: targetUrl });

    if (contentType.includes('text/html')) {
      const rewritten = rewriteHtml(result.body.toString('utf8'), targetUrl, settings.adBlockEnabled);
      res.writeHead(result.statusCode, {
        'content-type': 'text/html; charset=utf-8',
        'x-proxy-target': targetUrl
      });
      return res.end(rewritten);
    }

    const headers = {
      'content-type': result.headers['content-type'] || 'application/octet-stream',
      'cache-control': 'no-cache'
    };
    res.writeHead(result.statusCode, headers);
    return res.end(result.body);
  } catch (err) {
    return html(res, 502, `<h1>Hedef site alınamadı</h1><pre>${escapeHtml(err.message)}</pre>`);
  }
}

function rewriteHtml(rawHtml, baseUrl, adBlockEnabled) {
  let htmlText = rawHtml;

  htmlText = htmlText.replace(/<base[^>]*>/gi, '');

  htmlText = htmlText.replace(/\s(href|src)=(["'])(.*?)\2/gi, (match, attr, quote, val) => {
    if (!val || val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#')) return match;
    let absolute;
    try {
      absolute = new URL(val, baseUrl).toString();
    } catch {
      return match;
    }

    if (adBlockEnabled && isBlockedUrl(absolute)) {
      return ` ${attr}=${quote}about:blank${quote}`;
    }

    if (attr.toLowerCase() === 'href') {
      return ` href=${quote}/proxy?url=${encodeURIComponent(absolute)}${quote}`;
    }

    return ` ${attr}=${quote}/proxy?url=${encodeURIComponent(absolute)}${quote}`;
  });

  const protector = `
<script>
(() => {
  const fakeWords = ${JSON.stringify(FAKE_BUTTON_TEXT)};
  const suspicious = ${JSON.stringify(SUSPICIOUS_REDIRECT_KEYWORDS)};
  function shouldBlock(anchor) {
    try {
      const href = anchor.getAttribute('href') || '';
      if (!href || href.startsWith('#')) return false;
      const u = new URL(href, location.origin);
      const t = (anchor.textContent || '').toLowerCase().trim();
      const full = u.href.toLowerCase();
      const hasFakeText = fakeWords.some(w => t.includes(w));
      const hasSuspicious = suspicious.some(w => full.includes(w));
      return hasFakeText && hasSuspicious;
    } catch { return false; }
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    if (shouldBlock(a)) {
      e.preventDefault();
      e.stopPropagation();
      alert('Şüpheli reklam yönlendirmesi engellendi.');
    }
  }, true);
})();
</script>`;

  htmlText = htmlText.replace(/<\/body>/i, `${protector}</body>`);
  if (!htmlText.includes('</body>')) htmlText += protector;

  return htmlText;
}

function normalizeUrl(input) {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('unsupported protocol');
  return u.toString();
}

function isBlockedUrl(u) {
  try {
    const urlObj = new URL(u);
    const host = urlObj.hostname.toLowerCase();
    const full = u.toLowerCase();
    if (BLOCKED_DOMAIN_KEYWORDS.some((k) => host.includes(k))) return true;
    if (SUSPICIOUS_REDIRECT_KEYWORDS.some((k) => full.includes(`${k}=`) || full.includes(`/${k}/`))) {
      if (urlObj.searchParams.has('url') || urlObj.searchParams.has('redirect') || urlObj.searchParams.has('target')) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function fetchThroughDns(urlStr, dnsServer, redirectsLeft, adBlockEnabled) {
  if (redirectsLeft < 0) throw new Error('Too many redirects');

  const urlObj = new URL(urlStr);
  const ip = await resolveWithDns(urlObj.hostname, dnsServer);

  const transport = urlObj.protocol === 'https:' ? https : http;
  const port = urlObj.port ? Number(urlObj.port) : (urlObj.protocol === 'https:' ? 443 : 80);

  const options = {
    host: ip,
    port,
    method: 'GET',
    path: `${urlObj.pathname}${urlObj.search}`,
    headers: {
      'host': urlObj.host,
      'user-agent': 'MinimalSecureBrowser/1.0'
    },
    timeout: 15000
  };

  if (urlObj.protocol === 'https:') {
    options.servername = urlObj.hostname;
    options.rejectUnauthorized = true;
  }

  const response = await new Promise((resolve, reject) => {
    const request = transport.request(options, (resp) => {
      const chunks = [];
      resp.on('data', (chunk) => chunks.push(chunk));
      resp.on('end', () => {
        resolve({
          statusCode: resp.statusCode || 500,
          headers: resp.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Request timeout')));
    request.end();
  });

  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    const location = response.headers.location;
    if (!location) return response;
    const nextUrl = new URL(location, urlStr).toString();
    if (adBlockEnabled && isBlockedUrl(nextUrl)) {
      throw new Error('Redirect reklam şüphesi nedeniyle engellendi');
    }
    return fetchThroughDns(nextUrl, dnsServer, redirectsLeft - 1, adBlockEnabled);
  }

  return response;
}

async function resolveWithDns(hostname, dnsServer) {
  const resolver = new dns.promises.Resolver();
  resolver.setServers([dnsServer]);
  try {
    const ips = await resolver.resolve4(hostname);
    if (ips && ips.length) return ips[0];
  } catch {
    // fallback below
  }

  try {
    const fallback4 = await dns.promises.lookup(hostname, { family: 4 });
    return fallback4.address;
  } catch {
    const fallbackAny = await dns.promises.lookup(hostname);
    return fallbackAny.address;
  }
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(__dirname, 'public', safePath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) return html(res, 403, 'Forbidden');

  fs.readFile(filePath, (err, data) => {
    if (err) return html(res, 404, '<h1>Not Found</h1>');
    const ext = path.extname(filePath);
    const type = ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'text/html';
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function html(res, status, markup) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(markup);
}

function escapeHtml(str) {
  return str.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
