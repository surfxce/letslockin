import { describe, expect, it } from "vitest";

import { cleanCrop, markerCrops, renderMarkdown, setFigureCrop, slideNumbers } from "./markdown";

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

  it("reads the ways models actually write slide markers", () => {
    for (const src of ["Slide:2", "slides:2", "slide-2", "p2", "slide: 2", "slide 2", "page 2"]) {
      expect(renderMarkdown(`![Fed state](${src})`, slides), src).toContain('<img src="/api/lectures/abc/slides/2"');
    }
  });

  it("shows a range of slides side by side, with one caption", () => {
    const html = renderMarkdown("![Fed and fasted](slide:3-4)", slides);
    expect(html).toContain('<figure class="slide-fig multi">');
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain("<figcaption>Fed and fasted <span>· slides 3–4</span>");
  });

  it("never shows a broken image for a picture that isn't a slide or a real address", () => {
    const html = renderMarkdown("![A made-up diagram](diagram.png)", slides);
    expect(html).not.toContain("<img");
    expect(html).toContain('<figure class="slide-fig missing"><figcaption>A made-up diagram</figcaption>');
    expect(renderMarkdown("![Real](https://example.com/a.png)", slides)).toContain('<img src="https://example.com/a.png"');
  });

  it("still strips anything that could run", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)"><script>alert(2)</script>[a](javascript:alert(3))');
    expect(html).not.toMatch(/onerror|<script|javascript:/);
  });
});

describe("crops", () => {
  const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.4 };

  it("still reads a cropped marker as its slides", () => {
    expect(slideNumbers("slide:7#crop=7:0.1,0.2,0.5,0.4")).toEqual([7]);
    expect(slideNumbers("slide:7-8#crop=8:0,0,0.5,0.5")).toEqual([7, 8]);
    expect(slideNumbers("slide#7")).toEqual([7]);
    expect(markerCrops("slide:7-8#crop=7:0.1,0.2,0.5,0.4;8:0,0,1,0.5")).toEqual(
      new Map([
        [7, crop],
        [8, { x: 0, y: 0, w: 1, h: 0.5 }],
      ]),
    );
  });

  it("keeps a crop inside the slide and refuses one too small to see", () => {
    expect(cleanCrop({ x: 0.9, y: -1, w: 0.5, h: 2 })).toEqual({ x: 0.9, y: 0, w: 0.1, h: 1 });
    expect(cleanCrop({ x: 0.5, y: 0.5, w: 0.01, h: 0.5 })).toBeNull();
    expect(cleanCrop({ x: NaN, y: 0, w: 1, h: 1 })).toBeNull();
  });

  it("shows a cropped picture, with a Crop button only where asked", () => {
    const md = "![Fed state](slide:2#crop=2:0.1,0.2,0.5,0.4)";
    expect(renderMarkdown(md, slides)).toContain('<img src="/api/lectures/abc/slides/2?crop=0.1,0.2,0.5,0.4"');
    expect(renderMarkdown(md, slides)).not.toContain("slide-crop");
    const html = renderMarkdown(`${md}\n\n![Fasting](slide:3)`, { ...slides, croppable: true });
    expect(html).toContain('class="slide-crop" data-fig="0" data-slide="2" data-crop="0.1,0.2,0.5,0.4"');
    expect(html).toContain('class="slide-crop" data-fig="1" data-slide="3" data-crop=""');
  });

  it("prints pictures as plain, eagerly loaded images, crop and all", () => {
    const html = renderMarkdown("![Fed state](slide:2#crop=2:0.1,0.2,0.5,0.4)", { ...slides, croppable: true, print: true });
    expect(html).toContain('<figure class="slide-fig"><img src="/api/lectures/abc/slides/2?crop=0.1,0.2,0.5,0.4" alt="Fed state">');
    expect(html).not.toMatch(/<a |loading=|slide-crop/);
  });

  it("writes a crop into the right marker, and takes it out again", () => {
    const md = "Intro `![not this](slide:1)`\n\n![A](Slide 2)\n\n```\n![code](slide:2)\n```\n\n![B](slide:2 \"T\")";
    const once = setFigureCrop(md, 1, 2, crop)!;
    expect(once).toContain("![A](Slide 2)");
    expect(once).toContain('![B](slide:2#crop=2:0.1,0.2,0.5,0.4 "T")');
    expect(once).toContain("```\n![code](slide:2)\n```");
    expect(setFigureCrop(once, 1, 2, null)).toContain('![B](slide:2 "T")');
    // A slide this picture doesn't show, or a picture that isn't there: nothing changes.
    expect(setFigureCrop(md, 1, 9, crop)).toBeNull();
    expect(setFigureCrop(md, 5, 2, crop)).toBeNull();
    expect(setFigureCrop(once, 1, 2, crop)).toBe(once);
  });

  it("crops one slide of a pair, and the renderer counts pictures the same way", () => {
    const md = setFigureCrop("![One](slide:1)\n\n![Pair](slide:3-4)", 1, 4, crop)!;
    expect(md).toContain("![Pair](slide:3-4#crop=4:0.1,0.2,0.5,0.4)");
    const html = renderMarkdown(md, { ...slides, croppable: true });
    expect(html).toContain('<img src="/api/lectures/abc/slides/3"');
    expect(html).toContain('<img src="/api/lectures/abc/slides/4?crop=0.1,0.2,0.5,0.4"');
    expect(html).toContain('data-fig="1" data-slide="4"');
  });
});
