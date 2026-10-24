import Link from "next/link";

import { minutesLabel, TodayList } from "@/app/today/TodayList";
import { Icon } from "@/app/ui/Icon";
import type { Plan } from "@/lib/today";

/** The top of the plan, for the home page: what to do first when Lockin opens. */
export function TodayCard({ plan }: { plan: Plan }) {
  if (!plan.items.length) return null;
  return (
    <section className="today-card">
      <div className="today-card-head">
        <h2>
          <Icon name="calendar" /> Today
        </h2>
        <span className="small muted">
          About {minutesLabel(plan.minutes)}
          {plan.exams[0] ? ` · ${plan.exams[0].code} exam in ${plan.exams[0].days} day${plan.exams[0].days === 1 ? "" : "s"}` : ""}
        </span>
        <span className="spacer" />
        <Link href="/today" className="small link">
          Full plan →
        </Link>
      </div>
      <TodayList items={plan.items.slice(0, 4)} />
      {plan.items.length > 4 && (
        <Link href="/today" className="small muted link">
          and {plan.items.length - 4} more
        </Link>
      )}
    </section>
  );
}
