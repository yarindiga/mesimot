// עדכוני סטטוס של משימות. נשמר כאן, ובנוסף נדחף מיד למאנדיי (עמודת "בוצע?"
// ותוספת שורה מתוארכת ל"סטטוס הפרויקט") — ראו pushToMonday למטה.
import { getStore } from "@netlify/blobs";
import { OWNERS } from "../shared/_owners.mjs";

// טבלת המשתמשים מגיעה ממשתנה סביבה, לא מהקוד — כדי שהמאגר לא יכיל סודות.
const USERS = JSON.parse(process.env.APP_USERS || "{}");
const MONDAY_TOKEN = process.env.MONDAY_TOKEN || "";
const BOARD_ID = 5094207356;
const COL_STATUS = "color_mm257nb8"; // "בוצע?"
const COL_PSTAT  = "text_mm2zk6cp";  // "סטטוס הפרויקט"

const ALLOWED = new Set(["בטיפול", "בוצע"]);
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// D.M בלי אפסים מובילים ובלי שנה, כמו הרישומים הקיימים ב"סטטוס הפרויקט".
function heDate(ts) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem", day: "numeric", month: "numeric",
  }).formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("day")}.${get("month")}`;
}

async function mondayApi(query, variables) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: MONDAY_TOKEN,
      "Content-Type": "application/json",
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

// מעדכן את עמודת הסטטוס, ואם יש הערה — מוסיף אותה (מתוארכת) בסוף "סטטוס הפרויקט".
// אף פעם לא מוחק או דורס תוכן קיים בעמודת הטקסט, רק מוסיף בסופה.
async function pushToMonday(taskId, status, note, at) {
  await mondayApi(
    `mutation($b: ID!, $i: ID!, $c: String!, $v: JSON!) {
       change_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v) { id }
     }`,
    { b: BOARD_ID, i: taskId, c: COL_STATUS, v: JSON.stringify({ label: status }) }
  );

  if (!note) return;

  const cur = await mondayApi(
    `query($i: [ID!]) {
       items(ids: $i) { column_values(ids: ["${COL_PSTAT}"]) { text } }
     }`,
    { i: [taskId] }
  );
  const existing = cur.items?.[0]?.column_values?.[0]?.text || "";
  const entry = `${heDate(at)}\n${note}`;
  const updated = existing ? `${existing}\n\n${entry}` : entry;

  await mondayApi(
    `mutation($b: ID!, $i: ID!, $c: String!, $v: String!) {
       change_simple_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v) { id }
     }`,
    { b: BOARD_ID, i: taskId, c: COL_PSTAT, v: updated }
  );
}

export default async (req) => {
  const store = getStore({ name: "task-updates", consistency: "strong" });

  if (req.method === "GET") {
    const who = USERS[new URL(req.url).searchParams.get("t") || ""];
    if (!who) return json({ error: "unauthorized" }, 401);

    const { blobs } = await store.list();
    const updates = [];
    const allMarks = [];
    const logKeys = [];
    let clearedAt = 0;
    for (const b of blobs) {
      if (b.key === "_clearedAt") {
        const rec = await store.get(b.key, { type: "json" });
        clearedAt = (rec && rec.at) || 0;
        continue;
      }
      // פורמט ישן: מערך יחיד תחת מפתח "_log" — היה חשוף למירוץ כתיבה כשכמה עדכונים
      // מגיעים קרוב זה לזה (כל POST קורא-משנה-כותב את כל המערך, והאחרון מנצח ומוחק את הקודם).
      // מיגרציה חד-פעמית: כל רשומה עוברת למפתח נפרד, והמפתח הישן נמחק.
      if (b.key === "_log") {
        const legacy = (await store.get(b.key, { type: "json" })) || [];
        for (const item of legacy) {
          if (item && item.taskId) await store.setJSON(`_log_${item.at}_${item.taskId}`, item);
        }
        await store.delete(b.key);
        continue;
      }
      if (b.key.startsWith("_log_")) { logKeys.push(b.key); continue; }
      const rec = await store.get(b.key, { type: "json" });
      if (!rec) continue;
      const item = { taskId: b.key, ...rec };
      allMarks.push(item);
      if (who.admin || rec.byId === who.id) updates.push(item);
    }
    updates.sort((a, b) => (b.at || 0) - (a.at || 0));
    const resp = { updates };
    // רק המנהל צריך את היסטוריית-הכול ואת חותם הניקוי — לצוות מספיק המצב הנוכחי.
    if (who.admin) {
      resp.clearedAt = clearedAt;
      const history = (await Promise.all(logKeys.map((k) => store.get(k, { type: "json" })))).filter(Boolean);

      // השלמה: סימון שקיים אבל אין לו רישום בלוג (נוצר לפני שהלוג היה קיים, או אבד
      // בבאג הדריסה הישן) נכנס להיסטוריה עכשיו — עם ההערה שנכתבה — ונשמר לתמיד.
      const logged = new Set(history.map((h) => h.taskId + "_" + h.at));
      const missing = allMarks.filter((m) => !logged.has(m.taskId + "_" + m.at));
      for (const m of missing) await store.setJSON(`_log_${m.at}_${m.taskId}`, m);

      resp.history = history.concat(missing).sort((a, b) => (b.at || 0) - (a.at || 0));
    }
    return json(resp);
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const who = USERS[body.t || ""];
    if (!who) return json({ error: "unauthorized" }, 401);

    // "ניקוי" מסך העדכונים אצל המנהל — לא נוגע בסטטוס האמיתי של אף משימה,
    // רק מסמן חותם זמן שממנו מציגים "עדכונים" כברירת מחדל. ההיסטוריה המלאה נשארת.
    if (body.clear === true) {
      if (!who.admin) return json({ error: "forbidden" }, 403);
      const at = Date.now();
      await store.setJSON("_clearedAt", { at });
      return json({ ok: true, clearedAt: at });
    }

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

    // דחיפה מיידית למאנדיי. אם היא נכשלת, הסימון באתר נשמר בכל זאת —
    // ורק מסומן כלא-נדחף, כדי שלא ליפול על שגיאת רשת מול מאנדיי.
    if (MONDAY_TOKEN) {
      try {
        await pushToMonday(taskId, rec.status, rec.note, rec.at);
        rec.pushedToMonday = true;
      } catch (e) {
        rec.pushedToMonday = false;
        rec.pushError = String(e?.message || e).slice(0, 300);
        console.error("Monday push failed for", taskId, rec.pushError);
      }
    } else {
      rec.pushedToMonday = false;
    }

    await store.setJSON(taskId, rec);

    // לוג היסטוריה שלא נדרס — כל רשומה במפתח נפרד משלה (לא מערך משותף אחד),
    // כדי שכמה עדכונים שמגיעים קרוב זה לזה לא ידרסו אחד את השני.
    try {
      await store.setJSON(`_log_${rec.at}_${taskId}`, { taskId, ...rec });
    } catch (_) { /* לוג הוא נחמד-להיות, לא קריטי — לא נופלים בגללו */ }

    return json({ ok: true, rec });
  }

  return json({ error: "method_not_allowed" }, 405);
};
