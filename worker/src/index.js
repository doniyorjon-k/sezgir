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
// style: Telegram's coloured buttons (success = green, primary = blue, danger = red); older apps just show a normal button
const playBtn = (client, label = "🎯 O'ynash") => ({ inline_keyboard: [[{ text: label, style: "success", web_app: { url: `${SITE}?cid=${client}` } }]] });

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
  if (!chat) return;
  if (msg.chat.type === "group" || msg.chat.type === "supergroup") return onGroupMessage(env, msg);
  if (msg.chat.type !== "private") return;
  if (msg.successful_payment) return onPaid(env, msg);
  const name = (msg.from?.first_name || "").slice(0, 40);
  const [cmd, arg] = text.split(/\s+/, 2);
  let u = await env.DB.prepare("SELECT * FROM tg_users WHERE chat_id = ?").bind(chat).first();
  if (cmd === "/qollash" || (cmd === "/start" && arg === "qollash")) { const n = cmd === "/qollash" ? parseInt(arg, 10) : 0; return supportMenu(env, chat, n >= 1 && n <= 10000 ? n : 0); }
  if (cmd === "/start" && arg && /^g-?\d{1,20}$/.test(arg)) return joinGroup(env, chat, name, u, Number(arg.slice(1)));
  if (cmd === "/start" && arg && /^v\d{1,5}(_\d{1,3}){5}(_[A-Za-z0-9_-]+)?$/.test(arg)) return openChallenge(env, chat, name, u, arg);
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
  await tg(env, "sendMessage", { chat_id: chat, text: "Pastdagi tugma bilan bugungi jumboqni oching.\n\n/natija — bugungi holatingiz\n/qollash — Sezgir'ni qo'llab-quvvatlash\n/stop — eslatmalarni o'chirish", reply_markup: playBtn(u.client) });
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


// ---------- Support: Telegram Stars donations ----------
const STARS = [5, 10, 20, 50];
const OWNER_ID = 699254555, OWNER = "doniyorjon_k"; // game author: gets a note on each donation
async function invoiceLink(env, stars, anon) {
  const r = await tg(env, "createInvoiceLink", { title: "Sezgir'ni qo'llab-quvvatlash", description: `${stars} ⭐ Sezgir'ga: yangi testlar, server va reklamasiz o'yin uchun. Rahmat!`, payload: `don:${anon ? 1 : 0}`, currency: "XTR", prices: [{ label: "Qo'llab-quvvatlash", amount: stars }] });
  return r.ok ? r.result : null;
}
async function supportMenu(env, chat, n) { // /qollash [N]
  if (n) { const link = await invoiceLink(env, n, false); await tg(env, "sendMessage", { chat_id: chat, text: `${n} ⭐ bilan qo'llab-quvvatlash:`, reply_markup: { inline_keyboard: [[{ text: `⭐ ${n} Stars yuborish`, style: "success", url: link }]] } }); return; }
  const links = await Promise.all(STARS.map(x => invoiceLink(env, x, false)));
  await tg(env, "sendMessage", { chat_id: chat, text: `Sezgir bepul va reklamasiz. Yoqsa, Telegram Stars bilan qo'llab-quvvatlang: yangi testlar va server shu hisobdan bo'ladi 🙏\n\nQo'llab-quvvatlaganlar ismi yonida guruh reytinglarida ⭐ turadi.\nBoshqa miqdor: /qollash 100\nTaklif va savollar: @${OWNER}`, reply_markup: { inline_keyboard: [STARS.slice(0, 2).map((x, i) => ({ text: `⭐ ${x}`, url: links[i] })), STARS.slice(2).map((x, i) => ({ text: `⭐ ${x}`, url: links[i + 2] }))] } });
}
async function onPaid(env, msg) {
  const p = msg.successful_payment; if (p.currency !== "XTR") return;
  const anon = p.invoice_payload === "don:1" ? 1 : 0, name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").slice(0, 40) || "Do'st";
  await env.DB.prepare("INSERT OR IGNORE INTO donations (charge_id, chat_id, name, stars, anon, created) VALUES (?, ?, ?, ?, ?, ?)").bind(p.telegram_payment_charge_id, msg.from.id, name, p.total_amount, anon, Date.now()).run();
  const sum = await env.DB.prepare("SELECT SUM(stars) AS s FROM donations WHERE chat_id = ?").bind(msg.from.id).first();
  if (msg.from.id !== OWNER_ID) await tg(env, "sendMessage", { chat_id: OWNER_ID, text: `💛 Yangi qo'llab-quvvatlash: ${name}${msg.from.username ? ` (@${msg.from.username})` : ""}, ${p.total_amount} ⭐${anon ? " · yashirin" : ""}\nUning jami: ${sum.s} ⭐` });
  await tg(env, "sendMessage", { chat_id: msg.chat.id, text: `Katta rahmat, ${msg.from?.first_name || "do'stim"}! ${p.total_amount} ⭐ qabul qilindi 💛\n\nJami qo'llab-quvvatlovingiz: ${sum.s} ⭐.${anon ? " Ismingiz reytingda ko'rinmaydi." : " Endi guruh reytinglarida ismingiz yonida ⭐ turadi."}` });
}
async function supporters(env) {
  const top = await env.DB.prepare("SELECT chat_id, MAX(anon) AS anon, MAX(name) AS name, SUM(stars) AS stars, MAX(created) AS last FROM donations GROUP BY chat_id ORDER BY stars DESC, last ASC LIMIT 10").all();
  const agg = await env.DB.prepare("SELECT COUNT(DISTINCT chat_id) AS people, COALESCE(SUM(stars), 0) AS stars FROM donations").first();
  return { people: agg.people, stars: agg.stars, top: top.results.map(r => ({ name: r.anon ? null : r.name, stars: r.stars })) };
}

