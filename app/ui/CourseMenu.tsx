"use client";

import Link from "next/link";

import { Icon } from "@/app/ui/Icon";
import { Menu } from "@/app/ui/Menu";

/** In the all-courses view, adding lectures starts by picking which course they belong to. */
export function CourseMenu({ courses }: { courses: Array<{ id: string; code: string; title: string }> }) {
  return (
    <Menu
      buttonClassName="btn primary"
      label={
        <>
          <Icon name="plus" /> Add lectures <Icon name="chevronDown" size={14} />
        </>
      }
    >
      {(close) =>
        courses.map((c) => (
          <div key={c.id}>
            <div className="menu-label">
              {c.code} · {c.title}
            </div>
            <Link href={`/courses/${c.id}/import`} className="item" onClick={close}>
              <Icon name="folder" size={15} /> Import a folder
            </Link>
            <Link href={`/lectures/new?course=${c.id}`} className="item" onClick={close}>
              <Icon name="plus" size={15} /> One lecture
            </Link>
          </div>
        ))
      }
    </Menu>
  );
}
