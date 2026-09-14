// עדכוני סטטוס של משימות. נשמר כאן בלבד — לעולם לא נכתב חזרה למאנדיי.
import { getStore } from "@netlify/blobs";
import { USERS, OWNERS } from "./_data.mjs";

const ALLOWED = new Set(["בטיפול", "בוצע"]);
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export default async (req) => {
  const store = getStore({ name: "task-updates", consistency: "strong" });

  if (req.method === "GET") {
    const who = USERS[new URL(req.url).searchParams.get("t") || ""];
    if (!who) return json({ error: "unauthorized" }, 401);

    const { blobs } = await store.list();
    const updates = [];
    for (const b of blobs) {
      const rec = await store.get(b.key, { type: "json" });
      if (!rec) continue;
      if (who.admin || rec.byId === who.id) updates.push({ taskId: b.key, ...rec });
    }
    updates.sort((a, b) => (b.at || 0) - (a.at || 0));
    return json({ updates });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const who = USERS[body.t || ""];
    if (!who) return json({ error: "unauthorized" }, 401);

    const taskId = String(body.taskId || "");
    if (!/^[0-9]{1,20}$/.test(taskId)) return json({ error: "bad_task" }, 400);
    // אף אחד לא מעדכן משימה של מישהו אחר
    if (!who.admin && OWNERS[taskId] !== who.id) return json({ error: "not_yours" }, 403);

    if (body.status === null) {
      await store.delete(taskId);
      return json({ ok: true, cleared: true });
    }
    if (!ALLOWED.has(body.status)) return json({ error: "bad_status" }, 400);

    const rec = {
      status: body.status,
      note: String(body.note || "").slice(0, 500),
      addr: String(body.addr || "").slice(0, 120),
      byId: who.id,
      byName: who.name,
      at: Date.now(),
    };
    await store.setJSON(taskId, rec);
    return json({ ok: true, rec });
  }

  return json({ error: "method_not_allowed" }, 405);
};
