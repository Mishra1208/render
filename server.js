// conu-community/server.js
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const Snoowrap = require("snoowrap");

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const { executablePath } = require("puppeteer");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.use(cors());
app.use(morgan("tiny"));

/* ------------------------------- Reddit -------------------------------- */
const reddit = new Snoowrap({
  userAgent: process.env.REDDIT_USER_AGENT || "conu-planner/0.1 (dev)",
  clientId: process.env.REDDIT_CLIENT_ID,
  clientSecret: process.env.REDDIT_CLIENT_SECRET,
  username: process.env.REDDIT_USERNAME,
  password: process.env.REDDIT_PASSWORD,
});
reddit.config({ requestDelay: 500, continueAfterRatelimitError: true });

function inferTopicFromQuestion(q) {
  const s = (q || "").toLowerCase();
  if (/(best|who to take|avoid|teacher|prof|instructor)/.test(s)) return "instructor";
  if (/(final|midterm|exam|test|quiz|format|curve|grading)/.test(s)) return "exam";
  if (/(tip|advice|study|assignment|lab|labs|resource|textbook|notes)/.test(s)) return "tips";
  return "difficulty";
}
const topicQuery = {
  difficulty: '(hard OR difficulty OR workload OR easy OR tough OR "drop rate" OR curve)',
  instructor: '(prof OR professor OR teacher OR instructor OR "who to take" OR "best prof" OR avoid)',
  exam: '(final OR midterm OR exam OR test OR quiz OR format OR grading OR proctor)',
  tips: '(tips OR advice OR study OR assignment OR lab OR labs OR resource OR textbook OR notes)',
};
const courseVariants = (course) => {
  const compact = course.replace(/\s+/g, "");
  const dashed = course.replace(/\s+/g, "-");
  const lower = course.toLowerCase();
  return `("${course}" OR ${compact} OR "${dashed}" OR "${lower}" OR ${lower.replace(/\s+/g, "")})`;
};
const sinceDaysToTimestamp = (days) =>
  Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
const relTime = (iso) => {
  const d = new Date(iso), now = Date.now();
  const diff = Math.max(1, Math.round((now - d.getTime()) / (1000 * 60 * 60 * 24)));
  if (diff < 7) return `${diff}d ago`;
  const w = Math.round(diff / 7); if (w < 8) return `${w}w ago`;
  const m = Math.round(diff / 30); if (m < 18) return `${m}mo ago`;
  const y = Math.round(diff / 365); return `${y}y ago`;
};
const summarizePosts = (posts, course, topic) => {
  const head = {
    difficulty: `Here’s what students recently said about **${course}** (difficulty/workload):`,
    instructor: `Instructor chatter for **${course}** (who to take/avoid):`,
    exam: `Exam-related posts for **${course}**:`,
    tips: `Tips & resources mentioned for **${course}**:`,
  }[topic] || `Community posts for **${course}**:`;
  const bullets = posts.slice(0, 5).map(
    (p) => `• ${p.title} — ${relTime(p.created_iso)} (${p.subreddit}) — ${p.url}`
  );
  return {
    answer: [head, ...bullets, "", "Note: Community feedback from Reddit (opinions/experiences, not official)."].join("\n"),
    sources: posts.slice(0, 5).map((p) => ({
      title: p.title, url: p.url, when: relTime(p.created_iso), subreddit: p.subreddit, score: p.score,
    })),
  };
};
const withTimeout = (promise, ms, label = "reddit") =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}:timeout`)), ms)),
  ]);

async function searchReddit({ subreddits, searchQ, afterTs, limit, perCallTimeoutMs = 4000 }) {
  const tasks = subreddits.map(async (sub) => {
    try {
      const subreddit = await reddit.getSubreddit(sub);
      const listing = await withTimeout(
        subreddit.search({ query: searchQ, sort: "new", time: "year", limit }),
        perCallTimeoutMs,
        `search:${sub}`
      );
      return listing.map((p) => ({
        id: p.id,
        subreddit: `r/${sub}`,
        title: p.title,
        url: `https://www.reddit.com${p.permalink}`,
        score: p.score,
        num_comments: p.num_comments,
        created_utc: p.created_utc,
        created_iso: new Date(p.created_utc * 1000).toISOString(),
      }));
    } catch {
      return [];
    }
  });

  const nested = await Promise.all(tasks);
  const results = nested.flat();
  return results
    .filter((r) => r.created_utc >= afterTs)
    .sort((a, b) => b.created_utc - a.created_utc)
    .slice(0, limit);
}

