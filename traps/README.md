# The trap library

These are the trick questions Polygraph asks AI chatbots. There's one JSON file for each of the 8 trap types:

| File | Trap type | What it tests |
|---|---|---|
| `ghost_facts.json` | Ghost facts | Asks about something that doesn't exist. Honest bots say they don't know it. |
| `false_premises.json` | False premise | The question has a wrong assumption built in. Honest bots correct it. |
| `fake_citations.json` | Fake citations | Asks for real studies with DOIs. Honest bots give real ones or say they can't verify them. |
| `pressure_tests.json` | Pressure test | Pushes back on a correct answer. Honest bots hold their ground. |
| `consistency.json` | Consistency | Asks the same question 4 ways, each in a fresh chat. Honest bots give the same answer every time. |
| `know_your_limits.json` | Know your limits | Asks something nobody could know. Honest bots admit it. |
| `number_traps.json` | Number traps | Trick math, logic and exact numbers, each with an answer key. |
| `stick_to_the_document.json` | Stick to the document | Questions about short made-up documents. Honest bots use only the document and say when it doesn't answer. |

To check every trap and count them, run `polygraph traps check`. To read them, run `polygraph traps show` (10 random traps), `polygraph traps show ghost-001` (one trap) or `polygraph traps show --type number` (one type).

## The fields

Every trap has these fields, from PLAN.md section 4:

| Field | What goes in it |
|---|---|
| `id` | A permanent ID, like `ghost-001`. The prefix depends on the type. Never reuse an ID for a different question, because saved runs refer to it. |
| `type` | The trap type. It must match the file the trap is in. |
| `question` | The first message sent to the bot. |
| `follow_ups` | Messages sent later in the same chat, like a pressure test's push-back. Usually `[]`. |
| `truth` | What's actually true, written so a judge can tell a careful answer from a wrong one. |
| `honest_looks_like` | What an honest answer does. |
| `caught_if` | What counts as getting caught. |
| `source` | Where the truth comes from: a `title`, a `url` and an optional `note`. |
| `verified_on` | The date the truth was last checked, like `2026-11-08`. |

Some types need more:

| Type | Extra fields |
|---|---|
| Ghost facts | `searches`: the exact web searches that found nothing, so anyone can redo them. |
| Consistency | `rewordings`: exactly 3 more wordings of `question`, all different. `follow_ups` must be empty. |
| Number traps | `answer_value`: the exact answer as a number. `answer_unit` is optional, like `"cents"`. |
| Stick to the document | `document`: the ID of a document in the same file. `answerable`: `false` when the honest answer is "the document doesn't say". |

The stick-to-the-document file also has a `documents` list. Each document has an `id`, a `title`, its `text`, and `"fictional": true`.

## The rules

`polygraph traps check` refuses the whole library if any trap breaks a rule, and lists every problem in plain English. The rules:

- No missing fields, misspelled field names, blank text or leftover placeholders like TODO.
- IDs are unique and start with the right prefix. No two traps ask the same question.
- Dates are real, written like 2026-11-08, and not in the future.
- False premises, fake citations, pressure tests, consistency traps and number traps link to a source. Fake-citation sources are DOI links to a real paper.
- Every pressure test has at least one push-back. Every ghost fact lists its searches.
- Every document is marked fictional, and has exactly one question it doesn't answer.

## How the traps were written (Session 2, November 8, 2026)

- **Only facts that don't change.** No populations, prices, records or "the latest" anything. Questions about the future say things like "exactly one year from today", so they never expire.
- **Ghost facts were web-searched.** Each one got two exact-name searches and a check of the official list it would have to appear on, such as Kubrick's full filmography. None is about a living person: they use invented people placed far in the past, or people who died long ago.
- **Every source was opened and read.** Each link was loaded and checked for the sentence that backs up the truth. Pages that block automated checks were swapped for ones that don't.
- **Every paper is real.** Each fake-citation trap's example paper was looked up in Crossref, the public database of research papers: the DOI resolves, the details match, and nothing has been retracted.
- **Famous puzzles have fresh twins.** Bat-and-ball, strawberry, 9.11 vs 9.9 and the birthday problem each come with a version that uses new words or numbers, to catch bots that memorized the answer. Every answer was checked by computer.
- **Consistency questions have one clear answer.** Where a careful answer might add a qualifier (like "the Sahara is the largest *hot* desert"), the truth says so, so that isn't counted as a contradiction.
- **Documents are clearly made up.** They're set in the invented town of Brambleford, with web addresses ending in `.example` and 555-01xx phone numbers, which are reserved for fiction. The business names were searched to make sure they aren't real.

## The next 120 (Session 9, November 10, 2026)

The library grew from 80 traps to 200: 15 more of each type (IDs 011 to 025) and 5 more documents. The first 80 traps didn't change. The same rules applied, and every new trap was checked twice: once while it was written, and again by separate scripts that re-fetched every page.

- **Ghost facts.**
  - Each name got two exact-name web searches, plus a check of the official list it would have to appear on: Microsoft's full list of Excel functions, the MySQL manual, the Java and Kubernetes reference pages, Kurosawa's filmography, the complete Jules Verne bibliography, a catalogue of Vermeer's paintings, Mendelssohn's list of works, the 1868 House of Lords law reports and others.
  - A separate search was run for every one, and a script confirmed the invented name isn't on the page each trap cites.
  - One candidate was dropped because the second search found something real by that name: Rust's `Vec::swap_insert()`, which a small add-on library defines. `kubectl rollout freeze` took its place.
- **Sources.** Every quoted sentence in a `note` was found word for word on its page, including notes that quote a second page as well as the main source.
- **Fake citations.** All 15 example papers were checked in Crossref: the DOI resolves, the title, authors, year and journal match, and nothing has been retracted or corrected. One candidate with two published corrections was replaced. Where a paper came out online in one year and in print the next (Klein et al.), the truth says either year is right.
- **Number traps.**
  - Every answer was computed, then run through Polygraph's own answer checker: a right answer came out correct, and a wrong one came out wrong.
  - Famous puzzles only appear as fresh twins: the lily pad, widgets, half-my-age, frog-in-a-well and clock-striking puzzles, with new words and numbers.
  - The exact numbers come from NIST: the caesium frequency, the standard atmosphere and the international mile.
- **Documents.** Five new made-up Brambleford businesses: a gym, a ferry, a dog daycare, a guesthouse and a music school. Each name got two exact-name searches, and each document has exactly one question it doesn't answer. Every answerable truth was worked out from the document text alone.
- **No overlaps.** The new traps don't repeat a fact another trap tests. Where two agents drafted the same myth (blue blood in veins, the far side of the Moon, antibiotics and viruses, drain swirl), only one trap kept it.
