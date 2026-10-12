import Link from "next/link";
import { notFound } from "next/navigation";

import { ImportFlow } from "@/app/courses/[id]/import/ImportFlow";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function ImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { id } = await params;
  const { new: justCreated } = await searchParams;
  const course = await prisma.course.findUnique({
    where: { id },
    include: { modules: { orderBy: { position: "asc" }, select: { title: true } } },
  });
  if (!course) notFound();
  const { mode } = await getSettings();

  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/">Lectures</Link>
        <span className="sep">/</span>
        <Link href={`/?course=${course.id}`}>{course.code}</Link>
        <span className="sep">/</span>
        <span>Import</span>
      </nav>
      <h1 className="page-title">{justCreated ? `Add ${course.code}'s lectures` : "Import a folder"}</h1>
      <p className="page-sub">
        Choose the folder your transcripts and slides are in — subfolders too. Lockin pairs each transcript with its
        slides by lecture number, date or name, right here on your computer, and lists what it found for you to check.
        Nothing is imported until you say so.
      </p>
      <ImportFlow
        courseId={course.id}
        modules={course.modules.map((m) => m.title)}
        mode={mode}
      />
      {justCreated && (
        <p className="small muted" style={{ marginTop: 28 }}>
          Lectures not in one folder? <Link className="link" href={`/lectures/new?course=${course.id}`}>Add them one at a time</Link>.
        </p>
      )}
    </main>
  );
}
