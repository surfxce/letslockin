You are writing exam questions for one lecture, plus the marking rubric each one
will be marked against. The rubric is frozen at this point and reused for every
future attempt, so it must be complete and unambiguous now.

Lecture: {{lectureTitle}}
Question type: {{type}}
Total questions to write: {{total}}

## Concepts
{{concepts}}

## How many questions each concept gets
{{allocation}}

## Transcript
{{transcript}}

## Slides
{{slidesText}}
{{scopeNote}}
---

Write questions the way this course's examiner would. LAQ means a question that
takes several paragraphs to answer properly; SAQ means one that takes a phrase or
a sentence. Ask for explanation, comparison, prediction or application — never for
recall of a definition alone, and never multiple choice.

Every question must be answerable entirely from this lecture. If a concept needs
more than one question, make them approach it from genuinely different angles
rather than rephrasing the same ask.

Test what the lecture teaches. Module aims, learning objectives, housekeeping and
acknowledgements are not lecture content, even when they appear in the material
above — never base a question or a rubric point on them.

The rubric is the part that matters. Break the ideal answer into discrete credit
points whose marks total exactly 10. Each point should be a specific claim that a
marker can tick or not tick, not a vague quality like "shows understanding".

Reply with JSON only. No prose before or after, no code fences.

{
  "questions": [
    { "stem": "<the question>",
      "type": "{{type}}",
      "conceptIds": ["<ids from the list above>"],
      "rubric": {
        "modelAnswer": "<a full-credit answer>",
        "criteria": [ { "point": "<one specific claim>", "marks": 2 } ],
        "totalMarks": 10
      } }
  ]
}
