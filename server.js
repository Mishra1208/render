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
// Lower requestDelay to speed things up; still polite to API.
const reddit = new Snoowrap({
    userAgent: process.env.REDDIT_USER_AGENT || "conu-planner/0.1 (dev)",
    clientId: process.env.REDDIT_CLIENT_ID,
    clientSecret: process.env.REDDIT_CLIENT_SECRET,
    username: process.env.REDDIT_USERNAME,
    password: process.env.REDDIT_PASSWORD,
});
reddit.config({ requestDelay: 500, continueAfterRatelimitError: true }); // was 1100

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
    const dashed = course.replace(/\s+/, "-");
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

// 🚀 Parallelize subreddit searches (previously sequential)
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
    let results = nested.flat();

    // 🎯 Post-Processing: Relevance Scoring
    // 1. Filter: Title MUST contain the course code (loose regex match)
    // 2. Score: 
    //    +10 for exact keyword match in title
    //    +5 for "hard", "difficulty", "review", "tips" in title
    //    +Decay based on age (newer is better)

    // Extract core keywords from searchQ (e.g., "COMP 232")
    const courseKeywords = searchQ.match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, "")) || [];
    const topicKeywords = ["hard", "easy", "difficulty", "review", "tips", "advice", "final", "midterm", "prof", "professor", "teacher", "best", "avoid", "recommend"];

    results = results.filter(r => {
        // Must contain at least one course variant in title
        const titleLower = r.title.toLowerCase();
        return courseKeywords.some(k => titleLower.includes(k.toLowerCase().replace("-", " ")));
    }).map(r => {
        let score = 0;
        const titleLower = r.title.toLowerCase();

        // Topic relevance
        topicKeywords.forEach(k => {
            if (titleLower.includes(k)) score += 5;
        });

        // Exact query match bonus
        if (courseKeywords.some(k => titleLower === k.toLowerCase())) score += 10;

        // Recency Score (0-10 points based on age)
        const daysOld = (Date.now() - r.created_utc * 1000) / (1000 * 60 * 60 * 24);
        score += Math.max(0, 10 - (daysOld / 30));

        return { ...r, relevance: score };
    });

    return results
        .sort((a, b) => b.relevance - a.relevance) // Sort by relevance first
        .slice(0, limit);
}

/* -------------------- Puppeteer: persistent singleton -------------------- */
let _browserPromise = null;
async function getBrowser() {
    if (!_browserPromise) {
        // const { executablePath } = require("puppeteer"); // Not needed for auto-resolve
        const flags = (process.env.CHROME_FLAGS || "--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu --headless=new").split(" ");

        console.log("[puppeteer] launching browser with flags:", flags);

        _browserPromise = require("puppeteer-extra").launch({
            headless: true,
            args: flags,
            // executablePath: exe, // Let Puppeteer find the bundled Chrome automatically
        });
    }
    return _browserPromise;
}


// graceful shutdown
async function closeBrowser() {
    try {
        const br = await _browserPromise;
        await br?.close();
    } catch { }
}
process.on("SIGINT", async () => { await closeBrowser(); process.exit(0); });
process.on("SIGTERM", async () => { await closeBrowser(); process.exit(0); });

/* -------------------------- RMP response cache --------------------------- */
// Cache by name + all flag. Evict after 24h.
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
/**
 * GET /api/rmp?name=First%20Last&all=0
 *  - all=0 (default): restrict to Concordia
 *  - all=1         : include other schools
 */
