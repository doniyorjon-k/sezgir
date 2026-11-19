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
  const ta = await env.DB.prepare("SELECT " + [0, 1, 2, 3, 4].map(i => `ROUND(AVG(json_extract(scores, '$[${i}]'))) AS t${i}`).join(", ") + ", MAX(total) AS best FROM plays WHERE date = ?").bind(date).first();
  const vis = await env.DB.prepare("SELECT COUNT(*) AS c FROM visits WHERE date = ?").bind(date).first();
  const out = { date, players: agg.n, avg: agg.avg ?? 0, hist, allPlayers: all.players, testAvg: agg.n ? [0, 1, 2, 3, 4].map(i => ta[`t${i}`]) : null, best: ta.best, visitors: vis.c };
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

async function summary(env, n = 14) { // last n days: visitors and players per day
  const since = tzDay(new Date(Date.now() - (n - 1) * 864e5));
  const v = await env.DB.prepare("SELECT date, COUNT(*) AS c FROM visits WHERE date >= ? GROUP BY date").bind(since).all();
  const p = await env.DB.prepare("SELECT date, COUNT(*) AS c, ROUND(AVG(total)) AS avg FROM plays WHERE date >= ? GROUP BY date").bind(since).all();
  const days = []; for (let i = n - 1; i >= 0; i--) { const d = tzDay(new Date(Date.now() - i * 864e5)); const vv = v.results.find(r => r.date === d), pp = p.results.find(r => r.date === d); days.push({ date: d, visitors: vv?.c ?? 0, players: pp?.c ?? 0, avg: pp?.avg ?? null }); }
  const tot = await env.DB.prepare("SELECT COUNT(DISTINCT client) AS c FROM visits").first();
  return { days, allVisitors: tot.c };
}


// ---------- Telegram bot: daily reminders + streak ----------
const SITE = "https://sezgir.github.io/";
const LAUNCH = Date.UTC(2026, 10, 12); // #1
const puzzleNo = day => Math.round((Date.parse(day + "T00:00:00Z") - LAUNCH) / 864e5) + 1;
const shiftDay = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const newClient = () => { const a = crypto.getRandomValues(new Uint8Array(24)); return Array.from(a, b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""); };

async function tg(env, method, body) {
  const r = await fetch(`${env.TG_API || "https://api.telegram.org"}/bot${env.TG_BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json().catch(() => ({ ok: false }));
}
const playBtn = (client, label = "O'ynash") => ({ inline_keyboard: [[{ text: label, web_app: { url: `${SITE}?cid=${client}` } }]] });

async function streakOf(env, client) { // consecutive days played, counting today or ending yesterday
  if (!client) return { streak: 0, todayRec: null };
  const today = tzDay();
  const rows = await env.DB.prepare("SELECT date, total FROM plays WHERE client = ? AND date >= ? ORDER BY date DESC").bind(client, shiftDay(today, -400)).all();
  const set = new Map(rows.results.map(r => [r.date, r.total]));
  let d = set.has(today) ? today : shiftDay(today, -1), streak = 0;
  while (set.has(d)) { streak++; d = shiftDay(d, -1); }
  return { streak, todayRec: set.has(today) ? set.get(today) : null };
}

async function onMessage(env, msg) {
  const chat = msg.chat?.id, text = (msg.text || "").trim();
  if (!chat || msg.chat.type !== "private") return;
  const name = (msg.from?.first_name || "").slice(0, 40);
  const [cmd, arg] = text.split(/\s+/, 2);
  let u = await env.DB.prepare("SELECT * FROM tg_users WHERE chat_id = ?").bind(chat).first();
  if (cmd === "/start") {
    const client = arg && CLIENT.test(arg) ? arg : (u?.client || newClient());
    await env.DB.prepare("INSERT INTO tg_users (chat_id, client, name, active, created) VALUES (?, ?, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET client = excluded.client, name = excluded.name, active = 1").bind(chat, client, name, Date.now()).run();
    const { streak } = await streakOf(env, client);
    const linked = arg && CLIENT.test(arg) ? `\n\nSaytdagi natijalaringiz ulandi${streak ? `, seriyangiz: ${streak} kun 🔥` : ""}.` : "";
    await tg(env, "sendMessage", { chat_id: chat, text: `Salom${name ? ", " + name : ""}! Men Sezgir botiman.\n\nHar kuni soat 9:00 da yangi jumboq tayyor bo'lganini eslataman. Kechqurun hali o'ynamagan bo'lsangiz, seriyangiz uzilmasligi uchun yana bir marta yozaman.${linked}\n\n/natija — bugungi holatingiz\n/stop — eslatmalarni o'chirish`, reply_markup: playBtn(client) });
    return;
  }
  if (cmd === "/stop") {
    await env.DB.prepare("UPDATE tg_users SET active = 0 WHERE chat_id = ?").bind(chat).run();
    await tg(env, "sendMessage", { chat_id: chat, text: "Eslatmalar o'chirildi. Qayta yoqish uchun /start bosing." });
    return;
  }
  if (!u) { u = { client: newClient() }; await env.DB.prepare("INSERT OR IGNORE INTO tg_users (chat_id, client, name, active, created) VALUES (?, ?, ?, 1, ?)").bind(chat, u.client, name, Date.now()).run(); }
  if (cmd === "/natija") {
    const day = tzDay(), { streak, todayRec } = await streakOf(env, u.client);
    const agg = await env.DB.prepare("SELECT COUNT(*) AS n, ROUND(AVG(total)) AS avg FROM plays WHERE date = ?").bind(day).first();
    const mine = todayRec != null ? `Bugun ${todayRec} ball oldingiz.` : "Bugun hali o'ynamadingiz.";
    await tg(env, "sendMessage", { chat_id: chat, text: `Sezgir #${puzzleNo(day)}\n${mine}\nSeriya: ${streak} kun${streak ? " 🔥" : ""}\n\nBugun ${agg.n} kishi o'ynadi${agg.n ? `, o'rtacha ball ${agg.avg}` : ""}.`, reply_markup: todayRec == null ? playBtn(u.client) : undefined });
    return;
  }
  await tg(env, "sendMessage", { chat_id: chat, text: "Pastdagi tugma bilan bugungi jumboqni oching.\n\n/natija — bugungi holatingiz\n/stop — eslatmalarni o'chirish", reply_markup: playBtn(u.client) });
}