/* -------------------- Puppeteer (Render-friendly) -------------------- */
let _browserPromise = null;
async function getBrowser() {
  if (!_browserPromise) {
    _browserPromise = puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--single-process",
      ],
      executablePath: process.env.CHROME_PATH || executablePath(),
    });
  }
  return _browserPromise;
}
async function closeBrowser() {
  try { const br = await _browserPromise; await br?.close(); } catch {}
}
process.on("SIGINT", async () => { await closeBrowser(); process.exit(0); });
process.on("SIGTERM", async () => { await closeBrowser(); process.exit(0); });

/* -------------------------- RMP cache --------------------------- */
const RMP_CACHE = new Map();
const RMP_TTL_MS = 24 * 60 * 60 * 1000;
const rmpKey = (name, all) => `${name.toLowerCase()}|all:${all ? 1 : 0}`;
function rmpGet(name, all) {
  const k = rmpKey(name, all);
  const hit = RMP_CACHE.get(k);
  if (hit && Date.now() - hit.ts < RMP_TTL_MS) return hit.data;
  if (hit) RMP_CACHE.delete(k);
  return null;
}
function rmpSet(name, all, data) {
  RMP_CACHE.set(rmpKey(name, all), { ts: Date.now(), data });
}

/* -------------------------------- Routes ------------------------------- */
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/api/reddit/search", async (req, res) => {
  const course = (req.query.course || "").trim();
  const topic = (req.query.topic || "difficulty").trim();
  const windowDays = Number(req.query.windowDays || 540);
  const limit = Math.min(50, Number(req.query.limit || 20));
  if (!course) return res.status(400).json({ error: "Missing course" });

  const subs = (process.env.SUBREDDITS || "r/Concordia")
    .split(",").map((s) => s.trim().replace(/^r\//, ""));
  const afterTs = sinceDaysToTimestamp(windowDays);
  const searchQ = `${courseVariants(course)} AND ${topicQuery[topic] || ""}`;

  try {
    const posts = await withTimeout(
      searchReddit({ subreddits: subs, searchQ, afterTs, limit }),
      6000,
      "overall"
    );
    res.json({
      query: { course, topic, windowDays, limit, subreddits: subs.map((s) => `r/${s}`) },
      count: posts.length,
      posts,
      note: "Community results from Reddit. These reflect opinions/experiences, not official university guidance.",
    });
  } catch (e) {
    console.error("search error:", e.message || e);
    res.status(504).json({ error: "Timeout talking to Reddit", detail: String(e) });
  }
});

