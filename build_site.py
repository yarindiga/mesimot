#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
בונה את קובץ האתר (index.html) מתוך לוח המשימות במאנדיי.

קריאה בלבד: הסקריפט שולח אך ורק GraphQL query. אין כאן שום mutation,
ולכן אי אפשר לשנות או למחוק דבר בלוח.

הפעלה:  python3 build_site.py
"""

import json, os, re, secrets, sys, urllib.error, urllib.request, datetime
from zoneinfo import ZoneInfo
from base64 import b64decode, b64encode
from hashlib import pbkdf2_hmac, sha256
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HERE      = os.path.dirname(os.path.abspath(__file__))
BOARD_ID  = 5094207356
ITERS     = 200_000
NO_OWNER  = "__none__"
BUCKET    = 32 * 1024   # ריפוד לגודל אחיד — כדי שגודל המידע לא יסגיר כמה משימות יש לכל אחד
DECOYS    = 3           # רשומות ומידע דמה — כדי שלא יהיה אפשר לספור כמה משתמשים קיימים
TZ        = ZoneInfo("Asia/Jerusalem")

COL_EMAIL, COL_DATE   = "email_mm2bvkpj", "date_mm2z4a07"
COL_TASK,  COL_TYPE   = "text_mm2zjggr",  "color_mm2xvme0"
COL_NOTES, COL_PSTAT  = "text_mm2z594d",  "text_mm2zk6cp"

META_QUERY = """
query {
  boards(ids: [%d]) {
    columns(ids: ["%s"]) { settings_str }
    groups { title color }
  }
}
""" % (BOARD_ID, COL_TYPE)

QUERY = """
query($cursor: String) {
  boards(ids: [%d]) {
    items_page(limit: 100, cursor: $cursor) {
      cursor
      items {
        id
        name
        group { id title }
        column_values(ids: ["%s","%s","%s","%s","%s","%s"]) { id text }
      }
    }
  }
}
""" % (BOARD_ID, COL_EMAIL, COL_DATE, COL_TASK, COL_TYPE, COL_NOTES, COL_PSTAT)


def monday_token():
    for path in (os.path.join(HERE, ".env"), os.path.join(HERE, "..", ".env")):
        if os.path.exists(path):
            for line in open(path, encoding="utf-8"):
                if line.strip().startswith("MONDAY_TOKEN="):
                    return line.split("=", 1)[1].strip()
    sys.exit("חסר MONDAY_TOKEN בקובץ .env — לא ממשיכים בניחוש.")


def fetch_items(token):
    """שולף את כל הפריטים בסדר שבו הם מופיעים בלוח."""
    items, cursor = [], None
    while True:
        body = json.dumps({"query": QUERY, "variables": {"cursor": cursor}}).encode()
        req = urllib.request.Request(
            "https://api.monday.com/v2", data=body,
            headers={"Authorization": token, "Content-Type": "application/json",
                     "API-Version": "2024-10"})
        res = json.loads(urllib.request.urlopen(req, timeout=60).read())
        if "errors" in res:
            sys.exit("מאנדיי החזיר שגיאה: " + json.dumps(res["errors"], ensure_ascii=False))
        page = res["data"]["boards"][0]["items_page"]
        items += page["items"]
        cursor = page.get("cursor")
        if not cursor:
            return items


def split_city(name):
    """'הרב קוק 10, ראשון' -> ('הרב קוק 10', 'ראשון'); בלי פסיק — השם נשאר שלם."""
    if ", " in name:
        head, city = name.rsplit(", ", 1)
        return head.strip(), city.strip()
    return name.strip(), ""


def tidy(text):
    """מצמצם רצפים של שורות ריקות כדי שהתצוגה תישאר קומפקטית."""
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def to_task(idx, item):
    col = {c["id"]: tidy(c["text"] or "") for c in item["column_values"]}
    addr, city = split_city(item["name"])
    return {
        "id": item["id"], "ord": idx, "group": item["group"]["title"],
        "name": item["name"], "addr": addr, "city": city,
        "date": col.get(COL_DATE, ""), "type": col.get(COL_TYPE, ""),
        "desc": col.get(COL_TASK, ""), "notes": col.get(COL_NOTES, ""),
        "pstatus": col.get(COL_PSTAT, ""),
        "email": col.get(COL_EMAIL, "").lower(),
    }


def _rgb(hex_):
    h = hex_.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _lum(rgb):
    def ch(c):
        c /= 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(c))) for c in rgb)


def _shift(hex_, target, toward):
    """מזיז את הצבע לכיוון שחור/לבן עד שהבהירות מגיעה ליעד — לטקסט קריא."""
    rgb = _rgb(hex_)
    for _ in range(60):
        lum = _lum(rgb)
        if (toward == "dark" and lum <= target) or (toward == "light" and lum >= target):
            break
        anchor = (0, 0, 0) if toward == "dark" else (255, 255, 255)
        rgb = tuple(c + (a - c) * 0.06 for c, a in zip(rgb, anchor))
    return _hex(rgb)


def palette(hex_):
    """גרסאות של צבע מאנדיי: פיל מלא, וטקסט קריא על רקע בהיר ועל רקע כהה."""
    return {
        "bg": hex_,
        "fg": "#ffffff" if _lum(_rgb(hex_)) < 0.40 else "#1d2129",
        "light": _shift(hex_, 0.17, "dark"),
        "dark": _shift(hex_, 0.46, "light"),
    }


def fetch_palettes(token):
    req = urllib.request.Request(
        "https://api.monday.com/v2", data=json.dumps({"query": META_QUERY}).encode(),
        headers={"Authorization": token, "Content-Type": "application/json",
                 "API-Version": "2024-10"})
    board = json.loads(urllib.request.urlopen(req, timeout=60).read())["data"]["boards"][0]
    cfg   = json.loads(board["columns"][0]["settings_str"])
    labels, colors = cfg.get("labels", {}), cfg.get("labels_colors", {})
    types = {}
    for k in sorted(labels, key=lambda x: int(x)):
        if labels.get(k) and k in colors:
            entry = palette(colors[k]["color"])
            entry["ord"] = int(k)
            types[labels[k]] = entry
    groups = {g["title"]: palette(g["color"]) for g in board["groups"] if g.get("color")}
    return types, groups


def seal(key_bytes, plaintext):
    iv = secrets.token_bytes(12)
    ct = AESGCM(key_bytes).encrypt(iv, plaintext, None)
    return {"iv": b64encode(iv).decode(), "ct": b64encode(ct).decode()}


def write_function_data(users, owners, store, by_owner):
    """מפצל בין שני סוגי מידע:
    - מיפוי משימה→בעלים נכתב ל-shared/_owners.mjs ונכנס למאגר. אין בו סודות,
      רק מזהי משימות ומזהים אטומים.
    - אסימוני הכתיבה נדחפים למשתנה הסביבה APP_USERS ב-Netlify ולעולם לא נכנסים לקוד.
    """
    who_by_token = {}
    for owner in owners:
        u  = next((x for x in users if x["email"] == owner), None)
        who_by_token[store["writeTokens"][owner]] = {
            "id":    store["blobIds"][owner],
            "name":  u["name"] if u else "ללא שיוך",
            "admin": bool(u.get("admin")) if u else False,
        }
    task_owner = {t["id"]: store["blobIds"][owner]
                  for owner in owners for t in by_owner[owner]}

    sdir = os.path.join(HERE, "shared")
    os.makedirs(sdir, exist_ok=True)
    with open(os.path.join(sdir, "_owners.mjs"), "w", encoding="utf-8") as f:
        f.write("// נוצר אוטומטית על ידי build_site.py. אין כאן סודות.\n")
        f.write("export const OWNERS = %s;\n" % json.dumps(task_owner, ensure_ascii=False))

    push_env("APP_USERS", json.dumps(who_by_token, ensure_ascii=False, separators=(",", ":")))


def push_env(key, value):
    """מעדכן משתנה סביבה ב-Netlify. הערך לא נשמר בשום קובץ שנכנס למאגר."""
    cfg = {}
    for path in (os.path.join(HERE, ".env"),):
        if os.path.exists(path):
            for line in open(path, encoding="utf-8"):
                if "=" in line and not line.strip().startswith("#"):
                    k, v = line.split("=", 1)
                    cfg[k.strip()] = v.strip()
    tok, site = cfg.get("NETLIFY_TOKEN"), cfg.get("NETLIFY_SITE_ID")
    if not tok or not site:
        print("  דילוג על APP_USERS — חסרים NETLIFY_TOKEN/NETLIFY_SITE_ID")
        return

    base = "https://api.netlify.com/api/v1/accounts/digayarin/env"
    hdrs = {"Authorization": "Bearer " + tok, "Content-Type": "application/json"}
    body = json.dumps({"key": key, "values": [{"context": "all", "value": value}]}).encode()
    last = ""
    # PUT מעדכן משתנה קיים, POST יוצר חדש — מנסים לפי הסדר הזה
    for method, url in (("PUT",  "%s/%s?site_id=%s" % (base, key, site)),
                        ("POST", "%s?site_id=%s"    % (base, site))):
        payload = body if method == "PUT" else json.dumps([json.loads(body)]).encode()
        try:
            req = urllib.request.Request(url, data=payload, method=method, headers=hdrs)
            urllib.request.urlopen(req, timeout=45).read()
            print("  APP_USERS עודכן ב-Netlify (%d משתמשים)" % len(json.loads(value)))
            return
        except urllib.error.HTTPError as e:
            last = "%s %s" % (e.code, e.read().decode("utf-8", "replace")[:120])
    print("  אזהרה: APP_USERS לא עודכן —", last)


def main():
    users = json.load(open(os.path.join(HERE, "users.json"), encoding="utf-8"))
    token = monday_token()

    keys_path = os.path.join(HERE, "keys.json")
    store = (json.load(open(keys_path, encoding="utf-8"))
             if os.path.exists(keys_path) else {"dataKeys": {}, "salts": {}})

    types, group_colors = fetch_palettes(token)
    raw = fetch_items(token)
    tasks = [to_task(i, it) for i, it in enumerate(raw)]

    # קיבוץ לפי אימייל אחראי; פריטים בלי אימייל נאספים לתא נפרד שרק המנהל רואה
    by_owner = {}
    for t in tasks:
        by_owner.setdefault(t["email"] or NO_OWNER, []).append(t)

    known = {u["email"] for u in users}
    for email in by_owner:
        if email != NO_OWNER and email not in known:
            print("  אזהרה: אימייל בלוח שאין לו משתמש באתר — %s (%d משימות)"
                  % (email, len(by_owner[email])))

    site_salt = store.get("siteSalt") or secrets.token_hex(16)
    store["siteSalt"] = site_salt

    def uid(email):
        return sha256((site_salt + ":" + email).encode()).hexdigest()[:32]

    owners  = [u["email"] for u in users if u["email"] in by_owner]
    owners += [o for o in by_owner if o not in owners]

    # מזהה אטום לכל מאגר, במקום האימייל — כדי שלא יהיו אימיילים בקוד המקור
    store.setdefault("blobIds", {})
    data_keys, blobs = {}, {}
    for owner in owners:
        bid = store["blobIds"].get(owner) or secrets.token_hex(8)
        store["blobIds"][owner] = bid

        saved = store["dataKeys"].get(owner)
        dk = b64decode(saved) if saved else secrets.token_bytes(32)
        store["dataKeys"][owner] = b64encode(dk).decode()
        data_keys[bid] = dk

        who = next((u for u in users if u["email"] == owner), None)
        store.setdefault("writeTokens", {})
        wt = store["writeTokens"].get(owner) or secrets.token_urlsafe(24)
        store["writeTokens"][owner] = wt
        body = json.dumps({
            "name":  who["name"] if who else "ללא שיוך",
            "admin": bool(who.get("admin")) if who else False,
            "wt":    wt,
            "tasks": by_owner[owner],
        }, ensure_ascii=False).encode()
        pad = (-len(body) - 16) % BUCKET          # ריפוד ברווחים — JSON.parse סובל אותם בסוף
        blobs[bid] = seal(dk, body + b" " * pad)

    for _ in range(DECOYS):                       # מאגרי דמה, בגודל הדלי הקטן ביותר
        blobs[secrets.token_hex(8)] = {
            "iv": b64encode(secrets.token_bytes(12)).decode(),
            "ct": b64encode(secrets.token_bytes(BUCKET + 16)).decode(),
        }

    slots = list(blobs.keys())

    def decoy_key(of):
        return {"of": of, "wrapped": {"iv": b64encode(secrets.token_bytes(12)).decode(),
                                      "ct": b64encode(secrets.token_bytes(48)).decode()}}

    records = {}
    for u in users:
        saved_salt = store["salts"].get(u["email"])
        salt = b64decode(saved_salt) if saved_salt else secrets.token_bytes(16)
        store["salts"][u["email"]] = b64encode(salt).decode()
        kek = pbkdf2_hmac("sha256", u["password"].encode(), salt, ITERS, 32)

        mine = set(store["blobIds"][o] for o in owners) if u.get("admin") \
               else {store["blobIds"].get(u["email"])}
        keys = [{"of": bid, "wrapped": seal(kek, data_keys[bid])} if bid in mine and bid in data_keys
                else decoy_key(bid)
                for bid in slots]                 # לכל רשומה בדיוק אותו מספר מפתחות
        secrets.SystemRandom().shuffle(keys)
        records[uid(u["email"])] = {"salt": b64encode(salt).decode(), "keys": keys}

    for _ in range(DECOYS):                       # רשומות דמה
        records[secrets.token_hex(16)] = {
            "salt": b64encode(secrets.token_bytes(16)).decode(),
            "keys": [decoy_key(bid) for bid in slots],
        }

    json.dump(store, open(keys_path, "w", encoding="utf-8"), indent=2)
    os.chmod(keys_path, 0o600)

    write_function_data(users, owners, store, by_owner)

    now = datetime.datetime.now(TZ)
    bundle = {
        "iter": ITERS,
        "syncedAt": now.strftime("%-d.%-m.%Y") + " בשעה " + now.strftime("%H:%M"),
        "types": types,
        "groupColors": group_colors,
        "siteSalt": site_salt,
        "decoySalt": b64encode(secrets.token_bytes(16)).decode(),
        "records": records,
        "blobs": blobs,
    }

    payload = json.dumps(bundle, ensure_ascii=False, separators=(",", ":")) \
                  .replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")

    html = open(os.path.join(HERE, "template.html"), encoding="utf-8").read()
    if "__PAYLOAD__" not in html:
        sys.exit("התבנית לא מכילה __PAYLOAD__ — עוצר.")
    dist = os.path.join(HERE, "dist")
    os.makedirs(dist, exist_ok=True)
    out = os.path.join(dist, "index.html")
    open(out, "w", encoding="utf-8").write(html.replace("__PAYLOAD__", payload))

    print("נבנה: %s  (%.0f KB)" % (out, os.path.getsize(out) / 1024))
    print("סה\"כ %d משימות מהלוח, מתוכן %d עד היום." %
          (len(tasks), sum(1 for t in tasks if not t["date"] or t["date"] <= now.strftime("%Y-%m-%d"))))
    for o in owners:
        label = next((u["name"] for u in users if u["email"] == o), "ללא שיוך")
        upto  = sum(1 for t in by_owner[o] if not t["date"] or t["date"] <= now.strftime("%Y-%m-%d"))
        print("   %-8s %3d משימות  (%d עד היום)" % (label, len(by_owner[o]), upto))


if __name__ == "__main__":
    main()