async function remind(env, evening) {
  const day = tzDay(), no = puzzleNo(day);
  const users = await env.DB.prepare("SELECT chat_id, client FROM tg_users WHERE active = 1").all();
  for (const u of users.results) {
    const { streak, todayRec } = await streakOf(env, u.client);
    let text;
    if (!evening) text = `☀️ Sezgir #${no} tayyor. Bugungi beshta test sizni kutmoqda.${streak ? `\nSeriyangiz: ${streak} kun 🔥` : ""}`;
    else if (todayRec == null && streak > 0) text = `Bugun hali o'ynamadingiz. ${streak} kunlik seriyangiz yarim tunda uziladi 🔥`;
    if (!text) continue;
    const r = await tg(env, "sendMessage", { chat_id: u.chat_id, text, reply_markup: playBtn(u.client) });
    if (!r.ok && r.error_code === 403) await env.DB.prepare("UPDATE tg_users SET active = 0 WHERE chat_id = ?").bind(u.chat_id).run();
    await new Promise(res => setTimeout(res, 40)); // stay under Telegram's ~30 msg/s
  }
}

async function tgSetup(env, origin) {
  const hook = await tg(env, "setWebhook", { url: `${origin}/tg/hook`, secret_token: env.TG_WEBHOOK_SECRET, allowed_updates: ["message"], drop_pending_updates: true });
  const cmds = await tg(env, "setMyCommands", { commands: [{ command: "start", description: "Eslatmalarni yoqish" }, { command: "natija", description: "Bugungi holatim va seriya" }, { command: "stop", description: "Eslatmalarni o'chirish" }] });
  const menu = await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "O'ynash", web_app: { url: SITE } } });
  const desc = await tg(env, "setMyDescription", { description: "Sezgir: har kuni 5 ta qisqa idrok testi, 2 daqiqa. Bot har kuni ertalab yangi jumboqni eslatadi va seriyangizni sanaydi." });
  const sdesc = await tg(env, "setMyShortDescription", { short_description: "Ko'zingiz qanchalik aniq? Har kuni 5 ta test." });
  const me = await tg(env, "getMe", {});
  return { hook: hook.ok, cmds: cmds.ok, menu: menu.ok, desc: desc.ok && sdesc.ok, username: me.result?.username };
}

export default {
  async fetch(req, env) {
    const h = cors(req, env), url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    try {
      if (url.pathname === "/tg/hook" && req.method === "POST") {
        if (!env.TG_BOT_TOKEN || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        const upd = await req.json().catch(() => null);
        if (upd?.message) await onMessage(env, upd.message);
        return new Response("ok");
      }
      if (url.pathname === "/tg/setup" && req.method === "GET") {
        if (!env.TG_BOT_TOKEN || !env.TG_WEBHOOK_SECRET || url.searchParams.get("key") !== env.TG_WEBHOOK_SECRET) return json({ error: "forbidden" }, 403, h);
        return json(await tgSetup(env, url.origin), 200, h);
      }
      if (url.pathname === "/stats" && req.method === "GET") {
        const date = url.searchParams.get("date") || todayAround()[1];
        if (!DATE.test(date)) return json({ error: "bad date" }, 400, h);
        const t = url.searchParams.get("total"); const total = t === null ? undefined : parseInt(t, 10);
        return json(await stats(env, date, total), 200, { ...h, "Cache-Control": "public, max-age=30" });
      }
      if (url.pathname === "/live" && req.method === "GET") return json(await live(env), 200, { ...h, "Cache-Control": "public, max-age=20" });
      if (url.pathname === "/summary" && req.method === "GET") return json(await summary(env, Math.min(Math.max(parseInt(url.searchParams.get("days") || "14", 10) || 14, 7), 60)), 200, { ...h, "Cache-Control": "public, max-age=60" });
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
  async scheduled(event, env, ctx) { // 04:00 UTC = 09:00 Tashkent (morning), 14:00 UTC = 19:00 (evening)
    if (!env.TG_BOT_TOKEN) return;
    ctx.waitUntil(remind(env, event.cron === "0 14 * * *"));
  },
};