// ---------- Telegram groups: shared daily leaderboard ----------
const BOT_USER = "sezgiruz_bot";
const gradeOf = s => s >= 95 ? "A+" : s >= 88 ? "A" : s >= 80 ? "B+" : s >= 70 ? "B" : s >= 62 ? "C+" : s >= 55 ? "C" : s >= 40 ? "D" : "F";
const joinBtn = gid => ({ inline_keyboard: [[{ text: "🏆 Qatnashish", style: "primary", url: `https://t.me/${BOT_USER}?start=g${gid}` }]] });
const MEDALS = ["🥇", "🥈", "🥉"];

async function groupBoard(env, gid, day) { // members who played `day`, best first; plus members who did not
  const rows = await env.DB.prepare("SELECT u.chat_id, u.name, p.total, p.created, EXISTS(SELECT 1 FROM donations d WHERE d.chat_id = u.chat_id AND d.anon = 0) AS sup FROM tg_members m JOIN tg_users u ON u.chat_id = m.user_id LEFT JOIN plays p ON p.client = u.client AND p.date = ? WHERE m.group_id = ?").bind(day, gid).all();
  const played = rows.results.filter(r => r.total != null).sort((a, b) => b.total - a.total || a.created - b.created);
  const idle = rows.results.filter(r => r.total == null);
  return { played, idle, members: rows.results.length };
}
function boardText(title, day, b) {
  if (!b.played.length) return null;
  const lines = b.played.map((r, i) => `${MEDALS[i] || `${i + 1}.`} ${r.name || "O'yinchi"}${r.sup ? " ⭐" : ""}, ${gradeOf(r.total)} · ${r.total}`);
  const idle = b.idle.length ? `\n\nHali o'ynamaganlar: ${b.idle.map(r => r.name || "O'yinchi").join(", ")} 👀` : "";
  return `${title}\n\n${lines.join("\n")}${idle}`;
}

