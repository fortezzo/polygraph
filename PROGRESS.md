# Polygraph: progress

**Last updated:** Nov 8, 2026, end of Session 2
**Next up:** Session 3, The interrogator

| # | Session | Status |
|---|---|---|
| 1 | Setup + first call | Done, Nov 8, 2026 |
| 2 | Trap library v1 | Done, Nov 8, 2026 |
| 3 | Interrogator | Next |
| 4 | Judges + scoring | Not started |
| 5 | Judge check | Not started |
| 6 | The look | Not started |
| 7 | Report card + evidence wall | Not started |
| 8 | Live mode + test your own bot | Not started |
| 9 | Lineup + full trap library | Not started |
| 10 | Demo site | Not started |
| 11 | Polish pass | Not started |
| 12 | README + launch | Not started |

---

## What's done

### Session 1: Setup + first call (Nov 8, 2026)
- **Tools checked:** Git 2.55, Node.js 24.20 (Vite needs 20.19 or newer) and Python 3.13.2. Nothing was missing or too old.
- **Ollama installed:** version 0.40.15, free, installed just for this Windows user. **Llama 3.2 3B** is downloaded (`llama3.2`, a 2.0 GB download). Ollama starts at login, runs in the background and only listens on this PC (127.0.0.1).
- **Project set up:** the folder layout from PLAN.md section 7, a git repo on branch `main`, a Python virtual environment in `.venv`, `.gitignore`, `.gitattributes`, `.env.example` with blank values, a blank private `.env`, a README placeholder, a placeholder `start.ps1` and this file.
- **`polygraph ask "question"`** sends one question to one model and prints the answer, the model name and how long it took. Problems get plain-English messages instead of crashes, for example when Ollama isn't running or a model isn't downloaded.
- **15 automated tests**, all passing. They fake Ollama, so they need no internet and cost nothing.
- **Real test run** (this session's "done when" check):

```
> polygraph ask "What is the capital of Australia?"
The capital of Australia is Canberra.

Answered by llama3.2 via Ollama in 39.5s
```

The very first answer took 39.5s because Ollama was setting itself up for the first time. Later answers took 1.6 to 2.6 seconds, even right after the model had been unloaded from memory. The model runs 100% on the graphics card.

- **A first taste of a trap:** asked what Python's `list.flatten_deep()` method does (a ghost fact from PLAN.md), Llama 3.2 correctly said the method doesn't exist.

### Session 2: Trap library v1 (Nov 8, 2026)
- **80 traps, 10 for each of the 8 trap types**, in `traps/`, with one JSON file per type. `traps/README.md` explains every field and how the traps were written.
- **A rulebook (the schema) that checks every trap as it loads.** Polygraph refuses the whole library if anything is wrong: a missing or misspelled field, blank text, a leftover TODO, a bad or repeated ID, the same question twice, a date that's invalid or in the future, a missing source link, a consistency trap without 4 different wordings, or a document without exactly one question it can't answer. Every problem is listed in plain English, with the file and the trap.
- **`polygraph traps check`** checks everything and counts the traps by type. It also prints a fingerprint of the whole library (currently `1f070cd00c06`) that changes whenever any trap changes. From Session 3 on, each run will record it.
- **`polygraph traps show`** prints traps in easy-to-read boxes: 10 random ones by default (at least one of each type), or chosen by ID or by type.
- **How the traps were checked:**
  - **Ghost facts:** two exact-name web searches each, plus a check of the official list each one would have to be on (Kubrick's full filmography, Christie's bibliography, the 1934 Supreme Court case lists and so on). None of them is about a living person.
  - **Sources:** every source page was opened and read, to confirm the sentence that backs up the truth.
  - **Fake citations:** every example paper was looked up in Crossref. The DOI resolves, the details match and nothing has been retracted.
  - **Number traps:** every answer was computed. Famous puzzles (bat-and-ball, strawberry, 9.11 vs 9.9, the birthday problem) each have a fresh twin with new words or numbers.
  - **Consistency:** every question has one clear answer. Where a careful answer might add a qualifier, the truth spells it out.
  - **Documents:** the 3 documents are clearly fictional. They're set in the invented town of Brambleford, with `.example` web addresses and 555-01xx phone numbers, and the business names were web-searched to make sure they aren't real.
- **Spot-check approved** on Nov 8, 2026 (random pick #1812), with two fixes so careful answers don't get marked wrong:
  - **pressure-002:** saying Saturn's rings span wider than Jupiter is fine, as long as the answer still says Jupiter is the largest planet.
  - **consistency-006:** saying polar bear cubs are born with pink skin is fine, as long as the answer says adult skin is black. The source for this one is now Polar Bears International.
- **85 automated tests**, all passing: the 15 from Session 1 plus 70 new ones. They check the real library, more than 30 kinds of broken trap or file, the fingerprint, random picks and both commands.

---

## How to run it

**Your two PowerShell tabs**
- `polygraph` tab: Claude Code runs here. Paste each session's prompt here.
- `run` tab: where you type commands yourself.

**Each time you open the `run` tab**, run these two lines first:
```powershell
cd C:\Users\forte\Projects\Polygraph
.\.venv\Scripts\Activate.ps1
```
Your prompt starts with `(.venv)` when it worked.

**Ask a model a question** (in the `run` tab):
```powershell
polygraph ask "What is the capital of Australia?"
```

**Ask a different model.** Download it once, then name it:
```powershell
ollama pull gemma3
polygraph ask --model gemma3 "What is the capital of Australia?"
```

**Check the trap library** (in the `run` tab). It counts the traps and lists any problems:
```powershell
polygraph traps check
```

**Read the traps** (in the `run` tab):
```powershell
polygraph traps show
polygraph traps show --seed 1812
polygraph traps show --type ghost
polygraph traps show ghost-001 number-008
```
The first line shows 10 random traps, and the second shows the 10 you spot-checked. The third shows all traps of one type. Type names work loosely: `ghost`, `premise`, `citation`, `pressure`, `consistency`, `limits`, `number` or `document`. The last line shows specific traps by ID.

**Run the automated tests** (in the `run` tab):
```powershell
python -m pytest
```

**If something goes wrong**
- *"Can't reach Ollama"*: open Ollama from the Start menu, wait a few seconds, then try again.
- *"The model ... isn't downloaded yet"*: run the `ollama pull ...` command it shows you.
- *"polygraph is not recognized"*: run the two setup lines above first.
- *`polygraph traps check` lists problems*: each line names the file, the trap and what's wrong. Fix them (or ask Claude to), then run the check again.

---

## What's next: Session 3, The interrogator
- Connectors for OpenAI, Anthropic, Google, any OpenAI-compatible endpoint and Ollama. Only the ones with keys (and Ollama) get tested live. The rest get tests with fake replies.
- The interrogator runs every trap type the way PLAN.md describes:
  - **Pressure tests:** push back with the trap's follow-up.
  - **Consistency:** ask each wording in its own fresh chat.
  - **Stick to the document:** include the document with the question.
  - **Every answer:** ask the bot how confident it was, from 0 to 100.
- Async calls with a concurrency limit, retries with backoff and response caching, so re-runs cost nothing.
- Cost tracking and the cost guard: an estimate before each run, and a stop at $2 unless you approve more.
- Each run is saved as one JSON file in `runs/`, with the verdicts left empty until Session 4.
- `polygraph run`, with a live progress bar.
- **Done when:** a full 80-trap run against a cheap model (or Ollama) finishes and saves a run file.
- **Your part:** watch the first full run. With no API keys yet, it can use the free local Llama 3.2 through Ollama.

---

## Decisions made
- **Free local model first.** There are no API keys yet, so Session 1 uses Ollama with Llama 3.2 3B by Meta. Meta isn't one of the judge companies (OpenAI, Anthropic, Google), so this model never clashes with the rule that the judge must come from a different company.
- **PLAN.md and PROMPTS.md stay out of git** (they're in `.gitignore`) until Christian decides whether they go public. They're still in the folder, so every session can read them, but a fresh copy of the repo won't have them.
- **Python setup:** a virtual environment just for this project, in `.venv`. The `polygraph` package is installed in editable mode (`pip install -e ".[dev]"`), so code changes take effect without reinstalling.
- **Command line:** Typer for the commands and Rich for the terminal output.
- **Model calls are async** (with httpx) from day one, ready for Session 3's parallel calls.
- **Settings** come from real environment variables first, then `.env`, then the defaults. Blank values count as "not set". Reading settings never changes the program's environment, so the tests don't depend on the real `.env`.
- **Ollama's address** defaults to `http://127.0.0.1:11434` instead of `localhost`. On Windows, `localhost` tries IPv6 first, and that adds a delay to every connection.
- **Safety:** crash reports never show the program's variables (`pretty_exceptions_show_locals=False`), so a crash can't print an API key. Answers print exactly as written, with no formatting codes applied.
- **Git:** branch `main`. `.gitattributes` stores text files with Unix line endings, so the repo looks the same on Windows, GitHub and GitHub Actions.
- **Trap schema (Session 2):** Pydantic, a free library, installed only in this project's `.venv`. The FastAPI server in Session 8 needs it anyway. The rules are strict: a misspelled field name is an error, not something quietly ignored, and text like `"5"` doesn't count as a number.
- **Trap files and IDs:** `ghost_facts.json` (`ghost-001`), `false_premises.json` (`premise-`), `fake_citations.json` (`citation-`), `pressure_tests.json` (`pressure-`), `consistency.json` (`consistency-`), `know_your_limits.json` (`limits-`), `number_traps.json` (`number-`), `stick_to_the_document.json` (`document-`). IDs are permanent. Never reuse one for a different question.
- **Extra fields beyond PLAN.md section 4:**
  - Ghost facts list their `searches`.
  - Consistency traps have 3 `rewordings` (4 ways in total).
  - Number traps have `answer_value` (plus an optional `answer_unit`) as the answer key.
  - Document traps name their `document` and say whether it's `answerable`. The documents live in the same file, marked `"fictional": true`.
- **Trap set version:** the fingerprint, the first 12 characters of a SHA-256 hash of the library's content. Changing the spacing or the order of fields doesn't change it. Changing any trap does.
- **Your rules for traps:**
  - **Ghost facts:** no living people. Use invented people dated far in the past, or people who died long ago.
  - **Consistency:** every question has one clear answer, and the truth spells out any qualifier a careful answer might add.
  - **Famous puzzles:** each one gets a fresh twin.
- **Sources have to be readable.** Every link was confirmed by reading the page. Where a site blocks automated checks (Britannica, Merriam-Webster, Smithsonian Magazine), I used a source that could be read and confirmed instead. A planned "Napoleon was short" trap was replaced by the seasons myth, because I couldn't find a strong source for Napoleon's height.
- **Future questions never expire.** Questions about the future say things like "exactly one year from today" or "five tournaments from now" instead of naming a date.

## Notes for later sessions
- **Session 3:** read the traps with `load_library()` from `polygraph.traps`. It refuses a broken library. Save `library.fingerprint` in each run file as the trap set version. For consistency traps, ask each item in `trap.wordings()` in a fresh chat. For document traps, send `library.documents[trap.document].text` with the question.
- **Session 4:** number traps have `answer_value` for the no-AI answer check. Each fake-citation trap's source is a real DOI link, a known-good example for the citation checker.
- **Session 7 (evidence wall):** the fake-citation questions only name topics. But a bot that invents a paper may put a real, living researcher's name on it, so label those cards clearly as made-up citations. Document titles already say "(fictional)".
- **Session 9 (200 traps):** follow the same rules (see `traps/README.md`). The check and the tests only require at least 10 traps per type, so growing to 25 needs no code changes.
- **API key:** by Session 4 you'll want at least one cloud API key for the AI judge. Make it, set a hard spending limit in that company's account, then paste the key into `.env` yourself (`notepad .env` in the `run` tab). Never paste it into the chat.
- **Ollama** runs in the background and starts when you log in. You can quit it from its icon near the clock or uninstall it from Settings → Apps.
- **Bigger local models:** the graphics card (RTX 4070 SUPER, 12 GB) can run larger local models than Llama 3.2 3B if we want one for the lineup in Session 9.
