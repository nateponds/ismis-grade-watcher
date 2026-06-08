require("dotenv").config();

const { chromium } = require("playwright");
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const fs = require("fs");

// constants, do not change

const ISMIS_URL = "https://ismis.usc.edu.ph";
const VIEW_GRADES_URL = `${ISMIS_URL}/ViewGrades`;
const STATE_FILE = "./grades.json";
const CRON_SCHEDULE = process.env.CHECK_CRON || "*/15 * * * *";

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(data) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

// mailer

async function sendEmail(changes) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const rows = changes
    .map(
      (c) => `
    <tr>
          <td style="padding:8px;border:1px solid #ddd;font-weight:${c.subject === "OVERALL GPA" ? "bold" : "normal"}">${c.subject}</td>      <td style="padding:8px;border:1px solid #ddd">${c.before}</td>
      <td style="padding:8px;border:1px solid #ddd;color:green;font-weight:bold">${c.after}</td>
    </tr>
  `,
    )
    .join("");

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.NOTIFY_EMAIL,
    subject: `ISMIS Grade Update: ${changes.map((c) => c.subject).join(", ")}`,
    html: `
      <h3>New Grades Posted</h3>
      <table style="border-collapse:collapse;font-family:sans-serif">
        <tr>
          <th style="border:1px solid #ddd;padding:8px">Subject</th>
          <th style="border:1px solid #ddd;padding:8px">Before</th>
          <th style="border:1px solid #ddd;padding:8px">After</th>
        </tr>
        ${rows}
      </table>
      <p style="color:#888;font-size:12px">
        ISMIS Watcher · ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
      </p>
    `,
  });
}

async function scrapeGrades() {
  const browser = await chromium.launch({ headless: true });
  let page;

  try {
    page = await browser.newPage();

    await page.goto(ISMIS_URL, { waitUntil: "domcontentloaded" });

    await page.fill('input[type="text"]', process.env.ISMIS_USERNAME);
    await page.fill('input[type="password"]', process.env.ISMIS_PASSWORD);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);

    if (page.url().includes("login")) {
      throw new Error("Login failed");
    }

    await page.goto(VIEW_GRADES_URL, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector("table.table-forum.table-hover tbody tr", {
      timeout: 20000,
    });

    const grades = await page.$$eval(
      "table.table-forum.table-hover tbody tr",
      (rows) =>
        rows
          .map((r) => {
            const cols = [...r.querySelectorAll("td")].map((td) =>
              td.innerText.trim().replace(/\s+/g, " "),
            );

            if (cols.length < 5) return null;

            const [code, description, units, mg, fg] = cols;

            return {
              code,
              description,
              units,
              mg: (mg || "").toUpperCase(),
              fg: (fg || "NG").toUpperCase(),
            };
          })
          .filter(Boolean),
    );

    const gpa = await page.$$eval(
      "table.table-forum.table-hover tbody tr",
      (rows) => {
        if (!rows || rows.length === 0) return null;

        const lastRow = rows[rows.length - 1];
        const cells = lastRow.querySelectorAll("td");

        if (cells.length < 2) return null;

        const label = cells[cells.length - 2]?.innerText.trim();
        const value = cells[cells.length - 1]?.innerText.trim();

        if (!label || !value) return null;

        return value; // this is GPA
      },
    );

    return { grades, gpa };
  } finally {
    await browser.close();
  }
}

function detectChanges(oldState, currentGrades) {
  const changes = [];

  for (const g of currentGrades) {
    const prev = oldState[g.description]?.fg || "NG";

    const wasPending = ["NG", "INC", "W", "DRP"].includes(prev);
    const nowFinal = /^\d+(\.\d+)?$/.test(g.fg);

    if (wasPending && nowFinal) {
      changes.push({
        subject: g.description,
        before: prev,
        after: g.fg,
      });
    }
  }

  return changes;
}

async function runCheck() {
  if (process.env.TEST_EMAIL === "true") {
    console.log("trying email");

    // debugging email
    await sendEmail([
      {
        subject: "TEST SUBJECT - ISMIS WATCHER",
        before: "NG",
        after: "1.5 (TEST)",
      },
    ]);

    return;
  }

  console.log(`\n[check] ${new Date().toLocaleString()}`);

  let result;

  try {
    result = await scrapeGrades();
  } catch (err) {
    console.error("[scraper error]", err.message);
    try {
      await sendEmail([
        {
          subject: "scraper error",
          before: "NG",
          after: "NG",
        },
      ]);
    } catch (e) {
      console.error("[scraper email failed]", e.message);
    }
    return;
  }

  const current = result.grades;
  const currentGpa = result.gpa;

  const oldState = loadState();
  const changes = detectChanges(oldState, current);

  const previousGpa = oldState.__meta?.gpa;

  if (currentGpa) {
    if (!previousGpa) {
      changes.push({
        subject: "OVERALL GPA",
        before: "N/A",
        after: currentGpa,
      });
    } else if (previousGpa !== currentGpa) {
      changes.push({
        subject: "OVERALL GPA",
        before: previousGpa,
        after: currentGpa,
      });
    }
  }

  // update state
  const newState = {};

  for (const g of current) {
    newState[g.description] = {
      fg: g.fg,
      updatedAt: new Date().toISOString(),
    };
  }

  newState.__meta = {
    gpa: currentGpa,
    updatedAt: new Date().toISOString(),
  };

  if (changes.length > 0) {
    console.log("[alert] new grades detected");

    try {
      await sendEmail(changes);
    } catch (err) {
      try {
        await sendEmail([
          {
            subject: "Mail error",
            before: "NG",
            after: "NG",
          },
        ]);
      } catch (e) {
        console.error("[fallback email failed]", e.message);
      }
    }
  } else {
    console.log("[ok] no changes");
  }

  saveState(newState);
}

// main

(async () => {
  const required = [
    "ISMIS_USERNAME",
    "ISMIS_PASSWORD",
    "GMAIL_USER",
    "GMAIL_APP_PASSWORD",
    "NOTIFY_EMAIL",
  ];

  const missing = required.filter((k) => !process.env[k]);

  if (missing.length) {
    console.error("Missing env vars:", missing.join(", "));
    process.exit(1);
  }

  console.log("[init] ISMIS watcher started");
  console.log("[init] schedule:", CRON_SCHEDULE);

  await runCheck(); // run immediately

  cron.schedule(CRON_SCHEDULE, runCheck, {
    timezone: "Asia/Manila",
  });
})();