async function joinGroup(env, chat, name, u, gid) {
  const g = await env.DB.prepare("SELECT * FROM tg_groups WHERE chat_id = ? AND active = 1").bind(gid).first();
  if (!g) { await tg(env, "sendMessage", { chat_id: chat, text: "Bu guruh topilmadi. Botni guruhga qayta qo'shib ko'ring." }); return; }
  const client = u?.client || newClient();
  await env.DB.prepare("INSERT INTO tg_users (chat_id, client, name, active, created) VALUES (?, ?, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name").bind(chat, client, name, Date.now()).run();
  const fresh = await env.DB.prepare("INSERT OR IGNORE INTO tg_members (group_id, user_id, joined) VALUES (?, ?, ?)").bind(gid, chat, Date.now()).run();
  await tg(env, "sendMessage", { chat_id: chat, text: `Siz «${g.title}» guruhi reytingiga qo'shildingiz ✅\n\nO'ynaganingizdan keyin natijangiz guruhda ko'rinadi. Har kuni 21:00 da bot guruhga kunlik reytingni yozadi.\n\nMuhim: natija hisobga olinishi uchun pastdagi tugma orqali o'ynang.`, reply_markup: playBtn(client) });
  if (fresh.meta?.changes) await tg(env, "sendMessage", { chat_id: gid, text: `${name || "Yangi o'yinchi"} reytingga qo'shildi 👋` });
}

function unb64url(b) { try { const bin = atob(b.replace(/-/g, "+").replace(/_/g, "/")); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))).replace(/[<>]/g, "").trim().slice(0, 24); } catch { return ""; } }
async function openChallenge(env, chat, name, u, arg) { // friend's link shared from inside Telegram: t.me/<bot>?start=v<no>_<s1..s5>_<name>
  const parts = arg.slice(1).split("_"), no = Number(parts[0]), scores = parts.slice(1, 6).map(Number), who = unb64url(parts.slice(6).join("_")) || "Do'stingiz";
  const client = u?.client || newClient();
  await env.DB.prepare("INSERT INTO tg_users (chat_id, client, name, active, created) VALUES (?, ?, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, active = 1").bind(chat, client, name, Date.now()).run();
  const today = puzzleNo(tzDay());
  if (no !== today || scores.some(x => x > 100)) { await tg(env, "sendMessage", { chat_id: chat, text: `Bu chaqiruv eski (#${no}). Bugungi Sezgir #${today}ni o'ynab ko'ring!`, reply_markup: playBtn(client) }); return; }
  const total = Math.round(scores.reduce((a, b) => a + b, 0) / 5);
  const url = `${SITE}?cid=${client}&vs=${[no, ...scores].join(".")}&n=${encodeURIComponent(who)}`;
  await tg(env, "sendMessage", { chat_id: chat, text: `${who} sizni Sezgir'ga chaqirdi 🎯\n\nBugun u ${gradeOf(total)} · ${total} ball oldi. Undan o'ta olasizmi? O'ynab bo'lgach natijalaringiz yonma-yon chiqadi.\n\nHar kuni 9:00 da yangi jumboq haqida eslatib turaman (/stop bilan o'chiriladi).`, reply_markup: { inline_keyboard: [[{ text: "🎯 Qabul qilaman", style: "success", web_app: { url } }]] } });
}

async function onGroupMessage(env, msg) {
  const gid = msg.chat.id, text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(`@${BOT_USER}`, "");
  if (msg.migrate_to_chat_id) { await env.DB.prepare("UPDATE tg_groups SET chat_id = ? WHERE chat_id = ?").bind(msg.migrate_to_chat_id, gid).run(); await env.DB.prepare("UPDATE tg_members SET group_id = ? WHERE group_id = ?").bind(msg.migrate_to_chat_id, gid).run(); return; }
  if (!cmd.startsWith("/")) return;
  await env.DB.prepare("INSERT INTO tg_groups (chat_id, title, active, created) VALUES (?, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, active = 1").bind(gid, (msg.chat.title || "Guruh").slice(0, 60), Date.now()).run();
  if (cmd === "/reyting") {
    const day = tzDay(), b = await groupBoard(env, gid, day);
    const t = boardText(`Sezgir #${puzzleNo(day)} · bugungi reyting`, day, b);
    await tg(env, "sendMessage", { chat_id: gid, text: t || (b.members ? "Bugun hali hech kim o'ynamadi. Birinchi bo'ling!" : "Reytingda hali hech kim yo'q. Qatnashish uchun tugmani bosing."), reply_markup: joinBtn(gid) });
    return;
  }
  if (cmd === "/qatnashish") await tg(env, "sendMessage", { chat_id: gid, text: "Guruh reytingiga qo'shilish uchun tugmani bosing. Bot sizga shaxsiy xabarda o'yin havolasini yuboradi.", reply_markup: joinBtn(gid) });
}

