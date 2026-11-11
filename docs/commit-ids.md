# Commit IDs before and after the history rewrite

**Why the history was rewritten:** to keep Christian's email private. On Nov 11, 2026, before anything was pushed to GitHub, the author and committer email on every commit was changed from his personal address to his GitHub noreply address. Git makes a commit's ID from everything in it, the email included, so every commit got a new ID.

**Nothing else changed.** Every commit has the same files, the same author name, the same dates and the same message. The files column below is the commit's tree ID: Git makes it from the files alone, and it's the same before and after. A script checked all of that for every commit before the old history was deleted. To check one yourself: `git rev-parse <new ID>^{tree}` prints the tree ID in the table.

**Where the old IDs still appear:**
- In the commit messages, which were kept word for word (Session 5's message quotes lock commit #3 as `08a6888`).
- In the older versions of the files, which were kept exactly as they were committed.

The current PROGRESS.md, docs/methodology.md and docs/judge-check/ quote the new IDs. The two locked plan files (`second-judge-plan.json`, `third-judge-plan.json`) say so in their `ids_updated` note.

| Old ID | New ID | Files (tree) | Commit | Locked |
|---|---|---|---|---|
| `650f552` | `39fc81a` | `eadf1ba77907` | Session 1: project setup and first model call |  |
| `64012ba` | `941c6d2` | `35dc8b58b569` | Session 2: trap library v1 (80 traps, schema, traps check/show) |  |
| `676747f` | `43c4f99` | `b8f56d6d0406` | Session 3: the interrogator (connectors, polygraph run, cost guard, run files) |  |
| `8d4c74a` | `002e132` | `58c08a4f620d` | Session 4: judges and scoring (hard checks, AI judge, report card) |  |
| `cb57c17` | `3f8edc0` | `d5d36809fd60` | Tell a real paper cited wrong apart from a made-up one |  |
| `c3e85a7` | `a369ab9` | `4361e976f75e` | Session 5, lock 1: pick the 100 answers and split them before labeling | lock commit #1 |
| `61f4f5d` | `b5c3169` | `fdbd0707a5ed` | Session 5, lock 2: Christian's 100 labels, locked before any comparison | lock commit #2 |
| `08a6888` | `700ef8b` | `7dd699fb3c1e` | Session 5, lock 3: the final rubric and judging setup, before the test half | lock commit #3 |
| `cbe9145` | `c5aa8e6` | `3630ff5cc555` | Session 5: judge check, 88% agreement on the untouched test half |  |
| `380f90e` | `5cd3879` | `b7db9d1ab7bf` | Session 6: the interrogation screen, in the chart-paper look |  |
| `2ead818` | `deb45bf` | `1ca123f5a990` | Session 7: the report card, the evidence wall and the overconfidence meter |  |
| `c55e2b6` | `d20cea8` | `6131bcca1d39` | Session 8: live mode and test your own bot |  |
| `6ccbe06` | `3b9b0ab` | `d3c900209be7` | Session 9, lock: a local judge's setup, before its test-half check | Qwen's setup |
| `a84a210` | `f6e577a` | `8094cca1554e` | Session 9, lock: Claude Haiku 5.5's judge setup, before its test-half check | Claude Haiku 5.5's setup |
| `ac9d823` | `66809bb` | `041598db5f70` | Session 9: the lineup, 200 traps, and Claude Haiku 5.5 as its judge |  |
| `bbf92ed` | `8d66d9c` | `71b7719fd798` | Session 10: replay whole recordings, the demo build and GitHub Actions |  |
| `61dffd7` | `073e947` | `a4b59b17af80` | Session 10: hide citation names in every answer, unless Crossref confirms them |  |
