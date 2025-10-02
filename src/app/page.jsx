export const dynamic = "force-dynamic";
import Link from "next/link";
import styles from "./home.module.css";
import SplitText from "@/components/SplitText";
import RotatingText from "@/components/RotatingText";
import CalendarEvent from "@/components/widgets/CalendarEvent";
import Image from "next/image";
import Notes from "@/components/widgets/Notes";

import { Playfair_Display } from "next/font/google";
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["700", "800", "900"] });

export default async function HomePage() {
  return (
    <main className={styles.page}>
      <section className={`${styles.section} ${styles.hero}`}>
        <div className={styles.container}>
          {/* Hero */}
          <div className={styles.heroGrid}>
            {/* LEFT — column 1 */}
            <div className={styles.heroLeft}>
              <p className={styles.kicker}>ConU Planner</p>

              <SplitText
                tag="h1"
                text="Plan your Concordia courses with clarity"
                className={styles.title}
                textAlign="left"
                splitType="words, chars"
                delay={60}
                duration={0.5}
                ease="power3.out"
                from={{ opacity: 0, y: 28 }}
                to={{ opacity: 1, y: 0 }}
                threshold={0.15}
                rootMargin="-120px"
              />

              <p className={styles.subtitle}>
                Search COMP &amp; SOEN courses, filter by term, credits, session and more then
                build your perfect schedule.
              </p>

              {/* CTAs */}
              <div className={styles.ctaRow}>
                <Link href="/pages/courses" className={`${styles.btnPrimary} ${styles.btnLg}`}>
                  Browse courses
                </Link>
                <Link href="/pages/planner" className={styles.btnGhost}>
                  Open planner
                </Link>
              </div>

              {/* Rotating line */}
              <div className={styles.rotatorRow}>
                <span className={`${styles.ctaPrefix} ${styles.ctaPrefixLarge} ${playfair.className}`}>
                  All you have to
                </span>
                <RotatingText
                  texts={["Firstly search", "Make your Select ", "Move on to Add/Remove", "Finally Download"]}
                  mainClassName={styles.rotatorChip}
                  staggerFrom="last"
                  initial={{ y: "120%", opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: "-120%", opacity: 0 }}
                  staggerDuration={0.03}
                  transition={{ type: "spring", damping: 30, stiffness: 400 }}
                  rotationInterval={2800}
                />
              </div>

              {/* mini steps */}
              <ul className={styles.steps}>
                <li><span>1</span> Search COMP/SOEN courses</li>
                <li><span>2</span> Select term & credits</li>
                <li><span>3</span> Add to Planner or Download</li>
              </ul>
            </div>

            {/* RIGHT rail — slideshow only */}
            <div className={styles.rightRail}>
              <aside className={styles.showcase}>
                <div className={styles.showcaseInner}>
                  <Image
                    src="/img1.jpg"
                    alt="Campus life"
                    fill
                    priority
                    sizes="(max-width: 980px) 100vw, 520px"
                    className={`${styles.slide} ${styles.s1}`}
                  />
                  <Image
                    src="/img2.jpg"
                    alt="Study space"
                    fill
                    sizes="(max-width: 980px) 100vw, 520px"
                    className={`${styles.slide} ${styles.s2}`}
                  />
                  <Image
                    src="/img3.jpg"
                    alt="Concordia vibes"
                    fill
                    sizes="(max-width: 980px) 100vw, 520px"
                    className={`${styles.slide} ${styles.s3}`}
                  />
                  <Image
                    src="/img4.jpg"
                    alt="Concordia vibes"
                    fill
                    sizes="(max-width: 980px) 100vw, 520px"
                    className={`${styles.slide} ${styles.s3}`}
                  />
                  <Image
                    src="/img5.jpg"
                    alt="Concordia vibes"
                    fill
                    sizes="(max-width: 980px) 100vw, 520px"
                    className={`${styles.slide} ${styles.s3}`}
                  />
                </div>
                <div className={styles.showcaseGlow} />
                <div className={styles.showcaseShine} />
              </aside>
            </div>
          </div>{/* <-- closes .heroGrid */}

          {/* Full-width row */}
          <div className={styles.calRow}>
            <p className={styles.calCopy}>
              <strong>Plan once</strong>, tweak in seconds, and skip the headaches. Save hours each term and
              cut the stress with a clear, glanceable schedule.
            </p>
            <div className={styles.calDock}>
              <CalendarEvent show={3} />
            </div>
          </div>

          {/* Note below the calendar, left-aligned */}
          <div className={styles.noteRow}>
            <Notes />
          </div>
        </div>
      </section>
    </main>
  );
}
