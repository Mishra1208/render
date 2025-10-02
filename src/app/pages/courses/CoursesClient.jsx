"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "./courses.module.css";
import { fetchCourses, fetchSubjects } from "@/lib/mockApi";
import AddButton from "@/components/AddButton";

const KEY = "conu-planner:selected";

/* -------------------------------- helpers -------------------------------- */
const safeUpper = (v) => (v ?? "").toString().trim().toUpperCase();

const loadList = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
};

const saveList = (arr) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch {}
};

function courseKey(c) {
  const subj = safeUpper(c?.subject);
  const cat = safeUpper(c?.catalogue);
  const term = safeUpper(c?.term) || "TERMLESS";
  return `${subj}-${cat}-${term}`;
}

function dedupeByOffering(list) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const k = courseKey(it);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

function broadcastPlannerChange() {
  try {
    window.dispatchEvent(new Event("planner:update"));
  } catch {}
}

/* -------------------------------- component ------------------------------- */
export default function CoursesClient() {
  const params = useSearchParams();
  const router = useRouter();

  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  const [subjects, setSubjects] = useState(["COMP", "COEN", "SOEN", "MECH", "ENGR", "ENCS", "AERO"]); // default until loaded
  const [selectedKeys, setSelectedKeys] = useState(new Set());
  const [toast, setToast] = useState(null); // { text, kind: "ok"|"warn" }

  const refreshSelectedFromStorage = () => {
    const list = loadList();
    setSelectedKeys(new Set(list.map((i) => courseKey(i))));
  };

  useEffect(() => {
    refreshSelectedFromStorage();
  }, []);

  useEffect(() => {
    const onStorage = (e) => {
      if (e?.key === KEY || e?.key == null) refreshSelectedFromStorage();
    };
    const onVisible = () => {
      if (!document.hidden) refreshSelectedFromStorage();
    };
    const onPlannerUpdate = () => refreshSelectedFromStorage();

    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("planner:update", onPlannerUpdate);

    return () => {
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("planner:update", onPlannerUpdate);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1500);
    return () => clearTimeout(t);
  }, [toast]);

  const f = useMemo(
    () => ({
      search: params.get("search") || "",
      subject: params.get("subject") || "ALL",
      term: params.get("term") || "ALL",
      minCredits: Number(params.get("minCredits") ?? 0),
      maxCredits: Number(params.get("maxCredits") ?? 6),
    }),
    [params]
  );

  // Load subjects (unique list from CSV)
  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await fetchSubjects();
      if (!alive) return;
      // Keep only the 7 engineering subjects you want (and sort them nicely)
      const allow = new Set(["COMP", "COEN", "SOEN", "MECH", "ENGR", "ENCS", "AERO"]);
      const filtered = list.filter((s) => allow.has(s));
      const ordered = ["COMP", "COEN", "SOEN", "MECH", "ENGR", "ENCS", "AERO"].filter((s) =>
        filtered.includes(s)
      );
      setSubjects(ordered.length ? ordered : ["COMP", "COEN", "SOEN", "MECH", "ENGR", "ENCS", "AERO"]);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Load courses according to filters
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const res = await fetchCourses(f);
      if (!alive) return;
      setData(Array.isArray(res) ? res : []);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [f]);

  async function addToPlanner(course) {
    const key = courseKey(course);

    if (selectedKeys.has(key)) {
      const termLabel = course?.term ? ` for ${course.term}` : "";
      setToast({ text: `Course already added to the planner${termLabel}`, kind: "warn" });
      return false;
    }

    const list = loadList();
    const next = dedupeByOffering([...list, course]);
    saveList(next);

    setSelectedKeys((prev) => {
      const s = new Set(prev);
      s.add(key);
      return s;
    });

    broadcastPlannerChange();
    setToast({ text: "Added to planner", kind: "ok" });
    return true;
  }

  return (
    <main className={styles.wrap}>
      <div className={styles.head}>
        <h1 className="h2">Courses</h1>
      </div>

      <FiltersInline
        subjects={subjects}
        onApply={(q) => router.push(`/pages/courses?${q}`)}
      />

      {loading ? (
        <p className="body">Loading…</p>
      ) : data.length === 0 ? (
        <p className="body">No results. Try adjusting filters.</p>
      ) : (
        <div className="cards grid">
          <div className={styles.grid}>
            {data.map((c) => {
              const k = courseKey(c);
              const isSelected = selectedKeys.has(k);

              const anchorId = `${safeUpper(c?.subject)}-${safeUpper(c?.catalogue)}`;
              const descHref = `/pages/courses/descriptions#${anchorId}`;

              return (
                <div key={k} className={`card ${isSelected ? styles.cardSelected : ""}`}>
                  <div className="courseCode">
                    <strong>
                      {c?.subject} {c?.catalogue}
                    </strong>
                  </div>

                  <div className={`cardTitle ${isSelected ? styles.cardTitleAdded : ""}`}>
                    {c?.title}
                  </div>

                  <div className="cardMeta">
                    {(c?.credits ?? "-")} cr {c?.session ? `• ${c.session}` : ""} {c?.term ? `• ${c.term}` : ""}
                  </div>

                  <div className={styles.actions}>
                    <AddButton onAdd={() => addToPlanner(c)} />
                    <a className={styles.ghostBtn} href={descHref}>
                      Get Description
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {toast && (
        <div className={styles.toast} data-kind={toast.kind} aria-live="polite">
          {toast.text}
        </div>
      )}
    </main>
  );
}

/* --------------------------- inline child component --------------------------- */
function FiltersInline({ onApply, subjects = [] }) {
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [subject, setSubject] = useState(params.get("subject") ?? "ALL");
  const [term, setTerm] = useState(params.get("term") ?? "ALL");
  const [minCredits, setMinCredits] = useState(params.get("minCredits") ?? "0");
  const [maxCredits, setMaxCredits] = useState(params.get("maxCredits") ?? "6");

  function apply(e) {
    e.preventDefault();
    const q = new URLSearchParams();
    if (search) q.set("search", search);
    if (subject !== "ALL") q.set("subject", subject);
    if (term !== "ALL") q.set("term", term);
    q.set("minCredits", minCredits);
    q.set("maxCredits", maxCredits);
    onApply?.(q.toString());
  }

  return (
    <form className={styles.filters} onSubmit={apply}>
      <input
        className={styles.input}
        placeholder="Search title/code…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <select className={styles.select} value={subject} onChange={(e) => setSubject(e.target.value)}>
        <option value="ALL">All Subjects</option>
        {subjects.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <select className={styles.select} value={term} onChange={(e) => setTerm(e.target.value)}>
        <option value="ALL">All Terms</option>
        <option value="Fall">Fall</option>
        <option value="Winter">Winter</option>
        <option value="Summer">Summer</option>
      </select>

      <input
        className={styles.number}
        type="number"
        min="0"
        max="6"
        value={minCredits}
        onChange={(e) => setMinCredits(e.target.value)}
      />
      <span className={styles.to}>to</span>
      <input
        className={styles.number}
        type="number"
        min="0"
        max="6"
        value={maxCredits}
        onChange={(e) => setMaxCredits(e.target.value)}
      />
      <button className={styles.applyBtn}>Apply</button>
    </form>
  );
}
