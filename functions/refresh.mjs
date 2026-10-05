// רענון חי (קריאה בלבד ממאנדיי) שמשודר לכולם.
//
// שני מצבים על אותו נתיב:
// - trigger=1 (רק מנהל): שולח למאנדיי GraphQL query בלבד, ושומר את התוצאה
//   כ"שידור" משותף ב-Netlify Blobs (store בשם live-tasks, מפתח יחיד "latest").
//   זו הפעולה היחידה שבאמת פונה למאנדיי — ורק מנהל יכול להפעיל אותה.
// - בלי trigger (כל משתמש מחובר): קריאה פסיבית בלבד — מחזירה את מה שכבר
//   שודר, בלי לגעת במאנדיי. כל משתמש מקבל רק את המשימות שלו; מנהל מקבל הכל.
//
// baseline הוא חותם הסנכרון המלא (DATA.syncedAt) שהדף של המבקש נבנה ממנו.
// אם הוא לא תואם לזה שנשמר בשידור — סימן שבינתיים רץ סנכרון מלא חדש, והשידור
// נחשב מיושן ומתעלמים ממנו, כדי שלא יידרוס נתונים טריים יותר.
//
// לא נוגע ב-users.json/keys.json ולא בבלובים המוצפנים של אף משתמש. שיוך
// משימה→בעלים מגיע בעיקרון מ-shared/_owners.mjs (כפי שנוצר בסנכרון המלא
// האחרון) — אבל אם עמודת האימייל של המשימה במאנדיי השתנתה מאז (המשימה
// הועברה לאחראי אחר), היא מזוהה דרך OWNER_BY_EMAIL_HASH (ראו resolveOwner
// למטה) והמשימה "זזה" לבעלים הנכון כבר ברענון החי, בלי לחכות לסנכרון המלא.
// משימה חדשה לגמרי, שהאימייל שלה לא מזוהה בכלל, עדיין ממתינה לסנכרון היומי.
import { getStore } from "@netlify/blobs";
import { OWNERS } from "../shared/_owners.mjs";

const USERS = JSON.parse(process.env.APP_USERS || "{}");
const MONDAY_TOKEN = process.env.MONDAY_TOKEN || "";
const BOARD_ID = 5094207356;
const COL_EMAIL = "email_mm2bvkpj";
const COL_DATE  = "date_mm2z4a07";
const COL_TASK  = "text_mm2zjggr";
const COL_TYPE  = "color_mm2xvme0";
const COL_NOTES = "text_mm2z594d";
const COL_PSTAT = "text_mm2zk6cp";

// { salt, map: { hash(email) -> blobId } } — נדחף על ידי build_site.py בכל
// בנייה. ה-hash זהה בדיוק ל-uid() שבאתר (sha256(salt + ":" + email)[:32]):
// לא אימייל גלוי, ולא מפתח חדש — salt כבר נשלח ללקוח בתוך bundle.siteSalt.
const OWNER_HASH = (() => {
  try { return JSON.parse(process.env.OWNER_BY_EMAIL_HASH || "null"); }
  catch (_) { return null; }
})();

const QUERY = `
  query($cursor: String) {
    boards(ids: [${BOARD_ID}]) {
      items_page(limit: 100, cursor: $cursor) {
        cursor
        items {
          id
          name
          group { title }
          column_values(ids: ["${COL_EMAIL}","${COL_DATE}","${COL_TASK}","${COL_TYPE}","${COL_NOTES}","${COL_PSTAT}"]) { id text }
        }
      }
    }
  }
`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function tidy(text) {
  return (text || "").replace(/\n{3,}/g, "\n\n").trim();
}

