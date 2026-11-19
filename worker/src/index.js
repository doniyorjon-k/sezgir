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

// visitors: counted by our own pings, no third-party analytics
const ONLINE_MS = 5 * 60 * 1000;
const tzDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" }); // YYYY-MM-DD

async function live(env) {
  const day = tzDay();
  const on = await env.DB.prepare("SELECT COUNT(DISTINCT client) AS c FROM visits WHERE last > ?").bind(Date.now() - ONLINE_MS).first();
  const td = await env.DB.prepare("SELECT COUNT(*) AS c FROM visits WHERE date = ?").bind(day).first();
  return { online: on.c, today: td.c, day };
}

async function summary(env) { // last 14 days: visitors and players per day
  const since = tzDay(new Date(Date.now() - 13 * 864e5));
  const v = await env.DB.prepare("SELECT date, COUNT(*) AS c FROM visits WHERE date >= ? GROUP BY date").bind(since).all();
  const p = await env.DB.prepare("SELECT date, COUNT(*) AS c, ROUND(AVG(total)) AS avg FROM plays WHERE date >= ? GROUP BY date").bind(since).all();
  const days = []; for (let i = 13; i >= 0; i--) { const d = tzDay(new Date(Date.now() - i * 864e5)); const vv = v.results.find(r => r.date === d), pp = p.results.find(r => r.date === d); days.push({ date: d, visitors: vv?.c ?? 0, players: pp?.c ?? 0, avg: pp?.avg ?? null }); }
  const tot = await env.DB.prepare("SELECT COUNT(DISTINCT client) AS c FROM visits").first();
  return { days, allVisitors: tot.c };
}

export default {
  async fetch(req, env) {
    const h = cors(req, env), url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    try {
      if (url.pathname === "/stats" && req.method === "GET") {
        const date = url.searchParams.get("date") || todayAround()[1];
        if (!DATE.test(date)) return json({ error: "bad date" }, 400, h);
        const t = url.searchParams.get("total"); const total = t === null ? undefined : parseInt(t, 10);
        return json(await stats(env, date, total), 200, { ...h, "Cache-Control": "public, max-age=30" });
      }
      if (url.pathname === "/live" && req.method === "GET") return json(await live(env), 200, { ...h, "Cache-Control": "public, max-age=20" });
      if (url.pathname === "/summary" && req.method === "GET") return json(await summary(env), 200, { ...h, "Cache-Control": "public, max-age=60" });
      if (url.pathname === "/ping" && req.method === "POST") {
        const b = await req.json().catch(() => null);
        if (!b || !CLIENT.test(b.client)) return json({ error: "bad body" }, 400, h);
        await env.DB.prepare("INSERT INTO visits (date, client, last) VALUES (?, ?, ?) ON CONFLICT(date, client) DO UPDATE SET last = excluded.last").bind(tzDay(), b.client, Date.now()).run();
        return json(await live(env), 200, h);
      }
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
