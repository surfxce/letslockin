You are breaking one lecture into the individual ideas a student could be examined on.

Lecture: {{lectureTitle}}
Duration: {{durationHours}} hour(s)

## Concepts already on this course
Reuse these wherever this lecture covers the same idea, even if it uses different
words for it. Fragmenting one idea across several near-duplicate entries corrupts
every score built on top of them, so reuse is strongly preferred over minting.

{{existingConcepts}}

## Transcript
{{transcript}}

## Slides
{{slidesText}}

---

Extract between {{lowerBound}} and {{upperBound}} concepts.

A concept is one examinable idea — small enough to be the subject of a single
short-answer question, large enough to be worth asking about. "The lac operon is
induced by allolactose" is a concept. "Chapter 4" is not. Neither is "genetics".

For each concept, either reuse an existing id (set `existingId` to it and keep the
existing name) or set `existingId` to null to mint a new one. Prefer reuse.

Reply with JSON only. No prose before or after, no code fences.

{
  "concepts": [
    { "existingId": null,
      "name": "<short noun phrase>",
      "definition": "<one sentence, in the lecturer's own terminology>",
      "sourceRef": "<slide number or transcript timestamp, or null>" }
  ]
}
