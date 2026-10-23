You are turning a student's exam mistakes into flashcards, so each one gets drilled until it sticks.

## Lecture
{{lectureTitle}}

## What the student missed or got wrong
Each line is one point from the marking of a long-answer question: its key, whether the
student missed it or got it wrong, the topic, and the correct point. The question it came
from is in brackets.

{{mistakes}}

---

Write exactly one flashcard per line, using that line's key.

- The front is a short, specific question whose answer is the correct point. It must make
  sense on its own, weeks from now, without the original exam question. Never ask "what did
  you miss" or refer to the student's answer.
- For a point the student got wrong, word the front so the common wrong idea is tested
  (e.g. "Which immunoglobulin…", not "True or false…").
- The back is the correct point, stated plainly in one to three sentences. Use **bold** for
  the key term. No preamble.

Reply with JSON only. No prose before or after, no code fences.

{
  "cards": [
    { "key": "g1", "front": "<question>", "back": "<answer>" }
  ]
}