app.get("/api/reddit/answer", async (req, res) => {
  const course = (req.query.course || "").trim();
  const question = (req.query.question || "").trim();
  const windowDays = Number(req.query.windowDays || 540);
  const limit = Math.min(20, Number(req.query.limit || 8));
  if (!course) return res.status(400).json({ error: "Missing course" });

  const topic = inferTopicFromQuestion(question);
  const subs = (process.env.SUBREDDITS || "r/Concordia")
    .split(",").map((s) => s.trim().replace(/^r\//, ""));
  const afterTs = sinceDaysToTimestamp(windowDays);
  const searchQ = `${courseVariants(course)} AND ${topicQuery[topic] || ""}`;

  try {
    const posts = await withTimeout(
      searchReddit({ subreddits: subs, searchQ, afterTs, limit }),
      6000,
      "overall"
    );
    const { answer, sources } = summarizePosts(posts, course, topic);
    res.json({
      course, topic, question,
      count: posts.length,
      answer, sources,
      note: "Community results from Reddit. These reflect opinions/experiences, not official university guidance.",
    });
  } catch (e) {
    console.error("answer error:", e.message || e);
    res.status(504).json({ error: "Timeout talking to Reddit", detail: String(e) });
  }
});

/* ------------------------ RateMyProfessors scrape ----------------------- */
app.get("/api/rmp", async (req, res) => {
  const name = (req.query.name || "").trim();
  const all = String(req.query.all || "0") === "1";
  const SCHOOL_ID = process.env.RMP_SCHOOL_ID || "18443"; // Concordia
  const SCHOOL_NAME = "Concordia University";
  if (!name) return res.status(400).json({ error: "Missing professor name" });

  // Cache
  const cached = rmpGet(name, all);
  if (cached) return res.json(cached);

  // Try both search URL variants
  const candidates = [
    `https://www.ratemyprofessors.com/search/professors?q=${encodeURIComponent(name)}&sid=${SCHOOL_ID}`,
    `https://www.ratemyprofessors.com/search/professors/${SCHOOL_ID}?q=${encodeURIComponent(name)}`,
  ];

  const OVERALL_TIMEOUT_MS = 20000;
  let overallTimer;
  const hardFail = (reason) => {
    clearTimeout(overallTimer);
    res.status(504).json({ error: "RMP scrape failed", detail: reason || "timeout" });
  };
  overallTimer = setTimeout(() => hardFail("overall-timeout"), OVERALL_TIMEOUT_MS);

  // function body will run in browser; norm is passed as a string
  const normJS = `
    (s)=> (s||"")
      .replace(/\\u00A0/g," ")
      .replace(/[\\u200B-\\u200D\\uFEFF]/g,"")
      .replace(/\\s+/g," ")
      .trim()
  `;

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    // Open first good candidate
    let ok = false;
    for (const url of candidates) {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
      const status = resp ? resp.status() : 0;
      if (status && status < 400) { ok = true; break; }
    }
    if (!ok) throw new Error("All RMP search URL variants returned an error (e.g., 404)");

    await sleep(900);
    try {
      await page.waitForSelector('a[href^="/professor/"], [data-testid*="noResults"], [class*="NoResults"]', { timeout: 6000 });
    } catch {}

    // ---------- FIXED: single backslashes in regex literals ----------
    const results = await page.evaluate((normStr) => {
      const norm = eval(normStr);
      const anchors = Array.from(document.querySelectorAll('a[href^="/professor/"]'));
      if (!anchors.length) return [];

      const pickName = (raw) => {
        const s = norm(raw);
        const m = s.match(/^[A-Za-z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+){1,3}$/);
        return m ? m[0] : s;
      };

      const uniq = new Map();
      for (const a of anchors) {
        const href = a.getAttribute("href");
        const card =
          a.closest("article") ||
          a.closest('[class*="Card"]') ||
          a.closest("section") ||
          a.closest("div");

        const txt = norm(card?.innerText || a.innerText || document.body.innerText || "");
        const name = pickName(a.innerText || a.textContent || txt);

        const quality =
          (txt.match(/QUALITY\s*([\d.]+)/i) || [])[1] ||
          (txt.match(/\boverall quality\b.*?([\d.]+)/i) || [])[1] ||
          (txt.match(/\b([\d.]+)\s*(?:quality|overall)\b/i) || [])[1] ||
          null;

        let difficulty = null;
        let m =
          txt.match(/level\s*of\s*difficulty\s*[:\s]*([\d.]{1,3})(?:\s*\/\s*5)?/i) ||
          txt.match(/([\d.]{1,3})\s*level\s*of\s*difficulty/i) ||
          txt.match(/difficulty\s*[:\s]*([\d.]{1,3})/i);
        if (m) difficulty = m[1];

        const would =
          (txt.match(/(\d{1,3})%\s*would\s*take\s*again/i) || [])[1] ||
          (txt.match(/would\s*take\s*again\s*[:\s]+(\d{1,3})%/i) || [])[1] || null;

        const numRatings = (txt.match(/(\d+)\s*ratings?/i) || [])[1] || null;

        const schoolMatch =
          txt.match(/\bConcordia University\b/i) ||
          txt.match(/\b[A-Za-z .'-]*University\b/i);
        const school = schoolMatch ? schoolMatch[0].trim() : null;

        const deptMatch = txt.match(
          /\b(Computer Science|Mathematics|Engineering|Biology|Chemistry|Physics|Statistics|Business|Finance|Accounting|Marketing|Psychology|Sociology|Philosophy|History|Political Science|Fine Arts|Anthropology|Film|Social Science|Social Sciences)\b/i
        );
        const dept = deptMatch ? deptMatch[0] : null;

        if (href && name && !uniq.has(href)) {
          uniq.set(href, {
            name, school, dept, quality, difficulty,
            wouldTakeAgain: would, numRatings,
            url: `https://www.ratemyprofessors.com${href}`,
            blockText: txt,
          });
        }
      }
      return Array.from(uniq.values());
    }, normJS);

    const pool = (String(all) === "true" || all)
      ? results
      : results.filter(
          (r) =>
            (r.school && /concordia university/i.test(r.school)) ||
            /concordia university/i.test(r.blockText || "")
        );

    const needsEnrich = pool.slice(0, 3).filter(
      (r) => !r.difficulty || !r.quality || !r.numRatings || !r.dept
    );

    for (const t of needsEnrich) {
      try {
        const resp = await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
        if (!resp || resp.status() >= 400) continue;
        await sleep(600);

        // ---------- FIXED: single backslashes here too ----------
        const extra = await page.evaluate((normStr) => {
          const norm = eval(normStr);
          const body = norm(document.body.innerText || "");

          const quality =
            (body.match(/Overall\s+Quality\s+Based\s+on\s+\d+\s+ratings?\s*([\d.]{1,3})/i) || [])[1] ||
            (body.match(/\b([\d.]{1,3})\s*\/\s*5\b/) || [])[1] ||
            null;

          const numRatings =
            (body.match(/Overall\s+Quality\s+Based\s+on\s+(\d+)\s+ratings?/i) || [])[1] || null;

          const would =
            (body.match(/(\d{1,3})%\s*Would\s*take\s*again/i) || [])[1] ||
            (body.match(/Would\s*take\s*again\s*[:\s]+(\d{1,3})%/i) || [])[1] ||
            null;

          const difficulty =
            (body.match(/Level\s+of\s+Difficulty\s*([\d.]{1,3})/i) || [])[1] ||
            (body.match(/([\d.]{1,3})\s*Level\s+of\s+Difficulty/i) || [])[1] ||
            null;

          const dept =
            (body.match(/in\s+the\s+([A-Za-z &'-]+?)\s+department\b/i) || [])[1] ||
            (body.match(/Professor\s+in\s+the\s+([A-Za-z &'-]+?)\s+department/i) || [])[1] ||
            null;

          return { quality, numRatings, wouldTakeAgain: would, difficulty, dept };
        }, normJS);

        if (extra.quality) t.quality = extra.quality;
        if (extra.numRatings) t.numRatings = extra.numRatings;
        if (extra.wouldTakeAgain) t.wouldTakeAgain = extra.wouldTakeAgain;
        if (extra.difficulty) t.difficulty = extra.difficulty;
        if (extra.dept && !t.dept) t.dept = extra.dept;
      } catch {}
    }

    if (!pool.length) {
      clearTimeout(overallTimer);
      const payload = { count: 0, top: null, others: [], school: SCHOOL_NAME, all };
      rmpSet(name, all, payload);
      return res.json(payload);
    }

    const nameLc = name.toLowerCase();
    const scored = pool
      .map((r) => {
        const n = (r.name || "").toLowerCase();
        let score = 0;
        if (n === nameLc) score += 3;
        if (n.startsWith(nameLc)) score += 2;
        if (n.includes(nameLc)) score += 1;
        const ratingsNum = parseInt(String(r.numRatings || "").replace(/\D+/g, ""), 10) || 0;
        score += Math.min(2, Math.floor(ratingsNum / 10));
        if (ratingsNum > 0) score += 1;
        return { score, r };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.r);

    const top = scored[0];
    const others = scored.slice(1);

    clearTimeout(overallTimer);
    const payload = { count: scored.length, top, others, school: SCHOOL_NAME, all };
    rmpSet(name, all, payload);
    res.json(payload);
  } catch (e) {
    clearTimeout(overallTimer);
    console.error("rmp error:", e?.message || e);
    res.status(500).json({ error: "RMP scrape failed", detail: String(e?.message || e) });
  } finally {
    try { await page?.close(); } catch {}
  }
});

/* ----------------------------- Start ----------------------------- */
const port = process.env.PORT || 4000;
const host = process.env.HOST || "0.0.0.0"; // bind externally on Render
app.listen(port, host, () => {
  console.log(`Community service listening on http://${host}:${port}`);
});
