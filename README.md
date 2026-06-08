# ISMIS Grade & GPA Watcher

Automatically monitors your ISMIS grades and GPA, and emails you the moment anything changes — no more manual refreshing.

---

## Features

- **Automatic grade alerts** — notified as soon as a final grade is posted
- ~~**GPA tracking** — monitors your overall GPA and alerts you when it shifts~~
- **Subject-by-subject monitoring** — detects when `NG / INC / W / DRP` transitions to a numeric grade
- **Checks every 15 minutes** — configurable interval
- **Clean email notifications** — shows subject name, old grade, new grade, and GPA updates in one table
- **Smart change detection** — only emails you when something actually changes, no spam
- **Persistent state** — remembers your last known grades in `grades.json` so it never misses an update across restarts
- **Error resilience** — sends you an alert email if the scraper itself fails, so you're never silently left in the dark
- **Test mode** — verify your email setup without waiting for a real grade change

---

## Requirements

- Node.js 18+
- A Gmail account with **2-Step Verification** enabled
- Access to `ismis.usc.edu.ph`

---

## Installation

```bash
git clone https://github.com/alferrr/ismis-grade-watcher.git
cd ismis-grade-watcher

npm install
npx playwright install chromium
```

---

## Configuration

```bash
cp .env.example .env
nano .env
```

| Variable             | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `ISMIS_USERNAME`     | Your ISMIS student ID (e.g. `19020241`)               |
| `ISMIS_PASSWORD`     | Your ISMIS password                                   |
| `GMAIL_USER`         | Gmail address used to send alerts                     |
| `GMAIL_APP_PASSWORD` | 16-character Gmail App Password (see below)           |
| `NOTIFY_EMAIL`       | Email address that receives the alerts                |
| `CHECK_CRON`         | Cron schedule for checks (default: `*/15 * * * *`)    |
| `TEST_EMAIL`         | Set to `"true"` to send a test email without scraping |

### Getting a Gmail App Password

1. Enable **2-Step Verification** at [myaccount.google.com/security](https://myaccount.google.com/security)
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Name it `ismis-watcher` → click **Create**
4. Copy the 16-character password into `GMAIL_APP_PASSWORD`

> Your real Gmail password will **not** work here. App Passwords are separate credentials.

---

## Usage

### Run once

```bash
node watcher.js
```

On first run, `grades.json` is created with your current grades as the baseline. No alert is sent unless a change is detected.

### Test your email

```bash
TEST_EMAIL=true node watcher.js
```

Sends a dummy grade alert without touching ISMIS — use this to confirm your Gmail credentials work before deploying.

### Run continuously

```bash
node watcher.js
```

Checks immediately on startup, then repeats on your `CHECK_CRON` schedule.

### Prevent your machine from sleeping (local use)

If you're running the watcher on your own machine instead of a server, make sure sleep is disabled — otherwise the cron will pause and you'll miss grade updates.

**macOS — `caffeinate`**

Run the watcher inside `caffeinate -i` so the system can't idle-sleep while it's active:

```bash
caffeinate -i node watcher.js
```

`-i` prevents idle sleep specifically. The machine can still lock the screen; only actual sleep is blocked. Kill the terminal or press `Ctrl+C` to stop both.

**Windows — `powercfg`**

Windows doesn't have a direct equivalent, but you can temporarily disable sleep via PowerShell before running the watcher:

```powershell
# Disable sleep (run once before starting the watcher)
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0

# Start the watcher
node watcher.js
```

Re-enable sleep when you're done:

```powershell
powercfg /change standby-timeout-ac 15
powercfg /change standby-timeout-dc 10
```

Alternatively, open **Settings → System → Power & Sleep** and set both dropdowns to **Never** while the watcher is running.

> For long-term / unattended use, deploy on the DCISM server with PM2 instead — no sleep concerns there.

---

## Cron Schedule Reference

Set `CHECK_CRON` in `.env`. All times use **Asia/Manila (PHT, UTC+8)**.

| Value          | Meaning                      |
| -------------- | ---------------------------- |
| `*/15 * * * *` | Every 15 minutes (default)   |
| `*/30 * * * *` | Every 30 minutes             |
| `0 * * * *`    | Every hour                   |
| `0 8,20 * * *` | 8 AM and 8 PM daily          |
| `0 9-21 * * *` | Every hour from 9 AM to 9 PM |

---

## How It Works

```
startup
   │
   ▼
validate env vars
   │
   ▼
run immediately → repeat on CHECK_CRON
   │
   ▼
Playwright: headless Chromium
   │  POST login to ismis.usc.edu.ph
   │  navigate to /ViewGrades
   │  scrape table.table-forum.table-hover
   │
   ▼
parse rows → { code, description, units, mg, fg }
parse last row → GPA value
   │
   ▼
load grades.json (previous state)
   │
   ▼
for each subject:
  prev ∈ { NG, INC, W, DRP } AND current fg is numeric?
  └── YES → add to changes[]

for GPA:
  GPA missing from state? OR GPA changed?
  └── YES → add OVERALL GPA row to changes[]
   │
   ▼
save new state + __meta.gpa to grades.json
   │
   ├── changes.length > 0 → send HTML email via Gmail SMTP
   └── no changes         → log "[ok] no changes"
```

---

## Email Format

When grades are posted you'll receive an email like:

**Subject:** `ISMIS Grade Update: Computer Programming 2, Data Structures, OVERALL GPA`

| Subject                | Before | After    |
| ---------------------- | ------ | -------- |
| Computer Programming 2 | NG     | **1.25** |
| Data Structures        | NG     | **1.50** |
|~~**OVERALL GPA**~~     | ~~1.38~~| ~~**1.32**~~ |

~~The GPA row is **bolded** in the email. Subjects are listed in the order they were detected.~~

---

## Project Structure

```
ismis-grade-watcher/
├── watcher.js            # main script
├── ecosystem.config.js   # PM2 config
├── .env.example          # env template
├── .env                  # your credentials (never commit this)
├── grades.json           # auto-generated state (never commit this)
├── logs/
│   ├── out.log
│   └── error.log
└── package.json
```

---

## Troubleshooting

**Login fails (`Login failed` error)**

- Verify `ISMIS_USERNAME` and `ISMIS_PASSWORD` in `.env`
- Try logging in at `ismis.usc.edu.ph` manually to confirm

**Grades table not found / timeout**

- ISMIS may be slow — the selector waits up to 20 seconds before giving up
- Set `headless: false` temporarily to watch the browser live:
  ```js
  const browser = await chromium.launch({ headless: false });
  ```
- Confirm the table still uses the class `table-forum table-hover` in browser DevTools

**Email not sending**

- Confirm you're using an **App Password**, not your actual Gmail password
- Run `TEST_EMAIL=true node watcher.js` to isolate the email step from scraping
- Make sure 2-Step Verification is active on the sending account

**Chromium crashes or won't start (Linux server)**

```bash
npx playwright install chromium --with-deps
```

**Want to reset the grade baseline**

```bash
rm grades.json
node watcher.js   # re-baselines from your current grades
```

~~**GPA row keeps appearing in every email**~~

- ~~The GPA scraper targets the last two cells of the last table row. If ISMIS changes their layout, the value may be misread. Check `grades.json` → `__meta.gpa` to see what's being saved.~~

---

## Security Notes

- Never commit `.env` or `grades.json` — add both to `.gitignore`
- Your App Password grants send access to your Gmail; treat it like a password
- Credentials are only used locally by Playwright; nothing is sent to third parties

**Recommended `.gitignore` entries:**

```
.env
grades.json
logs/
node_modules/
```
