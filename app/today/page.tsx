import "./today.css";

import Link from "next/link";

import { Budget } from "@/app/today/Budget";
import { minutesLabel, TodayList } from "@/app/today/TodayList";
import { Icon } from "@/app/ui/Icon";
import { todayPlan } from "@/lib/today";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const plan = await todayPlan();
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  return (
    <main className="page narrow">
      <div className="today-head">
        <div>
          <h1 className="page-title">Today</h1>
          <p className="page-sub">{date}</p>
        </div>
        <Budget minutes={plan.budget} />
      </div>

      {plan.exams.length > 0 && (
        <div className="today-exams">
          {plan.exams.slice(0, 4).map((e) => (
            <span key={e.courseId} className={`today-exam${e.days <= 7 ? " close" : ""}`}>
              <b>{e.code}</b> exam {e.days === 0 ? "today" : `in ${e.days} day${e.days === 1 ? "" : "s"}`}
            </span>
          ))}
        </div>
      )}

      {plan.items.length ? (
        <>
          <p className="today-summary">
            About <b>{minutesLabel(plan.minutes)}</b>, in this order. The ones in red are overdue or for an exam that&apos;s close.
          </p>
          <TodayList items={plan.items} />
        </>
      ) : (
        <div className="today-clear">
          <Icon name="check" size={28} />
          <h2>Nothing due today</h2>
          <p>Every lecture and card is on schedule. A practice exam or a weak lecture is still time well spent.</p>
          <div className="row" style={{ justifyContent: "center" }}>
            <Link href="/exam" className="btn primary">
              Sit a practice exam
            </Link>
            <Link href="/progress" className="btn">
              See your progress
            </Link>
          </div>
        </div>
      )}

      {plan.later.length > 0 && (
        <section className="today-later">
          <h2>If you have more time</h2>
          <TodayList items={plan.later} numbered={false} />
        </section>
      )}

      {plan.unprepared > 0 && (
        <p className="small muted" style={{ marginTop: 22 }}>
          {plan.unprepared} lecture{plan.unprepared === 1 ? " isn't" : "s aren't"} prepared yet, so {plan.unprepared === 1 ? "it's" : "they're"} not in
          the plan. <Link href="/" className="link">Lectures</Link>
        </p>
      )}
    </main>
  );
}
