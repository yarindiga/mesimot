#!/bin/bash
# סנכרון יומי: שליפה ממאנדיי (קריאה בלבד) -> קומיט -> דחיפה -> Netlify בונה לבד.
#
# הפעלה:  ./sync.sh
set -euo pipefail
cd "$(dirname "$0")"

GITHUB_TOKEN=$(grep '^GITHUB_TOKEN=' .env | cut -d= -f2-)
[ -n "$GITHUB_TOKEN" ] || { echo "חסר GITHUB_TOKEN ב-.env"; exit 1; }

echo "── שליפה ממאנדיי ובנייה ──"
python3 build_site.py

echo "── דחיפה ──"
git add -A
if git diff --cached --quiet; then
  echo "אין שינויים — לא נדרשת פריסה."
  exit 0
fi
git commit -q -m "סנכרון יומי $(date '+%-d.%-m.%Y %H:%M')"
git push -q "https://x-access-token:${GITHUB_TOKEN}@github.com/yarindiga/mesimot.git" main:main
echo "נדחף. Netlify בונה עכשיו."

echo "── המתנה לפריסה ──"
for i in $(seq 1 40); do
  sleep 15
  CODE=$(curl -s -o /dev/null -w '%{http_code}' https://mesimot-followup.netlify.app || true)
  FUNC=$(curl -s -o /dev/null -w '%{http_code}' https://mesimot-followup.netlify.app/api/updates || true)
  if [ "$CODE" = "200" ] && [ "$FUNC" = "401" ]; then
    echo "האתר תקין: אתר $CODE, פונקציה $FUNC"
    exit 0
  fi
done
echo "אזהרה: אחרי 10 דקות האתר מחזיר $CODE והפונקציה $FUNC — לבדוק את לוג הבנייה ב-Netlify."
exit 1
