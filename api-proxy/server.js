// indie-api-proxy — 零依赖缓存代理（Node 18+，用内置 fetch）
// 只监听 127.0.0.1:3001，仅供本机 Nginx 转发；前端页面请求 /api/* 由 Nginx 转到这里。
// 特性：内存 LRU 缓存、上游失败时返回过期缓存降级、10s 上游超时、每 IP 每分钟 120 次限流。
'use strict';
const http = require('http');

const PORT = process.env.PORT || 3001;
const BIND = process.env.BIND || '127.0.0.1';

// ---- 内存缓存 ----
const cache = new Map(); // key -> { exp, data }
function getCache(key) {
  const e = cache.get(key);
  if (!e) return { hit: false, stale: false, data: null };
  if (Date.now() < e.exp) return { hit: true, stale: false, data: e.data };
  return { hit: false, stale: true, data: e.data }; // 过期但可降级
}
function setCache(key, data, ttlMs) {
  cache.set(key, { exp: Date.now() + ttlMs, data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
}

// ---- 上游请求（10s 超时） ----
async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 10000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      method: opts.method || 'GET',
      body: opts.body,
      headers: { 'User-Agent': 'indie-api-proxy/1.0', 'Accept': 'application/json', ...(opts.headers || {}) },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ---- 限流：每 IP 每分钟 120 次 ----
const rl = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let e = rl.get(ip);
  if (!e || now > e.reset) { e = { count: 0, reset: now + 60000 }; rl.set(ip, e); }
  e.count += 1;
  return e.count > 120;
}

// ---- ETH gas：多个公共 RPC 轮询 ----
const ETH_RPCS = [
  'https://ethereum.publicnode.com',
  'https://eth.llamarpc.com',
  'https://rpc.builder0x69.io',
];
async function ethGasPrice() {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] });
  for (const rpc of ETH_RPCS) {
    try {
      const j = await fetchJson(rpc, {
        method: 'POST', body,
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000,
      });
      if (j && j.result) {
        const wei = BigInt(j.result);
        return { gwei: Number(wei / 1000000000n), rpc };
      }
    } catch { /* 换下一个 */ }
  }
  throw new Error('all ETH RPCs failed');
}

// ---- 路由表 ----
const ROUTES = {
  '/api/health': {
    ttl: 0,
    fn: async () => ({ ok: true, time: new Date().toISOString() }),
  },
  '/api/price': {
    ttl: 60000,
    fn: async (q) => {
      const ids = (q.get('ids') || 'bitcoin,ethereum,solana').slice(0, 200);
      const vs = (q.get('vs') || 'usd').slice(0, 10);
      return fetchJson(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${encodeURIComponent(vs)}`
      );
    },
  },
  '/api/btc-fees': {
    ttl: 60000,
    fn: async () => {
      try {
        const j = await fetchJson('https://mempool.space/api/v1/fees/recommended');
        return { fast: j.fastestFee, standard: j.halfHourFee, economy: j.hourFee, source: 'mempool.space' };
      } catch {
        const j = await fetchJson('https://blockstream.info/api/fee-estimates');
        return {
          fast: Math.round(j['1'] || 0),
          standard: Math.round(j['3'] || 0),
          economy: Math.round(j['6'] || 0),
          source: 'blockstream.info',
        };
      }
    },
  },
  '/api/eth-gas': { ttl: 30000, fn: ethGasPrice },
  '/api/fear-greed': {
    ttl: 3600000,
    fn: async () => {
      const j = await fetchJson('https://api.alternative.me/fng/?limit=2');
      return j.data.map((d) => ({ value: +d.value, label: d.value_classification, time: d.timestamp }));
    },
  },
  '/api/btc-stats': {
    ttl: 600000,
    fn: async () => {
      const j = await fetchJson('https://blockchain.info/stats?format=json');
      return {
        hashrate_eh: (j.hash_rate || 0) / 1e9,
        difficulty: j.difficulty,
        btc_price_usd: j.market_price_usd,
      };
    },
  },
};

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (rateLimited(ip)) {
    res.writeHead(429);
    res.end(JSON.stringify({ error: 'rate limited, slow down' }));
    return;
  }

  const u = new URL(req.url, 'http://x');
  const route = ROUTES[u.pathname];
  if (!route || req.method !== 'GET') {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const key = u.pathname + '?' + u.searchParams.toString();
  const c = getCache(key);
  if (c.hit) {
    res.setHeader('X-Cache', 'HIT');
    res.end(JSON.stringify(c.data));
    return;
  }
  try {
    const data = await route.fn(u.searchParams);
    if (route.ttl > 0) setCache(key, data, route.ttl);
    res.setHeader('X-Cache', 'MISS');
    res.end(JSON.stringify(data));
  } catch (e) {
    if (c.stale) { // 降级：返回过期缓存
      res.setHeader('X-Cache', 'STALE');
      res.end(JSON.stringify(c.data));
      return;
    }
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'upstream failed', detail: String((e && e.message) || e).slice(0, 120) }));
  }
});

server.listen(PORT, BIND, () => console.log(`indie-api-proxy listening on ${BIND}:${PORT}`));
