# Polygraph: progress

**Last updated:** Nov 8, 2026, end of Session 1
**Next up:** Session 2, Trap library v1

| # | Session | Status |
|---|---|---|
| 1 | Setup + first call | Done, Nov 8, 2026 |
| 2 | Trap library v1 | Next |
| 3 | Interrogator | Not started |
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

**Run the automated tests** (in the `run` tab):
```powershell
python -m pytest
```

**If something goes wrong**
- *"Can't reach Ollama"*: open Ollama from the Start menu, wait a few seconds, then try again.
- *"The model ... isn't downloaded yet"*: run the `ollama pull ...` command it shows you.
- *"polygraph is not recognized"*: run the two setup lines above first.

---

## What's next: Session 2, Trap library v1
- The trap format from PLAN.md section 4: one JSON file per trap type in `traps/`, checked by a schema so a broken trap can't load.
- 10 traps for each of the 8 trap types, 80 in total. Every ghost fact gets web-checked, and every truth gets a source.
- A command, `polygraph traps check`, that validates every trap and counts them by type.
- **Your part:** spot-check 10 random traps.

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

## Notes for later sessions
- **API key:** by Session 4 you'll want at least one cloud API key for the AI judge. Make it, set a hard spending limit in that company's account, then paste the key into `.env` yourself (`notepad .env` in the `run` tab). Never paste it into the chat.
- **Ollama** runs in the background and starts when you log in. You can quit it from its icon near the clock or uninstall it from Settings → Apps.
- **Bigger local models:** the graphics card (RTX 4070 SUPER, 12 GB) can run larger local models than Llama 3.2 3B if we want one for the lineup in Session 9.
