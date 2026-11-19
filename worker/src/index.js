// Sezgir stats API: stores one score per player per day, returns daily aggregates.
const DATE = /^\d{4}-\d{2}-\d{2}$/, CLIENT = /^[a-z0-9]{16,40}$/;

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

function todayAround() { // a submitted date must be within a day of now (time zones), archive days are not counted
  const d = new Date(), f = x => x.toISOString().slice(0, 10);
  return [f(new Date(d - 864e5)), f(d), f(new Date(+d + 864e5))];
}

async function stats(env, date, total) {
  const agg = await env.DB.prepare("SELECT COUNT(*) AS n, ROUND(AVG(total)) AS avg FROM plays WHERE date = ?").bind(date).first();
  const rows = await env.DB.prepare("SELECT MIN(total / 10, 9) AS b, COUNT(*) AS c FROM plays WHERE date = ? GROUP BY b").bind(date).all();
  const hist = Array(10).fill(0); for (const r of rows.results) hist[r.b] = r.c;
  const all = await env.DB.prepare("SELECT COUNT(DISTINCT client) AS players FROM plays").first();
  const out = { date, players: agg.n, avg: agg.avg ?? 0, hist, allPlayers: all.players };
  if (Number.isInteger(total) && agg.n > 0) {
    const below = await env.DB.prepare("SELECT COUNT(*) AS c FROM plays WHERE date = ? AND total < ?").bind(date, total).first();
    out.beats = Math.round(below.c / agg.n * 100);
  }
  return out;
}

// visitors online + today, read from DataFast with a secret key kept in the worker (DATAFAST_KEY)
async function live(env, ctx) {
  const cache = caches.default, key = new Request("https://cache.sezgir/live");
  const hit = await cache.match(key); if (hit) return hit.json();
  if (!env.DATAFAST_KEY) return { online: null, today: null };
  const auth = { headers: { Authorization: `Bearer ${env.DATAFAST_KEY}` } };
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" }); // YYYY-MM-DD
  const [rt, ov] = await Promise.all([
    fetch("https://datafa.st/api/v1/analytics/realtime?fields=visitors", auth).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`https://datafa.st/api/v1/analytics/overview?startAt=${day}&endAt=${day}&timezone=Asia/Tashkent&fields=visitors`, auth).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  const out = { online: rt?.data?.[0]?.visitors ?? null, today: ov?.data?.[0]?.visitors ?? null };
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "max-age=60" } })));
  return out;
}

export default {
  async fetch(req, env, ctx) {
    const h = cors(req, env), url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    try {
      if (url.pathname === "/stats" && req.method === "GET") {
        const date = url.searchParams.get("date") || todayAround()[1];
        if (!DATE.test(date)) return json({ error: "bad date" }, 400, h);
        const t = url.searchParams.get("total"); const total = t === null ? undefined : parseInt(t, 10);
        return json(await stats(env, date, total), 200, { ...h, "Cache-Control": "public, max-age=30" });
      }
      if (url.pathname === "/live" && req.method === "GET") return json(await live(env, ctx), 200, { ...h, "Cache-Control": "public, max-age=30" });
      if (url.pathname === "/submit" && req.method === "POST") {
        const b = await req.json().catch(() => null);
        if (!b || !DATE.test(b.date) || !CLIENT.test(b.client) || !Array.isArray(b.scores) || b.scores.length !== 5) return json({ error: "bad body" }, 400, h);
        if (!todayAround().includes(b.date)) return json({ error: "only today's puzzle counts" }, 400, h);
        const scores = b.scores.map(Number); if (scores.some(s => !Number.isInteger(s) || s < 0 || s > 100)) return json({ error: "bad scores" }, 400, h);
        const total = Math.round(scores.reduce((a, s) => a + s, 0) / 5);
        await env.DB.prepare("INSERT OR IGNORE INTO plays (date, client, total, scores, created) VALUES (?, ?, ?, ?, ?)").bind(b.date, b.client, total, JSON.stringify(scores), Date.now()).run();
        return json(await stats(env, b.date, total), 200, h);
      }
      return json({ error: "not found" }, 404, h);
    } catch (e) { return json({ error: "server error" }, 500, h); }
  },
};
