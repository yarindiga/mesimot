// עריכת תיאור משימה ומועד פולו-אפ — נכתב ישירות למאנדיי, בלי אחסון מקומי
// משלו (מאנדיי הוא מקור האמת היחיד לשדות האלה, בניגוד לסימוני סטטוס).
//
// מותר רק למשתמש עם canEdit (נקבע ב-users.json, נדחף ל-APP_USERS על ידי
// build_site.py), ורק על משימה ששייכת לו (OWNERS[taskId] === who.id) —
// בלי עקיפה למנהל. ראו shared/_owners.mjs ו-functions/updates.mjs לאותו דפוס.
import { OWNERS } from "../shared/_owners.mjs";

const USERS = JSON.parse(process.env.APP_USERS || "{}");
const MONDAY_TOKEN = process.env.MONDAY_TOKEN || "";
const BOARD_ID = 5094207356;
const COL_TASK = "text_mm2zjggr"; // "המשימה"
const COL_DATE = "date_mm2z4a07"; // מועד הפולו-אפ

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

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

async function pushEdit(taskId, desc, date) {
  await mondayApi(
    `mutation($b: ID!, $i: ID!, $c: String!, $v: String!) {
       change_simple_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v) { id }
     }`,
    { b: BOARD_ID, i: taskId, c: COL_TASK, v: desc }
  );
  await mondayApi(
    `mutation($b: ID!, $i: ID!, $c: String!, $v: JSON!) {
       change_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v) { id }
     }`,
    { b: BOARD_ID, i: taskId, c: COL_DATE, v: JSON.stringify({ date }) }
  );
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const who = USERS[body.t || ""];
  if (!who) return json({ error: "unauthorized" }, 401);
  if (!who.canEdit) return json({ error: "forbidden" }, 403);

  const taskId = String(body.taskId || "");
  if (!/^[0-9]{1,20}$/.test(taskId)) return json({ error: "bad_task" }, 400);
  // אף אחד לא עורך משימה שאינה שלו — גם לא מנהל, במכוון (ראו הערה למעלה).
  if (OWNERS[taskId] !== who.id) return json({ error: "not_yours" }, 403);

  const date = String(body.date || "");
  if (!RE_DATE.test(date)) return json({ error: "bad_date" }, 400);
  const desc = String(body.desc || "").slice(0, 4000);

  if (!MONDAY_TOKEN) return json({ error: "no_token" }, 500);

  try {
    await pushEdit(taskId, desc, date);
  } catch (e) {
    return json({ error: "monday_push_failed", detail: String(e?.message || e).slice(0, 300) }, 502);
  }

  return json({ ok: true, desc, date });
};
