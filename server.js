// FRONTEND-ONLY/conu-community/server.js
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const Snoowrap = require("snoowrap");
const cheerio = require("cheerio");

// Small util
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- Express app ----------------------------- */
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

/* ------------------------ RateMyProfessors (no browser) ----------------------- */
const RMP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Referer": "https://www.ratemyprofessors.com/",
};

function norm(s = "") {
  return String(s)
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const resp = await fetch(url, { headers: RMP_HEADERS, signal: controller.signal });
  clearTimeout(timer);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return await resp.text();
}

function extractProfFromProfileHtml(html) {
  const $ = cheerio.load(html);
  const nextJson = $("#__NEXT_DATA__").text();
  const info = {};

  // Helper to pull with regex from a string
  const pull = (str, re) => {
    const m = str.match(re);
    return m ? m[1] : null;
  };

  try {
    if (nextJson) {
      // Use string search to be resilient across minor payload shape changes.
      info.name =
        pull(nextJson, /"teacherName":"([^"]+)"/) ||
        (pull(nextJson, /"firstName":"([^"]+)"/) &&
          pull(nextJson, /"lastName":"([^"]+)"/) &&
          `${pull(nextJson, /"firstName":"([^"]+)"/)} ${pull(nextJson, /"lastName":"([^"]+)"/)}`);

      info.dept =
        pull(nextJson, /"teacherDepartment":"([^"]+)"/) ||
        pull(nextJson, /"department":"([^"]+)"/);

      info.school =
        pull(nextJson, /"teacherInstitutionName":"([^"]+)"/) ||
        pull(nextJson, /"institutionName":"([^"]+)"/);

      info.quality = pull(nextJson, /"avgRating":\s*([\d.]+)/);
      info.difficulty = pull(nextJson, /"avgDifficulty":\s*([\d.]+)/);
      info.wouldTakeAgain = pull(nextJson, /"wouldTakeAgainPercent":\s*(-?\d+)/);
      info.numRatings = pull(nextJson, /"numRatings":\s*(\d+)/);
    }
  } catch {
    // ignore JSON parse failures; we'll try text fallback below
  }

  // Fallbacks (visible text)
  if (!info.name) {
    const h1 = norm($("h1").first().text());
    if (h1) info.name = h1;
  }
  if (!info.quality) info.quality = pull(html, /Overall\s+Quality[^0-9]*([\d.]+)/i);
  if (!info.difficulty) info.difficulty = pull(html, /Level\s+of\s+Difficulty[^0-9]*([\d.]+)/i);
  if (!info.numRatings) info.numRatings = pull(html, /Based\s+on\s+(\d+)\s+ratings?/i);

  if (info.wouldTakeAgain && Number(info.wouldTakeAgain) < 0) info.wouldTakeAgain = null;

  return info;
}

async function rmpSearchAndProfile(name, schoolId) {
  const searchUrl = `https://www.ratemyprofessors.com/search/professors/${schoolId}?q=${encodeURIComponent(
    name
  )}`;
  const searchHtml = await fetchHtml(searchUrl, 12000);
  const $ = cheerio.load(searchHtml);

  // pick first result link to /professor/<id>
  const href = $('a[href^="/professor/"]').first().attr("href");
  if (!href) return { count: 0, searchUrl };

  const profileUrl = `https://www.ratemyprofessors.com${href}`;
  const profileHtml = await fetchHtml(profileUrl, 12000);
  const info = extractProfFromProfileHtml(profileHtml);

  const ok = info.name || info.quality || info.numRatings;
  return ok
    ? {
        count: 1,
        top: {
          name: info.name || name,
          dept: info.dept || null,
          school: info.school || "Concordia University",
          quality: info.quality || null,
          difficulty: info.difficulty || null,
          wouldTakeAgain: info.wouldTakeAgain || null,
          numRatings: info.numRatings || null,
          url: profileUrl,
        },
        others: [],
        searchUrl,
      }
    : { count: 0, searchUrl };
}

app.get("/api/rmp", async (req, res) => {
  const name = norm(req.query.name || "");
  const all = String(req.query.all || "0") === "1";
  const SCHOOL_ID = process.env.RMP_SCHOOL_ID || "18443"; // Concordia
  const SCHOOL_NAME = "Concordia University";
  if (!name) return res.status(400).json({ error: "Missing professor name" });

  // Cache
  const cached = rmpGet(name, all);
  if (cached) return res.json(cached);

  try {
    const out = await rmpSearchAndProfile(name, SCHOOL_ID);

    // If nothing found, still return a friendly payload
    if (!out.count) {
      const payload = { count: 0, top: null, others: [], school: SCHOOL_NAME, all, searchUrl: out.searchUrl };
      rmpSet(name, all, payload);
      return res.json(payload);
    }

    const payload = { count: out.count, top: out.top, others: out.others, school: SCHOOL_NAME, all };
    rmpSet(name, all, payload);
    return res.json(payload);
  } catch (e) {
    console.error("rmp error:", e?.message || e);
    return res.status(500).json({ error: "RMP scrape failed", detail: String(e?.message || e) });
  }
});

/* ----------------------------- Start ----------------------------- */
const port = process.env.PORT || 4000;
const host = process.env.HOST || "0.0.0.0"; // bind externally on Render
app.listen(port, host, () => {
  console.log(`Community service listening on http://${host}:${port}`);
});
