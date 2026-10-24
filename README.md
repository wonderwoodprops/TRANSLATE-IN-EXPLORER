# שרת תרגום תמונות (Railway)

מקבל תמונה מהתוסף, פותח דף "תרגום תמונות" של גוגל בדפדפן Chromium headless, מעלה אליו את התמונה, ומחזיר את התמונה המתורגמת (עם הטקסט המושתל) כ-PNG.

## פריסה ב-Railway
1. העלו את התיקייה הזו ל-repo ב-GitHub (או השתמשו ב-`railway up` מה-CLI).
2. ב-Railway: **New Project ← Deploy from GitHub repo**. הקובץ `railway.json` והקובץ `Dockerfile` מגדירים הכול.
3. **Variables** (אופציונלי אך מומלץ): `AUTH_TOKEN` = מחרוזת אקראית ארוכה. אותה מחרוזת תיכנס ל-`config.js` בתוסף.
4. **Settings ← Networking ← Generate Domain**. הכתובת שתקבלו, עם `/translate` בסוף, היא ה-`WEBHOOK_URL` של התוסף:
   `https://<השם-שלכם>.up.railway.app/translate`
5. בדיקה: פתחו `https://<השם-שלכם>.up.railway.app/health` — אמור להחזיר `{"ok":true,...}`.

מומלץ לתת לשירות לפחות 1GB זיכרון (Chromium).

## API
- `POST /translate` — גוף הבקשה: קובץ התמונה (`Content-Type: image/png`), או JSON `{"image":"data:image/png;base64,..."}`.
  תשובה: `image/png` של התמונה המתורגמת. שגיאה: JSON `{"error":"..."}`.
  עם `AUTH_TOKEN`: כותרת `Authorization: Bearer <token>`.
- `GET /health` — בדיקת חיות.
- `GET /debug/last.png` — צילום המסך של הכשל האחרון בדפדפן (באותו אימות). שימושי כשגוגל משנה את העמוד או מציגה חסימה/הסכמה.

## משתני סביבה
| משתנה | ברירת מחדל | תיאור |
|---|---|---|
| `AUTH_TOKEN` | ריק | אם מוגדר, נדרש בכל בקשה |
| `TRANSLATE_URL` | `https://translate.google.com/?sl=auto&tl=iw&op=images` | כתובת הדף (זיהוי שפה ← עברית) |
| `MAX_CONCURRENCY` | 2 | כמה תרגומים במקביל |
| `TIMEOUT_MS` | 60000 | זמן מקסימלי לתרגום |
| `MAX_MB` | 15 | גודל תמונה מקסימלי |
| `LOCALE` | en-US | שפת הדפדפן |

## הערות
- אין ל-Google Translate API רשמי לתמונות, ולכן השירות מבוסס על אוטומציה של האתר. שינוי בעיצוב האתר, חסימת בוטים (CAPTCHA) מכתובות של שרתים, או עמוד הסכמה אזורי עלולים לשבור אותו. במקרה כזה `GET /debug/last.png` יראה מה הדפדפן ראה.
- השימוש באוטומציה על האתר כפוף לתנאי השימוש של גוגל; מתאים לשימוש אישי בהיקף קטן.
