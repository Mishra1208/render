// src/app/api/chat/route.js
import fs from "fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 0;

/* --------------------------- Community (Reddit) --------------------------- */
const COMMUNITY_API = process.env.COMMUNITY_API_URL || "http://localhost:4000";
const DEV = process.env.NODE_ENV !== "production";
const COMMUNITY_CACHE = new Map();
const COMMUNITY_TTL_MS = 30_000;

const RMP_ENABLED = true;

function log(...a) { if (DEV) console.log("[community]", ...a); }

/* --------------------------- RMP helpers --------------------------- */
function looksLikeProfessorName(q = "") {
  const s = q.trim();
  if (!s) return false;
  if (/\b[A-Z]{3,4}\s*-?\s*\d{3}\b/.test(s)) return false; // course code
  if (/\b(credit|credits|prereq|prerequisite|term|session|offered|location|campus)\b/i.test(s)) return false;
  return /^[A-Za-z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+){1,3}$/.test(s);
}

function formatRow(label, value) {
  const v = value == null || value === "" ? "—" : value;
  return `<div class="kv"><span class="k">${label}</span><span class="v">${v}</span></div>`;
}

function deriveFromBlockText(blockText) {
  const t = (blockText || "");
  const difficulty =
    (t.match(/level\s*of\s*difficulty\s*[:\s]*([\d.]{1,3})/i) || [])[1] ||
    (t.match(/([\d.]{1,3})\s*level\s*of\s*difficulty/i) || [])[1] ||
    null;
  const dept =
    (t.match(/\b(Computer Science|Mathematics|Engineering|Biology|Chemistry|Physics|Statistics|Business|Finance|Accounting|Marketing|Psychology|Sociology|Philosophy|History|Political Science|Fine Arts|Anthropology|Film|Social Science|Social Sciences)\b/i) || [])[1] ||
    null;
  return { difficulty, dept };
}

