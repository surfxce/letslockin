A student keeps getting the same thing wrong in their long-answer questions. Write them a
short, focused lesson on it — the kind a good tutor gives in three minutes.

Concept: {{conceptName}} — {{conceptDefinition}}
Lecture: {{lectureTitle}}

## What the marker said, across their answers
{{gaps}}

## What the lecture covered
{{summary}}

---

Write:

- `explanation`: Markdown, 120–300 words. Start from what they keep getting wrong and set
  it right — the mechanism, the reason, the distinction they're missing — not a general
  overview of the topic. Use the lecture's terms and facts. Short paragraphs, or a few
  dot points where a sequence or a contrast is clearer that way. One memorable anchor
  (an analogy, a mnemonic, a "think of it as…") if it genuinely helps.
- `checks`: three short questions that test exactly the point they kept missing, each
  with a one- or two-sentence answer. Ask for reasoning, not just a name.

Reply with JSON only. No prose before or after, no code fences.

{ "explanation": "<markdown>", "checks": [ { "question": "<question>", "answer": "<answer>" } ] }