async function onMyChatMember(env, upd) {
  const chat = upd.chat; if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const st = upd.new_chat_member?.status;
  if (st === "member" || st === "administrator") {
    await env.DB.prepare("INSERT INTO tg_groups (chat_id, title, active, created) VALUES (?, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, active = 1").bind(chat.id, (chat.title || "Guruh").slice(0, 60), Date.now()).run();
    if (upd.old_chat_member?.status === "left" || upd.old_chat_member?.status === "kicked")
      await tg(env, "sendMessage", { chat_id: chat.id, text: `Salom, «${chat.title || "guruh"}»! Men Sezgir botiman 👋\n\nHar kuni 5 ta qisqa idrok testi. Kim o'ynasa, natijasini shu yerga yozaman, 21:00 da esa kunlik reytingni chiqaraman. Yakshanba kuni haftaning g'olibini e'lon qilaman.\n\nQatnashish uchun pastdagi tugmani bosing.\n/reyting — bugungi reyting`, reply_markup: joinBtn(chat.id) });
  } else if (st === "left" || st === "kicked") await env.DB.prepare("UPDATE tg_groups SET active = 0 WHERE chat_id = ?").bind(chat.id).run();
}

async function announcePlay(env, client, date, total) { // "Aziz o'ynadi" in each of the player's groups
  if (!env.TG_BOT_TOKEN || date !== tzDay()) return;
  const rows = await env.DB.prepare("SELECT g.chat_id AS gid, u.name, u.chat_id AS uid FROM tg_users u JOIN tg_members m ON m.user_id = u.chat_id JOIN tg_groups g ON g.chat_id = m.group_id AND g.active = 1 WHERE u.client = ?").bind(client).all();
  for (const r of rows.results) {
    const b = await groupBoard(env, r.gid, date); const rank = b.played.findIndex(p => p.chat_id === r.uid) + 1;
    await tg(env, "sendMessage", { chat_id: r.gid, text: `${r.name || "O'yinchi"} o'ynadi: ${gradeOf(total)} · ${total} ball${rank ? ` (hozircha ${rank}-o'rin, ${b.played.length} kishidan)` : ""}` });
  }
}

async function postBoards(env) { // 21:00 Tashkent: daily board; on Sunday also the week's winner
  const day = tzDay(), sunday = new Date(day + "T12:00:00Z").getUTCDay() === 0;
  const groups = await env.DB.prepare("SELECT chat_id, title FROM tg_groups WHERE active = 1").all();
  for (const g of groups.results) {
    const b = await groupBoard(env, g.chat_id, day);
    const t = boardText(`Sezgir #${puzzleNo(day)} · kun yakuni`, day, b);
    if (t) { const r = await tg(env, "sendMessage", { chat_id: g.chat_id, text: t + "\n\nErtaga 9:00 da yangi jumboq.", reply_markup: joinBtn(g.chat_id) }); if (!r.ok && (r.error_code === 403 || r.error_code === 400)) { await env.DB.prepare("UPDATE tg_groups SET active = 0 WHERE chat_id = ?").bind(g.chat_id).run(); continue; } }
    if (sunday) {
      const from = shiftDay(day, -6);
      const w = await env.DB.prepare("SELECT u.name, SUM(p.total) AS sum, COUNT(*) AS days FROM tg_members m JOIN tg_users u ON u.chat_id = m.user_id JOIN plays p ON p.client = u.client AND p.date BETWEEN ? AND ? WHERE m.group_id = ? GROUP BY u.chat_id ORDER BY sum DESC LIMIT 5").bind(from, day, g.chat_id).all();
      if (w.results.length) await tg(env, "sendMessage", { chat_id: g.chat_id, text: `🏆 Haftaning g'olibi: ${w.results[0].name || "O'yinchi"}!\n\n${w.results.map((r, i) => `${MEDALS[i] || `${i + 1}.`} ${r.name || "O'yinchi"}: ${r.sum} ball (${r.days} kun)`).join("\n")}\n\nHaftalik hisob: 7 kunlik ballar yig'indisi, shuning uchun har kuni o'ynash muhim.` });
    }
    await new Promise(res => setTimeout(res, 50));
  }
}

async function myGroups(env, client, date) { // for the site: "guruhingizda N-o'rindasiz"
  const rows = await env.DB.prepare("SELECT g.chat_id AS gid, g.title, u.chat_id AS uid FROM tg_users u JOIN tg_members m ON m.user_id = u.chat_id JOIN tg_groups g ON g.chat_id = m.group_id AND g.active = 1 WHERE u.client = ?").bind(client).all();
  const out = [];
  for (const r of rows.results.slice(0, 5)) { const b = await groupBoard(env, r.gid, date); const i = b.played.findIndex(p => p.chat_id === r.uid); out.push({ title: r.title, rank: i >= 0 ? i + 1 : null, played: b.played.length, members: b.members, leader: b.played[0] ? { name: b.played[0].name, total: b.played[0].total } : null }); }
  return out;
}

async function tgSetup(env, origin) {
  const hook = await tg(env, "setWebhook", { url: `${origin}/tg/hook`, secret_token: env.TG_WEBHOOK_SECRET, allowed_updates: ["message", "my_chat_member", "pre_checkout_query"], drop_pending_updates: true });
  const cmds = await tg(env, "setMyCommands", { commands: [{ command: "start", description: "Eslatmalarni yoqish" }, { command: "natija", description: "Bugungi holatim va seriya" }, { command: "qollash", description: "Sezgir'ni qo'llab-quvvatlash ⭐" }, { command: "stop", description: "Eslatmalarni o'chirish" }] });
  await tg(env, "setMyCommands", { scope: { type: "all_group_chats" }, commands: [{ command: "reyting", description: "Bugungi guruh reytingi" }, { command: "qatnashish", description: "Reytingga qo'shilish" }] });
  const menu = await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "O'ynash", web_app: { url: SITE } } });
  const desc = await tg(env, "setMyDescription", { description: "Sezgir: har kuni 5 ta qisqa idrok testi, 2 daqiqa. Bot har kuni ertalab yangi jumboqni eslatadi va seriyangizni sanaydi." });
  const sdesc = await tg(env, "setMyShortDescription", { short_description: "Ko'zingiz qanchalik aniq? Har kuni 5 ta test." });
  const me = await tg(env, "getMe", {}), owner = await tg(env, "getChat", { chat_id: OWNER_ID });
  return { owner: owner.result?.username === OWNER, hook: hook.ok, cmds: cmds.ok, menu: menu.ok, desc: desc.ok && sdesc.ok, username: me.result?.username };
}