async function fetchRmpBlock(name) {
  try {
    const norm = (s = "") =>
      String(s).replace(/\u00A0/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();

    const extractHumanName = (raw, fallbacks = []) => {
      const text = norm(raw);
      const stripped = text.replace(/^QUALITY\s*[\d.]+\s*\d+\s*ratings\s*/i, "");
      const m =
        text.match(/([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})/) ||
        (fallbacks[0] && norm(fallbacks[0]).match(/([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})/));
      return (m && (m[1] || m[0])) ? (m[1] || m[0]).trim() : (fallbacks[0] || "");
    };

    async function call(allFlag) {
      const url = new URL("/api/rmp", COMMUNITY_API);
      url.searchParams.set("name", name);
      url.searchParams.set("all", allFlag ? "1" : "0");
      const r = await fetch(url.toString(), { cache: "no-store" });
      if (!r.ok) return null;
      return r.json().catch(() => null);
    }

    const first = await call(false);
    const data = first?.count ? first : (await call(true)); // retry with all=1

    if (!data || !data.count || !data.top) return null;

    const t = data.top;
    const derived = deriveFromBlockText(t.blockText || "");

    let profName = extractHumanName(t.name, [t.blockText, name]);
    profName = profName.replace(/\b(University|College|Department|School)\b.*$/i, "").trim();

    const profDept = t.dept || derived.dept || "—";
    const profDiff = t.difficulty || derived.difficulty || "—";
    const ratingsN = t.numRatings ? String(t.numRatings).replace(/\D+/g, "") : null;
    const qualityLine = ratingsN
      ? `Overall quality (based on ${ratingsN} rating${ratingsN === "1" ? "" : "s"}):`
      : "Overall quality:";

    const rowBlock =
      formatRow("Professor Name:", profName) +
      formatRow("Dept:", profDept) +
      formatRow("School:", t.school || data.school || "—") +
      formatRow(qualityLine, t.quality || "—") +
      formatRow("Would take again:", t.wouldTakeAgain ? `${t.wouldTakeAgain}%` : "—") +
      formatRow("Level of difficulty:", profDiff || "—") +
      (t.url ? `<div class="kv"><span class="k">Profile:</span><span class="v"><a href="${t.url}" target="_blank" rel="noreferrer">Click here</a></span></div>` : "");

    const others = (data.others || []).slice(0, 4).map((o) => {
      const oDerived = deriveFromBlockText(o.blockText || "");
      let nm = extractHumanName(o.name, [o.blockText]);
      return `
        <li>
          <div class="other">
            ${formatRow("Professor Name:", nm)}
            ${formatRow("Dept:", o.dept || oDerived.dept || "—")}
            ${formatRow("School:", o.school || "—")}
            ${formatRow("Overall quality:", o.quality || "—")}
            ${formatRow("Would take again:", o.wouldTakeAgain ? `${o.wouldTakeAgain}%` : "—")}
            ${formatRow("Level of difficulty:", o.difficulty || oDerived.difficulty || "—")}
            ${o.url ? `<div class="kv"><span class="k">Profile:</span><span class="v"><a href="${o.url}" target="_blank" rel="noreferrer">Click here</a></span></div>` : ""}
          </div>
        </li>`;
    }).join("");

    const html = `
      <style>
        .kv{display:flex;gap:.5rem;line-height:1.6}.kv .k{min-width:220px;font-weight:600;opacity:.9}.kv .v{opacity:1}
        .other{padding:.5rem .75rem;border:1px solid rgba(0,0,0,.08);border-radius:8px;margin:.35rem 0}
        .community .pill.rmp{display:inline-block;background:#3b82f6;color:#fff;font-weight:700;font-size:10.5px;letter-spacing:.35px;padding:3px 7px;border-radius:6px;line-height:1;box-shadow:0 1px 0 rgba(0,0,0,.08);position:relative;border:none}
        .community .pill.rmp::after{content:"";position:absolute;bottom:-4px;left:8px;border-width:4px 4px 0 4px;border-style:solid;border-color:#3b82f6 transparent transparent transparent}
      </style>
      <div class="community minimalist">
        <div class="topline">
          <span class="label">RateMyProfessors</span>
          <span class="pill rmp">RMP</span>
        </div>
        <div class="msg">
          <div class="card">${rowBlock}</div>
          ${others ? `<div style="margin-top:10px;"><strong>Other matches:</strong><ul class="rlinks">${others}</ul></div>` : ""}
        </div>
        <div class="rfoot">Unofficial community ratings from RateMyProfessors.</div>
      </div>
    `;
    return html;
  } catch {
    return null;
  }
}


/* --------------------------- Reddit helpers --------------------------- */
function looksCommunityQuestion(q = "") {
  const s = q.toLowerCase();
  if (/\b(credit|credits|cr|prereq|pre[-\s]?req|prerequisite|requirements?|equiv|equivalent|term|terms|semester|offered|session|sessions|location|campus|title)\b/.test(s)) {
    return false;
  }
  return (
    /\b(hard|harder|hardest|difficult|difficulty|tough|easy|easier|easiest|workload|time\s*commitment|drop\s*rate|withdraw(?:al)?\s*rate|fail\s*rate|pass\s*rate|curve|curved|final|midterm|exam|test|quiz|format|grading|grade(?:\s*distribution)?|tips?|advice|study|labs?|assignments?|resources?|textbook|notes)\b/.test(s) ||
    /\b(best|good|great|avoid)\b.*\b(prof\w*|teacher|instructor)\b/.test(s) ||
    /\b(prof\w*|teacher|instructor)\b.*\b(best|good|great|avoid)\b/.test(s) ||
    /\bwho\s*(to|should)\s*take\b/.test(s) ||
    /\b(proff?esor|professer)\b/.test(s) ||
    /\b(prof\w*|teacher|instructor)s?\b/.test(s)
  );
}

const COURSE_RE = /\b([A-Z]{3,4})\s*-?\s*(\d{3})\b/i;
function extractCourseFromText(text) {
  const m = (text || "").match(COURSE_RE);
  return m ? `${(m[1] || "COMP").toUpperCase().trim()} ${m[2].trim()}` : null;
}

async function fetchCommunityAnswer(question, course) {
  const key = `${course}::${question.toLowerCase()}`;
  const now = Date.now();
  const cached = COMMUNITY_CACHE.get(key);
  if (cached && now - cached.ts < COMMUNITY_TTL_MS) return cached.data;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const url = new URL("/api/reddit/answer", COMMUNITY_API);
    url.searchParams.set("question", question);
    url.searchParams.set("course", course);
    url.searchParams.set("limit", "6");
    url.searchParams.set("windowDays", "720");
    const r = await fetch(url.toString(), { signal: controller.signal });
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    if (!data?.answer || data?.count === 0) return null;
    const out = { answer: data.answer, sources: data.sources || [], topic: data.topic, count: data.count };
    COMMUNITY_CACHE.set(key, { ts: now, data: out });
    return out;
  } catch (e) {
    log("answer error", String(e?.name || e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------- CSV bot (course index lookup) --------------------- */
let COURSE_INDEX = null, CODE_MAP = null, TITLE_LIST = null, TITLE_TOKENS_MAP = null;

function normalizeCode(subj, num) {
  return `${(subj || "COMP").toString().trim().toUpperCase()} ${(num || "").toString().trim()}`;
}
const INTENT_WORDS = new Set([
  "credit","credits","cr","prereq","prereqs","prerequisite","prerequisites",
  "requirement","requirements","equivalent","equivalents","term","terms",
  "semester","semesters","offered","when","session","sessions","week",
  "duration","title","what","is","are","for","of","the","in"
]);
function tokenize(str){ return (str||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean); }

async function ensureIndex() {
  if (COURSE_INDEX) return;
  const p = path.join(process.cwd(), "public", "course_index.json");
  const raw = await fs.readFile(p, "utf8");
  COURSE_INDEX = JSON.parse(raw)?.list ?? [];
  CODE_MAP = new Map(); TITLE_LIST = []; TITLE_TOKENS_MAP = new Map();
  for (const item of COURSE_INDEX) {
    const code = normalizeCode(item.subject, item.catalogue);
    CODE_MAP.set(code, item);
    const lowerTitle = (item.title || "").toLowerCase();
    TITLE_LIST.push([code, lowerTitle, item]);
    TITLE_TOKENS_MAP.set(item, new Set(tokenize(lowerTitle)));
  }
}

function prettyPrereq(str=""){ return str.replace(/^course\s+pre[-\s]?requisite[s]?:\s*/i,"").trim(); }

function detectIntent(text) {
  const t = (text ?? "").toLowerCase();
  if (/\bcredit(s)?\b|\bcr\b/.test(t)) return "credits";
  if (/\bpre[-\s]?req(s|uisite|uisites)?\b|\brequirement(s)?\b/.test(t)) return "prereq";
  if (/\bequiv(alent|alents)?\b/.test(t)) return "equivalent";
  if (/\b(term|terms|semester|semesters|offered|when)\b/.test(t)) return "terms";
  if (/\b(session|sessions|week|duration|13w|6h1)\b/.test(t)) return "session";
  if (/\b(location|campus|where)\b/.test(t)) return "location";
  if (/\btitle\b/.test(t)) return "title";
  if (/\bwhat\s+is\b/.test(t)) return "summary";
  return "summary";
}

function answerForIntent(course, intent) {
  const code = `${course.subject} ${course.catalogue}`;
  const name = `${code} — ${course.title || ""}`.trim();

  const buildSummary = () => {
    const lines = [name];
    if (course.credits) lines.push(`${course.credits} credits`);
    if (course.terms?.length) lines.push(`Offered: ${course.terms.join(", ")}`);
    if (course.sessions?.length) lines.push(`Session: ${course.sessions.join(", ")}`);
    if (course.prereq) lines.push(`Prerequisite(s): ${prettyPrereq(course.prereq)}`);
    if (course.equivalent) lines.push(`Equivalent: ${course.equivalent}`);
    if (course.location) lines.push(`Location: ${course.location}`);
    if (course.description) lines.push(`\n${course.description}`);
    return lines.join(" • ");
  };

  switch (intent) {
    case "credits":   return `${code} is ${course.credits || "-"} credits.`;
    case "prereq": {
      const p = prettyPrereq(course.prereq || "");
      return p ? `Prerequisites for ${code}: ${p}` : `There are no listed prerequisites for ${code}.`;
    }
    case "equivalent": {
      const e = (course.equivalent || "").trim();
      return e ? `Course(s) equivalent to ${code}: ${e}` : `No equivalents are listed for ${code}.`;
    }
    case "terms":     return `${code} is offered in: ${course.terms?.length ? course.terms.join(", ") : "—"}.`;
    case "session":   return `${code} session/format: ${course.sessions?.length ? course.sessions.join(", ") : "—"}.`;
    case "location":  return `${code} location: ${course.location || "—"}.`;
    case "title":     return buildSummary();
    default:          return buildSummary();
  }
}

function findByTitleFragment(text){
  const tokens = tokenize(text).filter(t=>!INTENT_WORDS.has(t));
  if (!tokens.length) return null;
  let best=null,bestScore=0;
  for (const [, , item] of TITLE_LIST){
    const titleTokens = TITLE_TOKENS_MAP.get(item);
    let hits=0; for (const t of tokens) if (titleTokens.has(t)) hits++;
    const score = hits / tokens.length;
    if (score>bestScore){ bestScore=score; best=item; }
  }
  return bestScore>=0.4 ? best : null;
}

/* ----------------------------- POST /api/chat ----------------------------- */
export async function POST(req){
  try{
    await ensureIndex();

    const body = await req.json().catch(()=>({}));
    const message = (body?.message ?? body?.q ?? body?.text ?? "").toString().trim();

    if (!message){
      const reply = "Ask about a course, e.g. “How many credits is COMP 248?”";
      return NextResponse.json({ reply, message: reply, answer: reply, text: reply });
    }

    // 1) Professor name → RMP
    if (RMP_ENABLED && looksLikeProfessorName(message)) {
      const html = await fetchRmpBlock(message);
      if (html) return NextResponse.json({ html });
      // friendly fallback instead of CSV
      const reply = "I couldn’t find a RateMyProfessors profile for that name right now. Try the full name (e.g., “Aiman Hanna”), or try again later.";
      return NextResponse.json({ reply, message: reply, answer: reply, text: reply });
    }

    // 2) Community-style question → Reddit
    if (looksCommunityQuestion(message)){
      const courseStr = extractCourseFromText(message) || "COMP 248";
      log("community route →", courseStr);
      const community = await fetchCommunityAnswer(message, courseStr);
      if (community && community.count >= 1){
        return NextResponse.json({
          ok: true,
          course: courseStr,
          topic: community.topic,
          answer: community.answer,
          sources: community.sources
        });
      }
    }

    // 3) CSV fallback
    const code = extractCourseFromText(message);
    const intent = detectIntent(message);
    let course = null;
    if (code && CODE_MAP.has(code)) course = CODE_MAP.get(code);
    else course = findByTitleFragment(message);

    if (!course){
      const reply = "I couldn't find that course in our index. Try a full code like `COMP 248` or a course title (e.g., `fundamentals of programming`).";
      return NextResponse.json({ reply, message: reply, answer: reply, text: reply });
    }

    const reply = answerForIntent(course, intent);
    return NextResponse.json({ reply, message: reply, answer: reply, text: reply });

  } catch(e){
    console.error("Chat route error:", e);
    const reply = "Server error: " + String(e?.message || e);
    return NextResponse.json({ reply, message: reply, answer: reply, text: reply }, { status: 500 });
  }
}