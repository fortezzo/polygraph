# Polygraph

[![Tests](https://github.com/fortezzo/polygraph/actions/workflows/tests.yml/badge.svg)](https://github.com/fortezzo/polygraph/actions/workflows/tests.yml)

**A lie detector for AI chatbots.** Polygraph hits any AI chatbot with 200 trap questions. It catches the bot when it makes things up, caves under pressure or contradicts itself, then gives it a report card.

**[Watch the demo](https://fortezzo.github.io/polygraph/):** recorded interrogations of 8 chatbots, replayed in your browser. No API key needed.

> **Work in progress.** The trap library, the interrogator, the AI judge, the report card and the dashboard work. This README gets its full write-up in a later session.

## What it found

One judge, Claude Haiku 5.5, graded 8 chatbots on the same 200 traps. Before it graded the lineup, it was checked against answers labeled by hand: on 50 answers it had never seen, it agreed with the hand label on 43 (86%).

| Bot | Truth Score | Grade |
|---|---|---|
| gpt-6-astra | 98.5 | A |
| gpt-6.1-terra | 97 | A |
| gpt-6-luna | 93.5 | A |
| gemma4:12b | 72.75 | C |
| phi4:14b | 66 | D |
| gemma3:12b | 49 | F |
| ministral-3:14b | 49 | F |
| llama3.2 | 35 | F |

The dashboard replays every interrogation, shows each caught answer as evidence, and charts how confident each bot was when it was wrong.

## Try it

You need Python 3.11 or newer and [Ollama](https://ollama.com), which runs free AI models on your own computer.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
ollama pull llama3.2
polygraph ask "What is the capital of Australia?"
```

## Interrogate a bot

```powershell
polygraph run                          # all 200 traps, against the free local llama3.2
polygraph run --estimate               # just show the plan and the estimated cost
polygraph run --model gpt-6-luna       # a cloud model (put its API key in .env first)
polygraph judge runs\<run file>.json   # grade a run and print its report card
polygraph models                       # known models and their prices
```

- **How it asks.** Pressure tests push back after the answer. Consistency traps ask each of their 4 wordings in a fresh conversation. Document traps include the document with the question. After every answer, the bot is asked how confident it is, from 0 to 100, in a side copy of the conversation so the question never adds pressure.
- **How it judges.** Free checks with no AI come first: an answer key for number traps, and a Crossref and doi.org lookup for every reference. A reference that clearly doesn't exist makes the answer a lie by itself. The rest goes to an AI judge from a different company than the bot, which votes 3 times, and the majority wins.
- **Every model behind one interface.** Ollama, OpenAI, Anthropic, Google, and any OpenAI-compatible service through `--base-url`.
- **Cheap to run.** Questions run in parallel, up to a limit. Busy services are retried with growing waits. Every reply is cached on your computer, so re-running the same thing costs nothing.
- **A cost guard.** Polygraph estimates the cost before a run, stops at $2 unless you approve more, and checks before every question so a run can't go over its limit. It refuses to run a model whose price it doesn't know.
- **One JSON run file per run, in `runs/`.** It holds the full conversations, the confidence after each answer (with the bot's exact words), the exact model version, and for every reply whether it came from the cache and when it was first collected.
- **Confidence is self-reported, so treat it with care.** Small models in particular misread the question. Llama 3.2 3B often says 0 right after a correct answer.

## The dashboard

```powershell
cd dashboard
npm ci
npm run dev
```

Then open http://127.0.0.1:5173. It has the interrogation room (a replay of every recorded run), the report card, the evidence wall, the overconfidence meter and the lineup. People's names in studies and citations are hidden on screen, unless Polygraph's own check found the paper in Crossref with those authors.

## The trap library

200 trap questions across 8 ways AI makes things up: ghost facts, false premises, fake citations, pressure tests, consistency, know your limits, number traps and stick to the document. Each one stores the truth and a source. See [traps/README.md](traps/README.md) for the format.

```powershell
polygraph traps check   # check every trap and count them by type
polygraph traps show    # read 10 random traps
```

## Tests

```powershell
python -m pytest          # 757 offline tests: no internet, no keys, no cost
python -m pytest -m live  # also ask real models: Ollama, and any cloud model whose key is in .env
cd dashboard; npm run check   # the dashboard's type check, tests and build
```

GitHub Actions runs the offline tests, a check for API keys and the dashboard's check on every push.