app.get("/api/rmp", async (req, res) => {
    const name = (req.query.name || "").trim();
    const all = String(req.query.all || "0") === "1";
    const SCHOOL_ID = process.env.RMP_SCHOOL_ID || "18443"; // Concordia
    const SCHOOL_NAME = "Concordia University";
    if (!name) return res.status(400).json({ error: "Missing professor name" });

    // 🔒 Cache check
    const cached = rmpGet(name, all);
    if (cached) return res.json(cached);

    const searchUrl = `https://www.ratemyprofessors.com/search/professors/${SCHOOL_ID}?q=${encodeURIComponent(name)}`;

    const OVERALL_TIMEOUT_MS = 20000;
    let overallTimer;
    const hardFail = (reason) => {
        clearTimeout(overallTimer);
        res.status(504).json({ error: "RMP scrape timeout", detail: reason || "timeout" });
    };
    overallTimer = setTimeout(() => hardFail("overall-timeout"), OVERALL_TIMEOUT_MS);

    // normalize helper as a string for evaluate
    const normJS = `
      (s)=> (s||"")
        .replace(/\\u00A0/g," ")
        .replace(/[\\u200B-\\u200D\\uFEFF]/g,"")
        .replace(/\\s+/g," ")
        .trim()
    `;

    let page;
    try {
        const browser = await getBrowser(); // 🚀 persistent browser
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        await page.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        );
        await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

        // 1) Search page
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(900);
        try {
            await page.waitForSelector('a[href^="/professor/"], [data-testid*="noResults"], [class*="NoResults"]', { timeout: 15000 });
        } catch { }


        const results = await page.evaluate((normStr) => {
            const norm = eval(normStr);

            // Collect anchors from several likely containers/selectors
            const anchorSets = [
                'a[href^="/professor/"]',
                '[data-testid*="search"] a[href*="/professor/"]',
                '[class*="Card"] a[href*="/professor/"]',
                'article a[href*="/professor/"]'
            ];

            const seenHref = new Set();
            const found = [];

            function pickName(el, fallbackText) {
                let s = norm(el?.innerText || fallbackText || "");
                // Clean common garbage prefixes if scraper grabs the whole card text
                s = s.replace(/^QUALITY\s*[\d.]+\s*/i, "")
                    .replace(/^\d+\s*ratings?/i, "")
                    .replace(/^[0-9.]+\s*/, "");

                const m = s.match(/^[A-Za-z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+){1,3}/); // Removed strict $ anchor
                return m ? m[0] : s.split("\n")[0];
            }

            function pushFromAnchor(a) {
                const href = a.getAttribute("href");
                if (!href || !href.includes("/professor/") || seenHref.has(href)) return;

                const card = a.closest("article") ||
                    a.closest('[class*="Card"]') ||
                    a.closest("section") ||
                    a.closest("div");

                const txt = norm(card?.innerText || a.innerText || document.body.innerText || "");

                // Name guess
                const name = pickName(a, txt);

                // Parse fields loosely
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

                seenHref.add(href);
                found.push({
                    name,
                    school,
                    dept,
                    quality,
                    difficulty,
                    wouldTakeAgain: would,
                    numRatings,
                    url: `https://www.ratemyprofessors.com${href}`,
                    blockText: txt,
                });
            }

            for (const sel of anchorSets) {
                const anchors = Array.from(document.querySelectorAll(sel));
                anchors.forEach(pushFromAnchor);
            }

            return found;
        }, normJS);


        // AFTER: prefer Concordia; if none, use all results so we still return something
        let pool;
        if (String(all) === "true" || all) {
            pool = results;
        } else {
            const conly = results.filter(
                (r) =>
                    (r.school && /concordia/i.test(r.school)) ||
                    /concordia/i.test(r.blockText || "")
            );
            pool = conly.length ? conly : results; // ✅ fallback to all schools if none tagged Concordia
        }
        console.log("[rmp] results:", results.length, "chosen pool:", pool.length);


        // 2) Enrich missing fields from profile
        const needsEnrich = pool.slice(0, 3).filter(
            (r) => !r.difficulty || !r.quality || !r.numRatings || !r.dept
        );

        for (const t of needsEnrich) {
            try {
                await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 60000 });
                await sleep(600);

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
            } catch { }
        }

        if (!pool.length) {
            clearTimeout(overallTimer);
            const payload = { count: 0, top: null, others: [], school: SCHOOL_NAME, all };
            rmpSet(name, all, payload);
            return res.json(payload);
        }

        // 3) Score & respond
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
        rmpSet(name, all, payload); // ✅ cache it
        res.json(payload);
    } catch (e) {
        clearTimeout(overallTimer);
        console.error("rmp error:", e?.message || e);
        res.status(500).json({ error: "RMP scrape failed", detail: String(e) });
    } finally {
        try { await page?.close(); } catch { } // ✅ close tab, keep browser alive
    }
});

/* --------------------------------- Start -------------------------------- */
const port = process.env.PORT || 4000;


app.listen(port, () => {
    console.log(`Community service listening on port ${port}`);
});