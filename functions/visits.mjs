// יומן כניסות — מתי כל אחראי נכנס לאתר. נראה רק למנהל (ירין), במסך "כניסות".
// נשמר ב-Netlify Blobs, שבוע אחרון בלבד — רשומה ישנה יותר נמחקת בכל קריאה.
//
// אותו דפוס אימות כמו functions/updates.mjs: אסימון כתיבה (t) מצביע ל-APP_USERS
// (נדחף על ידי build_site.py), בלי אימייל/סיסמה גלויים בשום שלב.
import { getStore } from "@netlify/blobs";

const USERS = JSON.parse(process.env.APP_USERS || "{}");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export default async (req) => {
  const store = getStore({ name: "login-visits", consistency: "strong" });
  const cutoff = Date.now() - WEEK_MS;

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const who = USERS[body.t || ""];
    if (!who) return json({ error: "unauthorized" }, 401);

    const at = Date.now();
    await store.setJSON(`${at}_${who.id}`, { id: who.id, name: who.name, at });

    // ניקוי רשומות מהשבוע שעבר ואילך, כדי שהמאגר לא יגדל ללא גבול.
    const { blobs } = await store.list();
    for (const b of blobs) {
      const ts = Number(b.key.split("_")[0]);
      if (!ts || ts < cutoff) await store.delete(b.key);
    }

    return json({ ok: true });
  }

  if (req.method === "GET") {
    const who = USERS[new URL(req.url).searchParams.get("t") || ""];
    if (!who) return json({ error: "unauthorized" }, 401);
    if (!who.admin) return json({ error: "forbidden" }, 403);

    const { blobs } = await store.list();
    const visits = (await Promise.all(
      blobs
        .filter((b) => Number(b.key.split("_")[0]) >= cutoff)
        .map((b) => store.get(b.key, { type: "json" }))
    )).filter(Boolean);
    visits.sort((a, b) => (b.at || 0) - (a.at || 0));

    return json({ visits });
  }

  return json({ error: "method_not_allowed" }, 405);
};
