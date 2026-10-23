You are writing exam questions that join up related lectures from one course, plus the
marking rubric each one will be marked against. The rubric is frozen now and reused for
every future attempt, so it must be complete and unambiguous.

Total questions to write: {{count}}

## The lectures
{{lectures}}

## Concepts, by lecture
{{concepts}}

## Words the lectures share
{{shared}}

---

Each question must need **every** lecture above to answer well: a student who had only
revised one of them should lose real marks. Good ways in:

- a mechanism from one lecture explains a finding, sign or result from another;
- a scenario that starts in one lecture's territory and develops into the other's;
- compare or contrast two processes, structures or treatments the lectures each teach;
- predict what happens when something one lecture describes goes wrong, using the other.

Write questions the way this course's examiner would: long-answer questions that take
several paragraphs, asking for explanation, comparison, prediction or application —
never recall of a definition alone, and never multiple choice. Stay within what the
lectures teach. If you write more than one question, approach the link from genuinely
different angles.

`conceptIds` must hold at least one concept id from each lecture, taken from the lists
above, up to four in all.

The rubric is the part that matters. Break the ideal answer into discrete credit points
whose marks total exactly 10, with points drawn from each lecture. Each point should be
a specific claim a marker can tick or not tick, not a vague quality like "shows
understanding".

Reply with JSON only. No prose before or after, no code fences.

{
  "questions": [
    { "stem": "<the question>",
      "type": "LAQ",
      "conceptIds": ["<ids from the lists above, from every lecture>"],
      "rubric": {
        "modelAnswer": "<a full-credit answer>",
        "criteria": [ { "point": "<one specific claim>", "marks": 2 } ],
        "totalMarks": 10
      } }
  ]
}
