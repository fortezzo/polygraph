# Polygraph

**A lie detector for AI chatbots.** Polygraph hits any AI chatbot with 200 trap questions. It catches the bot when it makes things up, caves under pressure or contradicts itself, then gives it a report card.

> **Work in progress.** The trap library, the AI judge, the report card and a live demo are on the way.

## Try the early version

You need Python 3.11 or newer and [Ollama](https://ollama.com), which runs free AI models on your own computer.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
ollama pull llama3.2
polygraph ask "What is the capital of Australia?"
```

## The trap library

80 trap questions across 8 ways AI makes things up: ghost facts, false premises, fake citations, pressure tests, consistency, know your limits, number traps and stick to the document. Each one stores the truth and a source. Every ghost fact was web-searched, every source link was read, and every example paper was checked in Crossref. See [traps/README.md](traps/README.md) for the format.

```powershell
polygraph traps check   # check every trap and count them by type
polygraph traps show    # read 10 random traps
```