// 'הרב קוק 10, ראשון' -> ['הרב קוק 10', 'ראשון']; בלי פסיק — השם נשאר שלם.
// זהה ל-split_city שב-build_site.py.
function splitCity(name) {
  const i = name.lastIndexOf(", ");
  return i === -1 ? [name.trim(), ""] : [name.slice(0, i).trim(), name.slice(i + 2).trim()];
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

async function fetchItems() {
  let items = [], cursor = null;
  for (;;) {
    const data = await mondayApi(QUERY, { cursor });
    const page = data.boards[0].items_page;
    items = items.concat(page.items);
    cursor = page.cursor;
    if (!cursor) return items;
  }
}

function colMap(item) {
  const col = {};
  for (const c of item.column_values) col[c.id] = tidy(c.text);
  return col;
}

function toTask(idx, item, col) {
  const [addr, city] = splitCity(item.name);
  return {
    id: item.id, ord: idx, group: item.group.title,
    name: item.name, addr, city,
    date: col[COL_DATE] || "", type: col[COL_TYPE] || "",
    desc: col[COL_TASK] || "", notes: col[COL_NOTES] || "",
    pstatus: col[COL_PSTAT] || "",
  };
}

// זהה ל-uid() שב-build_site.py: sha256(salt + ":" + email), 32 תווי hex ראשונים.
async function uidHash(email, salt) {
  const data = new TextEncoder().encode(salt + ":" + email);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// עדיפות לשיוך החי (לפי עמודת האימייל כרגע במאנדיי); אם האימייל ריק או לא
// מזוהה אצל אף משתמש, נופלים חזרה לשיוך הסטטי מהסנכרון המלא האחרון.
async function resolveOwner(item, col) {
  const liveEmail = (col[COL_EMAIL] || "").toLowerCase();
  if (liveEmail && OWNER_HASH && OWNER_HASH.map) {
    const h = await uidHash(liveEmail, OWNER_HASH.salt);
    const liveOwnerId = OWNER_HASH.map[h];
    if (liveOwnerId) return liveOwnerId;
  }
  return OWNERS[item.id] || null;
}

async function liveFetch() {
  const raw = await fetchItems();

  // כל בעלים שמופיע ב-OWNERS מקבל מערך — גם ריק — כדי שמי שסיים את כל
  // המשימות שלו יתרוקן בצד הלקוח ולא יישאר עם רשימה ישנה.
  const byOwner = {};
  for (const ownerId of new Set(Object.values(OWNERS))) byOwner[ownerId] = [];

  let newCount = 0;
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const col = colMap(item);
    const ownerId = await resolveOwner(item, col);
    if (!ownerId) { newCount++; continue; }
    if (!byOwner[ownerId]) byOwner[ownerId] = [];
    byOwner[ownerId].push(toTask(i, item, col));
  }

  return { byOwner, newCount };
}

function nowSyncedAt() {
  const now = new Date();
  return (
    new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "numeric", month: "numeric", year: "numeric" }).format(now) +
    " בשעה " +
    new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false }).format(now)
  );
}

export default async (req) => {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const who = USERS[url.searchParams.get("t") || ""];
  if (!who) return json({ error: "unauthorized" }, 401);

  const baseline = url.searchParams.get("baseline") || "";
  const trigger = url.searchParams.get("trigger") === "1";
  const store = getStore({ name: "live-tasks", consistency: "strong" });

  if (trigger) {
    if (!who.admin) return json({ error: "forbidden" }, 403);
    if (!MONDAY_TOKEN) return json({ error: "no_token" }, 500);

    let live;
    try {
      live = await liveFetch();
    } catch (e) {
      return json({ error: "monday_fetch_failed", detail: String(e?.message || e).slice(0, 300) }, 502);
    }

    const syncedAt = nowSyncedAt();
    try {
      await store.setJSON("latest", { byOwner: live.byOwner, syncedAt, baseline, at: Date.now() });
    } catch (_) { /* השידור הוא נחמד-להיות — אם הוא נכשל, המנהל עדיין מקבל תשובה מיידית */ }

    return json({ ok: true, syncedAt, byOwner: live.byOwner, newCount: live.newCount });
  }

  // קריאה פסיבית — בלי מאנדיי, רק מה שכבר שודר.
  let snap;
  try {
    snap = await store.get("latest", { type: "json" });
  } catch (_) {
    snap = null;
  }
  if (!snap || snap.baseline !== baseline) return json({ ok: true, stale: true });

  const byOwner = who.admin ? snap.byOwner : { [who.id]: snap.byOwner[who.id] || [] };
  return json({ ok: true, syncedAt: snap.syncedAt, byOwner });
};
