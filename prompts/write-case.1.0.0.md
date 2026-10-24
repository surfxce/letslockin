Write one clinical case for a medical student to work through out loud, OSCE-style, with
an examiner: a patient is presented, then the student is asked about them in stages, and
after each stage the examiner tells them what it found before asking the next. It tests
these lectures — use their facts, terms and numbers, and nothing they don't support.

{{lectures}}

## Concepts (cite these ids)
{{concepts}}

## Cases already written from these lectures — make this a different patient
{{avoid}}

---

Write:

- `title`: what the case is about from the patient's side, without the diagnosis —
  "Cola-coloured urine after a sore throat", not "IgA nephropathy".
- `presentation`: what the student is told first, as an examiner would say it — age, sex,
  what brought them in and since when, in two or three plain sentences. No diagnosis, no
  results yet.
- `stages`: 3 to 5, in this order, using the kinds that fit the lectures:
  - `history` — "What would you ask her?"; reveal what the history found.
  - `examination` — "What would you look for on examination?"; reveal the findings.
  - `investigations` — "Which investigations would you request, and what do you expect?";
    reveal the results, with numbers and units where the lectures give them.
  - `diagnosis` — "What's the most likely diagnosis, and why? What else might it be?";
    reveal the diagnosis and the clinching evidence.
  - `management` — "How would you manage this patient?"; reveal the plan in brief.
  - `mechanism` — for a lecture on mechanisms or drugs rather than clinical features: "Explain
    why this happened" or "How does this drug work here?"; reveal the explanation.
  Each stage has:
  - `ask`: one spoken question, under 35 words.
  - `reveal`: what the examiner says next — the findings this stage leads to, in one to
    three spoken sentences. It must make sense whatever the student answered, and must
    not answer a later stage's question.
  - `rubric`: `modelAnswer` (what a strong student says), `criteria` (2–6 points, each a
    thing a good answer covers, with `marks` adding up to 10) and `totalMarks`: 10. Mark
    what this stage asks only.
  - `conceptIds`: the concept ids it tests, from the list above.

Make the case realistic and self-consistent: the history, findings, results and diagnosis
must all fit one patient. Plain spoken English throughout — it's read aloud.

Reply with JSON only. No prose before or after, no code fences.

{ "title": "...", "presentation": "...", "stages": [ { "kind": "history", "ask": "...", "reveal": "...", "conceptIds": ["..."], "rubric": { "modelAnswer": "...", "criteria": [ { "point": "...", "marks": 4 } ], "totalMarks": 10 } } ] }
