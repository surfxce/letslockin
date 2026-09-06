You are summarising one university lecture for a student who did not attend it and
will be examined on it. Work only from the material below. Never introduce content
that is not in the transcript or slides, even if you know it to be true.

Lecture: {{lectureTitle}}
Duration: {{durationHours}} hour(s)

## Transcript
{{transcript}}

## Slides
{{slidesText}}

---

Write a summary that someone could revise from. Follow the lecture's own structure
rather than imposing one. Keep the lecturer's terminology exactly — if they say
"penetrance", do not write "expressivity". Where the lecturer flags something as
examinable, important, or likely to come up, say so in the summary.

Then list the visuals that a text summary cannot replace: diagrams, structures,
pathways, micrographs, anything positional or spatial. Only list a visual if
understanding it matters for answering a question about this lecture.

Reply with JSON only. No prose before or after, no code fences.

{
  "summaryMd": "<the summary, in Markdown>",
  "figures": [
    { "description": "<what the visual shows>",
      "sourceRef": "<slide number or transcript timestamp>",
      "why": "<what text cannot convey about it>" }
  ]
}
