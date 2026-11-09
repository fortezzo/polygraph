# Polygraph

**A lie detector for AI chatbots.** Polygraph hits any AI chatbot with 200 trap questions. It catches the bot when it makes things up, caves under pressure or contradicts itself, then gives it a report card.

> **Work in progress.** The trap library and the interrogator work. The AI judge, the report card and a live demo are on the way.

## Try the early version

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
polygraph run                          # all 80 traps, against the free local llama3.2
polygraph run --estimate               # just show the plan and the estimated cost
polygraph run --model gpt-6-luna       # a cloud model (put its API key in .env first)
polygraph models                       # known models and their prices
```

- **How it asks.** Pressure tests push back after the answer. Consistency traps ask each of their 4 wordings in a fresh conversation. Document traps include the document with the question. After every answer, the bot is asked how confident it is, from 0 to 100, in a side copy of the conversation so the question never adds pressure.
- **Every model behind one interface.** Ollama, OpenAI, Anthropic, Google, and any OpenAI-compatible service through `--base-url`.
- **Cheap to run.** Questions run in parallel, up to a limit. Busy services are retried with growing waits. Every reply is cached on your computer, so re-running the same thing costs nothing.
- **A cost guard.** Polygraph estimates the cost before a run, stops at $2 unless you approve more, and checks before every question so a run can't go over its limit. It refuses to run a model whose price it doesn't know.
- **One JSON run file per run, in `runs/`.** It holds the full conversations, the confidence after each answer (with the bot's exact words), the exact model version, and for every reply whether it came from the cache and when it was first collected.
- **Confidence is self-reported, so treat it with care.** Small models in particular misread the question. Llama 3.2 3B often says 0 right after a correct answer.

A full 80-trap run against Llama 3.2 3B on an RTX 4070 SUPER takes about 2 minutes and collects 120 answers plus 120 confidence replies.

## The trap library

80 trap questions across 8 ways AI makes things up: ghost facts, false premises, fake citations, pressure tests, consistency, know your limits, number traps and stick to the document. Each one stores the truth and a source. Every ghost fact was web-searched, every source link was read, and every example paper was checked in Crossref. See [traps/README.md](traps/README.md) for the format.

```powershell
polygraph traps check   # check every trap and count them by type
polygraph traps show    # read 10 random traps
```

## Tests

```powershell
python -m pytest          # 315 offline tests: no internet, no keys, no cost
python -m pytest -m live  # also ask real models: Ollama, and any cloud model whose key is in .env
```
