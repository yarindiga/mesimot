#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
פורס את תיקיית dist/ ל-Netlify.

נפרסת אך ורק תיקיית dist. users.json ו-.env לעולם לא עולים לאוויר.

הפעלה:  python3 deploy_netlify.py [שם-תת-דומיין]
"""

import io, json, os, sys, time, urllib.error, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
ENV  = os.path.join(HERE, ".env")
API  = "https://api.netlify.com/api/v1"
DEFAULT_NAME = "mesimot-followup"


def env():
    vals = {}
    if os.path.exists(ENV):
        for line in open(ENV, encoding="utf-8"):
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip()
    return vals


def env_set(key, value):
    lines, done = [], False
    if os.path.exists(ENV):
        for line in open(ENV, encoding="utf-8"):
            if line.strip().startswith(key + "="):
                lines.append("%s=%s\n" % (key, value)); done = True
            else:
                lines.append(line)
    if not done:
        lines.append("%s=%s\n" % (key, value))
    open(ENV, "w", encoding="utf-8").writelines(lines)
    os.chmod(ENV, 0o600)


def call(token, method, path, body=None, ctype="application/json"):
    data = body
    if ctype == "application/json" and body is not None:
        data = json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + token,
                                          "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit("Netlify החזיר %s עבור %s %s:\n%s"
                 % (e.code, method, path, e.read().decode("utf-8", "replace")[:600]))


def zip_bundle():
    """שורש ה-zip הוא שורש האתר — פריסת zip מתעלמת מ-publish ב-netlify.toml.
    נארזת רק dist/, ולכן .env / users.json / keys.json לא יכולים לדלוף."""
    if not os.path.exists(os.path.join(DIST, "index.html")):
        sys.exit("אין dist/index.html — הריצו קודם build_site.py.")
    buf, names = io.BytesIO(), []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(DIST):
            for f in files:
                fp  = os.path.join(root, f)
                rel = os.path.relpath(fp, DIST)
                z.write(fp, rel); names.append(rel)
    return buf.getvalue(), names


def ensure_site(token, wanted):
    cfg = env()
    if cfg.get("NETLIFY_SITE_ID"):
        return cfg["NETLIFY_SITE_ID"]

    for attempt in range(6):
        name = wanted if attempt == 0 else "%s-%d" % (wanted, attempt + 1)
        req = urllib.request.Request(API + "/sites", method="POST",
                                     data=json.dumps({"name": name}).encode(),
                                     headers={"Authorization": "Bearer " + token,
                                              "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                site = json.loads(r.read())
            env_set("NETLIFY_SITE_ID", site["id"])
            print("נוצר אתר חדש: %s" % site.get("ssl_url") or site.get("url"))
            return site["id"]
        except urllib.error.HTTPError as e:
            if e.code in (422, 409):        # שם תפוס — מנסים וריאציה
                continue
            sys.exit("Netlify החזיר %s ביצירת האתר:\n%s"
                     % (e.code, e.read().decode("utf-8", "replace")[:600]))
    sys.exit("לא נמצא שם פנוי ל-%s — בחרו שם אחר." % wanted)


def main():
    cfg   = env()
    token = cfg.get("NETLIFY_TOKEN")
    if not token:
        sys.exit("חסר NETLIFY_TOKEN בקובץ .env — לא ממשיכים בניחוש.")

    wanted  = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_NAME
    site_id = ensure_site(token, wanted)

    blob, names = zip_bundle()
    print("מעלה %d קבצים: %s" % (len(names), ", ".join(sorted(names)[:6]) + ("…" if len(names) > 6 else "")))
    deploy = call(token, "POST", "/sites/%s/deploys" % site_id,
                  body=blob, ctype="application/zip")

    dep_id, state = deploy["id"], deploy.get("state")
    for _ in range(40):
        if state in ("ready", "current"):
            break
        if state == "error":
            sys.exit("הפריסה נכשלה: " + str(deploy.get("error_message")))
        time.sleep(3)
        deploy = call(token, "GET", "/deploys/" + dep_id)
        state  = deploy.get("state")

    site = call(token, "GET", "/sites/" + site_id)
    print("סטטוס: %s" % state)
    print("כתובת האתר: %s" % (site.get("ssl_url") or site.get("url")))


if __name__ == "__main__":
    main()
