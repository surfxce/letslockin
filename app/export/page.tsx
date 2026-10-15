import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";

import { ExportOptions } from "@/app/export/ExportOptions";
import { FitToPage } from "@/app/export/FitToPage";
import { Tag } from "@/app/ui/bits";
import { Markdown } from "@/app/ui/render";
import { SlideErrors } from "@/app/ui/SlideErrors";
import { loadExport, type ExportData } from "@/lib/export-data";
import { exportHref, PAPER, parseExportParams, type ExportRequest } from "@/lib/export";
import { longDate, plural, tagTone } from "@/lib/format";
import { renderMarkdown, type SlideImages } from "@/lib/markdown";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page's title and its body both need the export; load it once a request. */
const load = cache((href: string) => {
  const query = Object.fromEntries(new URLSearchParams(href.split("?")[1] ?? ""));
  return loadExport(parseExportParams(query));
});

async function read(searchParams: SearchParams): Promise<{ request: ExportRequest; data: ExportData }> {
  const request = parseExportParams(await searchParams);
  return { request, data: await load(exportHref(request)) };
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  // A browser's "Save as PDF" offers the page's title as the file name.
  const { data } = await read(searchParams);
  return { title: data.title };
}

/**
 * Lecture summaries as a printable document: a whole course, one module or chosen
 * lectures, with their slide pictures (crops and all), formatting and glossaries. The
 * panel at the top is for the screen; printing — or the desktop app's Save as PDF,
 * which prints this same address in a hidden window — shows only the document.
 */
export default async function ExportPage({ searchParams }: { searchParams: SearchParams }) {
  const { request, data } = await read(searchParams);
  const { course, lectures } = data;

  return (
    <main className="page export-page">
      {/* The paper size is the user's choice, so the page rule can't live in the stylesheet. */}
      <style>{`@page { size: ${PAPER[request.paper].css}; margin: 16mm 15mm 18mm; }`}</style>

      <div className="export-panel">
        <nav className="crumbs">
          <Link href="/">Lectures</Link>
          {course && (
            <>
              <span className="sep">/</span>
              <Link href={`/?course=${course.id}`}>{course.code}</Link>
            </>
          )}
          <span className="sep">/</span>
          <span>Export</span>
        </nav>
        <h1 className="page-title">Export summaries</h1>
        <p className="page-sub">
          A PDF of your summaries — slide pictures, crops and formatting included — to print, annotate or read
          anywhere.
        </p>

        {!course ? (
          <div className="empty">
            <p>There are no courses yet, so there is nothing to export.</p>
            <Link href="/courses/new" className="btn primary">
              Add a course
            </Link>
          </div>
        ) : (
          <>
            <ExportOptions
              request={request}
              courses={data.courses}
              courseId={course.id}
              modules={data.modules}
              unsorted={data.unsorted}
              choices={data.choices}
              scope={data.scope}
              moduleId={data.module?.id ?? null}
              save={{ title: data.title, count: lectures.length, leftOut: data.leftOut, href: exportHref(request) }}
            />
          </>
        )}
      </div>

      {course && lectures.length > 0 && <ExportDocument data={data} request={request} />}
    </main>
  );
}

/**
 * A summary under its lecture's title. Its own top-level headings step down a level,
 * so the PDF's bookmarks keep one top-level entry per lecture.
 */
function Summary({ md, slides }: { md: string; slides?: SlideImages }) {
  const html = renderMarkdown(md, slides).replace(/<(\/?)h1(?=[\s>])/g, "<$1h2");
  return <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ExportDocument({ data, request }: { data: ExportData; request: ExportRequest }) {
  const course = data.course!;
  const { lectures } = data;
  const titlePage = request.contents && lectures.length > 1;
  const scopeLine =
    data.scope === "module" ? data.module!.title : data.scope === "lectures" ? "Chosen lectures" : "Every lecture";
  const first = longDate(lectures[0].deliveredOn);
  const last = longDate(lectures[lectures.length - 1].deliveredOn);

  return (
    <article className="export-doc">
      {titlePage && (
        <section className="export-cover">
          <p className="export-kicker">
            <Tag tone={tagTone(course.code)}>{course.code}</Tag>
          </p>
          <h1 className="export-course">{course.title}</h1>
          <p className="export-scope">{scopeLine}</p>
          <p className="export-meta">
            {plural(lectures.length, "lecture")} · {first}
            {last !== first ? ` – ${last}` : ""}
          </p>
          <h2 className="export-contents-head">Contents</h2>
          <ol className="export-contents">
            {lectures.map((l) => (
              <li key={l.id}>
                <a href={`#lecture-${l.id}`}>
                  <span className="ord">L{l.ordinal}</span>
                  <span className="t">{l.title}</span>
                  <span className="m">
                    {[l.moduleTitle, longDate(l.deliveredOn)].filter(Boolean).join(" · ")}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </section>
      )}

      {lectures.map((l) => (
        <section key={l.id} className="export-lecture" id={`lecture-${l.id}`}>
          <p className="export-kicker">
            {course.code} · L{l.ordinal}
            {l.moduleTitle ? ` · ${l.moduleTitle}` : ""} · {longDate(l.deliveredOn)}
          </p>
          <h1 className="export-title">{l.title}</h1>
          <Summary md={l.summaryMd} slides={l.slides} />
          {request.glossary && l.glossary.length > 0 && (
            <section className="export-glossary">
              <h2>Glossary</h2>
              <dl>
                {l.glossary.map((t, i) => (
                  <div key={`${i}:${t.term}`}>
                    <dt>{t.term}</dt>
                    <dd>
                      <Markdown md={t.explanation} className="prose export-gl-text" />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </section>
      ))}
      <FitToPage watch={exportHref(request)} />
      {request.pictures && <SlideErrors watch={exportHref(request)} />}
    </article>
  );
}
