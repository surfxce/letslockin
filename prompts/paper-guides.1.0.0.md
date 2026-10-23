You are writing marking guides for questions from a real past exam paper, so a student's
practice answers can be marked fairly against what their lecture taught.

## Lecture
{{lectureTitle}}

## What the lecture covered
{{summary}}

## Concepts in this lecture
{{concepts}}

## The questions
Each has a key, the question as printed, and the marks the paper gives it (if stated).

{{questions}}

---

For every question, write:

- `modelAnswer`: the answer a top student would write in the time the marks allow, using
  what the lecture taught. Where the lecture doesn't cover part of the question, answer it
  from standard knowledge at the same level, but don't go beyond what is asked.
- `criteria`: the separate points a marker would look for, each with the marks it earns,
  **adding up to exactly 10** whatever the paper's own total. Two to eight points.

If a question is multiple choice, the model answer names the right option and says why
in one or two sentences, and the criteria are the option (most marks) and the reason.

Reply with JSON only. No prose before or after, no code fences.

{
  "guides": [
    { "key": "q1", "modelAnswer": "<answer>", "criteria": [{ "point": "<what earns it>", "marks": 4 }] }
  ]
}
