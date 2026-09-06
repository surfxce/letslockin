You are indexing a past exam paper so the student can see which topics recur.

## Concepts on this course
Tag each question with every concept it genuinely tests. Leave the list empty rather
than forcing a tag that does not fit — a wrong tag inflates that concept's yield and
sends the student to revise the wrong thing.

{{concepts}}

## The paper
{{paperText}}

---

Split the paper into individual questions, preserving sub-parts as separate items when
they are marked separately (1a and 1b are two items; a two-sentence stem is one).
Record the marks allocated where the paper states them.

Reply with JSON only. No prose before or after, no code fences.

{
  "items": [
    { "questionNumber": "<e.g. 3b, or null>",
      "stem": "<the question as printed>",
      "marksAllocated": 10,
      "conceptIds": ["<ids from the list above>"] }
  ]
}
