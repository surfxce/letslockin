import Link from "next/link";

import { Icon, type IconName } from "@/app/ui/Icon";
import type { PlanItem, PlanKind } from "@/lib/today";

const ICON: Record<PlanKind, IconName> = { cards: "layers", laq: "pen", weak: "target", "new-cards": "sparkles", exam: "clock" };

export function minutesLabel(m: number): string {
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** The plan's steps, in order, each a link to where it's done. */
export function TodayList({ items, numbered = true }: { items: PlanItem[]; numbered?: boolean }) {
  return (
    <ol className={`today-list${numbered ? "" : " plain"}`}>
      {items.map((item) => (
        <li key={item.id} className={item.urgent ? "urgent" : undefined}>
          <Link href={item.href} className="today-item">
            <span className={`today-icon k-${item.kind}`}>
              <Icon name={ICON[item.kind]} size={16} />
            </span>
            <span className="today-text">
              <span className="today-title">{item.title}</span>
              <span className="today-detail">{item.detail}</span>
            </span>
            <span className="today-min">{minutesLabel(item.minutes)}</span>
            <Icon name="chevronRight" size={15} />
          </Link>
        </li>
      ))}
    </ol>
  );
}
