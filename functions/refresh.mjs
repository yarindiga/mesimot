// רענון חי (קריאה בלבד) של המשימות ממאנדיי — למנהל בלבד, לשימוש כשרוצים לעדכן
// באמצע היום בלי לחכות לסנכרון האוטומטי. לא נוגע ב-users.json/keys.json ולא
// בבלובים המוצפנים של אף משתמש — רק שולף מחדש את תוכן המשימות שכבר ידועות
// (מיפוי משימה→בעלים מגיע מ-shared/_owners.mjs, כפי שנוצר בסנכרון המלא
// האחרון). משימה שנוצרה במאנדיי אחרי הסנכרון המלא האחרון לא תופיע עד
// שהסנכרון היומי ירוץ וייצור לה שיוך — ה-newCount מדווח כמה כאלה יש.
import { OWNERS } from "../shared/_owners.mjs";

const USERS = JSON.parse(process.env.APP_USERS || "{}");
const MONDAY_TOKEN = process.env.MONDAY_TOKEN || "";
const BOARD_ID = 5094207356;
const COL_DATE  = "date_mm2z4a07";
const COL_TASK  = "text_mm2zjggr";
const COL_TYPE  = "color_mm2xvme0";
const COL_NOTES = "text_mm2z594d";
const COL_PSTAT = "text_mm2zk6cp";

const QUERY = `
  query($cursor: String) {
    boards(ids: [${BOARD_ID}]) {
      items_page(limit: 100, cursor: $cursor) {
        cursor
        items {
          id
          name
          group { title }
          column_values(ids: ["${COL_DATE}","${COL_TASK}","${COL_TYPE}","${COL_NOTES}","${COL_PSTAT}"]) { id text }
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

function toTask(idx, item) {
  const col = {};
  for (const c of item.column_values) col[c.id] = tidy(c.text);
  const [addr, city] = splitCity(item.name);
  return {
    id: item.id, ord: idx, group: item.group.title,
    name: item.name, addr, city,
    date: col[COL_DATE] || "", type: col[COL_TYPE] || "",
    desc: col[COL_TASK] || "", notes: col[COL_NOTES] || "",
    pstatus: col[COL_PSTAT] || "",
  };
}

export default async (req) => {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const who = USERS[new URL(req.url).searchParams.get("t") || ""];
  if (!who) return json({ error: "unauthorized" }, 401);
  if (!who.admin) return json({ error: "forbidden" }, 403);
  if (!MONDAY_TOKEN) return json({ error: "no_token" }, 500);

  let raw;
  try {
    raw = await fetchItems();
  } catch (e) {
    return json({ error: "monday_fetch_failed", detail: String(e?.message || e).slice(0, 300) }, 502);
  }

  // כל בעלים שמופיע ב-OWNERS מקבל מערך — גם ריק — כדי שמי שסיים את כל
  // המשימות שלו יתרוקן בצד הלקוח ולא יישאר עם רשימה ישנה.
  const byOwner = {};
  for (const ownerId of new Set(Object.values(OWNERS))) byOwner[ownerId] = [];

  let newCount = 0;
  raw.forEach((item, i) => {
    const ownerId = OWNERS[item.id];
    if (!ownerId) { newCount++; return; }
    byOwner[ownerId].push(toTask(i, item));
  });

  const now = new Date();
  const syncedAt =
    new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "numeric", month: "numeric", year: "numeric" }).format(now) +
    " בשעה " +
    new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);

  return json({ ok: true, syncedAt, byOwner, newCount });
};