// Telegram Mini App initData check (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
async function hmac(key, msg) { const k = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg))); }
async function tgUser(env, initData) {
  const q = new URLSearchParams(initData || ""), hash = q.get("hash"); if (!hash) return null; q.delete("hash");
  const dcs = [...q.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join("\n");
  const sig = [...await hmac(await hmac("WebAppData", env.TG_BOT_TOKEN), dcs)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (sig !== hash) return null;
  if (Date.now() / 1000 - Number(q.get("auth_date") || 0) > 90 * 86400) return null; // stale session
  try { const u = JSON.parse(q.get("user") || "null"); return u && Number.isInteger(u.id) ? u : null; } catch { return null; }
}
// The bot's menu button opens the site without ?cid=, so the Mini App asks which site client belongs to this Telegram user.
async function whoami(env, initData, client) {
  const u = await tgUser(env, initData); if (!u) return null;
  const row = await env.DB.prepare("SELECT client FROM tg_users WHERE chat_id = ?").bind(u.id).first();
  if (row) return row.client;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").slice(0, 60) || "Do'st";
  await env.DB.prepare("INSERT OR IGNORE INTO tg_users (chat_id, client, name, active, created) VALUES (?, ?, ?, 0, ?)").bind(u.id, client, name, Date.now()).run();
  return client;
}
export default {
  async fetch(req, env, ctx) {
    const h = cors(req, env), url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    try {
      if (url.pathname === "/tg/hook" && req.method === "POST") {
        if (!env.TG_BOT_TOKEN || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        const upd = await req.json().catch(() => null);
        if (upd?.message) await onMessage(env, upd.message);
        else if (upd?.my_chat_member) await onMyChatMember(env, upd.my_chat_member);
        else if (upd?.pre_checkout_query) { const q = upd.pre_checkout_query; await tg(env, "answerPreCheckoutQuery", { pre_checkout_query_id: q.id, ok: q.currency === "XTR" && /^don:[01]$/.test(q.invoice_payload), error_message: "To'lovni qabul qilib bo'lmadi, qayta urinib ko'ring." }); }
        return new Response("ok");
      }
      if (url.pathname === "/tg/setup" && req.method === "GET") {
        if (!env.TG_BOT_TOKEN || !env.TG_WEBHOOK_SECRET || url.searchParams.get("key") !== env.TG_WEBHOOK_SECRET) return json({ error: "forbidden" }, 403, h);
        return json(await tgSetup(env, url.origin), 200, h);
      }
      if (url.pathname === "/tg/whoami" && req.method === "POST") {
        const b = await req.json().catch(() => null);
        if (!env.TG_BOT_TOKEN || !b || typeof b.initData !== "string" || !CLIENT.test(b.client)) return json({ error: "bad body" }, 400, h);
        const client = await whoami(env, b.initData, b.client);
        return client ? json({ client }, 200, h) : json({ error: "forbidden" }, 403, h);
      }
      if (url.pathname === "/support/invoice" && req.method === "POST") {
        const b = await req.json().catch(() => null), n = Number(b?.stars);
        if (!env.TG_BOT_TOKEN || !Number.isInteger(n) || n < 1 || n > 10000) return json({ error: "bad body" }, 400, h);
        const link = await invoiceLink(env, n, !!b.anon);
        return link ? json({ link }, 200, h) : json({ error: "telegram" }, 502, h);
      }
      if (url.pathname === "/support" && req.method === "GET") return json(await supporters(env), 200, { ...h, "Cache-Control": "public, max-age=30" });
      if (url.pathname === "/stats" && req.method === "GET") {
        const date = url.searchParams.get("date") || todayAround()[1];
        if (!DATE.test(date)) return json({ error: "bad date" }, 400, h);
        const t = url.searchParams.get("total"); const total = t === null ? undefined : parseInt(t, 10);
        return json(await stats(env, date, total), 200, { ...h, "Cache-Control": "public, max-age=30" });
      }
      if (url.pathname === "/mygroups" && req.method === "GET") {
        const client = url.searchParams.get("client") || "", date = url.searchParams.get("date") || tzDay();
        if (!CLIENT.test(client) || !DATE.test(date)) return json({ error: "bad query" }, 400, h);
        return json({ groups: await myGroups(env, client, date) }, 200, h);
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
        const ins = await env.DB.prepare("INSERT OR IGNORE INTO plays (date, client, total, scores, created) VALUES (?, ?, ?, ?, ?)").bind(b.date, b.client, total, JSON.stringify(scores), Date.now()).run();
        if (ins.meta?.changes) ctx.waitUntil(announcePlay(env, b.client, b.date, total).catch(() => {}));
        return json(await stats(env, b.date, total), 200, h);
      }
      return json({ error: "not found" }, 404, h);
    } catch (e) { return json({ error: "server error" }, 500, h); }
  },
  async scheduled(event, env, ctx) { // 04:00 UTC = 09:00 Tashkent (morning), 14:00 UTC = 19:00 (evening), 16:00 UTC = 21:00 (group boards)
    if (!env.TG_BOT_TOKEN) return;
    if (event.cron === "0 16 * * *") ctx.waitUntil(postBoards(env));
    else ctx.waitUntil(remind(env, event.cron === "0 14 * * *"));
  },
};
