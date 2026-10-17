import { redirect } from "next/navigation";

/** Courses are a view of the lecture database now; keep old links working. */
export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/?course=${id}`);
}
