import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./markdown";

const slides = { base: "/api/lectures/abc/slides", ranges: [[1, 5]] as Array<[number, number]> };

describe("renderMarkdown", () => {
  it("shows a cited slide as its picture, captioned, outside any paragraph", () => {
    const html = renderMarkdown("Ghrelin rises before meals.\n\n![The ghrelin pathway](slide:2)\n", slides);
    expect(html).toContain(
      '<figure class="slide-fig"><a href="/api/lectures/abc/slides/2" target="_blank" rel="noopener">' +
        '<img src="/api/lectures/abc/slides/2" alt="The ghrelin pathway" loading="lazy"></a>' +
        "<figcaption>The ghrelin pathway <span>· slide 2</span></figcaption></figure>",
    );
    expect(html).not.toMatch(/<p>\s*<figure/);
  });

  it("keeps the caption, without a broken image, when the slide has no picture", () => {
    expect(renderMarkdown("![Vagal afferents](slide:9)", slides)).toContain(
      '<figure class="slide-fig missing"><figcaption>Vagal afferents <span>· slide 9</span>',
    );
    expect(renderMarkdown("![Vagal afferents](slide:2)")).toContain('class="slide-fig missing"');
  });

  it("still strips anything that could run", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)"><script>alert(2)</script>[a](javascript:alert(3))');
    expect(html).not.toMatch(/onerror|<script|javascript:/);
  });
});
