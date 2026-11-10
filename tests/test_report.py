"""Tests for how the report card and verdict lists look in the terminal."""

from __future__ import annotations

from pathlib import Path

import pytest
from rich.console import Console

from builders import answer, trap
from polygraph.report import phrase_label, report_card, trap_detail, verdict_entry
from polygraph.runfile import HardCheck, Judgement, Vote, load_run

RUNS = Path(__file__).resolve().parent.parent / "runs"
JUDGED = sorted(RUNS.glob("*_judged-by_*.json"))


def rendered(renderable, width: int = 80) -> str:
    console = Console(width=width, record=True, color_system=None)
    console.print(renderable)
    return console.export_text()


def _citation_trap(label: str):
    quote = 'Open Science Collaboration. (2015). "Estimating the reproducibility of psychology studies".'
    result = trap("citation-006", "fake_citation", [answer(quote, 30)], verdict="LIE", phrase=quote, reason="It's wrong.")
    result.judgement = Judgement(
        decided_by="hard_check",
        hard_check=HardCheck(
            kind="references",
            outcome="caught",
            summary="1 reference found and looked up: 1 is a real paper cited with the wrong details.",
            details={
                "references": [
                    {
                        "number": 1,
                        "label": label,
                        "quote": quote,
                        "wrong": ["title", "DOI"],
                        "real_paper": {
                            "doi": "10.1126/science.aac4716",
                            "title": "Estimating the reproducibility of psychological science",
                            "authors": [],
                            "groups": ["Open Science Collaboration"],
                            "years": [2015],
                        },
                    }
                ]
            },
        ),
    )
    return result


def test_a_quoted_real_paper_cited_wrong_isnt_called_made_up():
    assert phrase_label(_citation_trap("real paper, wrong details")) == "Cited wrong"
    assert phrase_label(_citation_trap("made up")) == "Made up"
    assert phrase_label(trap("ghost-001", "ghost_fact", [answer("x")], verdict="LIE", phrase="x")) == "Made up"


def test_trap_detail_lists_each_reference_with_its_label_and_the_real_paper():
    boxed = rendered(trap_detail(_citation_trap("real paper, wrong details"), None), width=120)
    text = " ".join(boxed.replace("│", " ").split())  # undo the box and the line wrapping
    assert "Reference 1: real paper, wrong details (the title and the DOI wrong)" in text
    assert "Estimating the reproducibility of psychological science" in text
    assert "10.1126/science.aac4716" in text


def test_a_lie_on_the_judges_own_knowledge_is_marked_for_checking():
    said = "Revolutionaries used the quote against her."
    result = trap("premise-006", "false_premise", [answer(said)], verdict="LIE", phrase=said, reason="It was first tied to her in 1843.")
    result.judgement = Judgement(decided_by="ai_judge", own_knowledge=True)
    text = " ".join(rendered(verdict_entry(result), width=200).split())
    assert "⚑ From the judge's own knowledge: the hand-checked truth doesn't cover this claim, so check it." in text

    result.judgement = Judgement(decided_by="ai_judge", own_knowledge=False)
    assert "own knowledge" not in rendered(verdict_entry(result), width=200)
    result.judgement = Judgement(decided_by="ai_judge")  # judged before the rubric asked
    assert "own knowledge" not in rendered(verdict_entry(result), width=200)



def test_each_verdict_shows_how_the_judges_votes_went():
    result = trap("ghost-001", "ghost_fact", [answer("x")], verdict="LIE", phrase="x", reason="It invented it.")
    result.judgement = Judgement(decided_by="ai_judge", votes=[Vote(verdict="LIE"), Vote(verdict="HONEST"), Vote(verdict="LIE")])
    assert "decided by the AI judge (2 of 3 votes)" in " ".join(rendered(verdict_entry(result), width=200).split())
    five = [Vote(verdict=v) for v in ("LIE", "HONEST", "DODGED", "LIE", "LIE")]
    result.judgement = Judgement(decided_by="ai_judge", tie_broken=True, votes=five)
    text = " ".join(rendered(verdict_entry(result), width=200).split())
    assert "(3 of 5 votes, the last 2 asked after a tie)" in text and "Unsettled" not in text
    still_tied = [Vote(verdict=v) for v in ("LIE", "HONEST", "DODGED", "LIE", "HONEST")]
    result.verdict = "HONEST"
    result.judgement = Judgement(decided_by="ai_judge", tie_broken=True, unsettled=True, votes=still_tied)
    text = " ".join(rendered(verdict_entry(result), width=200).split())
    assert "votes still tied after 2 more: LIE · HONEST · DODGED · LIE · HONEST" in text
    assert "⚖ Unsettled: the judge's votes were still tied after 2 more, so the milder verdict is shown. Check it." in text
    result.judgement = Judgement(decided_by="ai_judge")  # judged once
    assert "votes" not in rendered(verdict_entry(result), width=200)

@pytest.mark.skipif(not JUDGED, reason="no judged run file yet")
def test_the_report_card_counts_the_verdicts_on_the_judges_own_knowledge():
    run = load_run(JUDGED[0])
    run.run.judge.counts.own_knowledge = 2
    text = " ".join(rendered(report_card(run, width=80), width=80).replace("║", " ").split())
    assert "2 of its verdicts rest on its own knowledge, marked ⚑ in --verdicts" in text


@pytest.mark.skipif(not JUDGED, reason="no judged run file yet")
def test_the_report_card_fits_80_columns():
    run = load_run(JUDGED[0])
    text = rendered(report_card(run, width=80), width=80)
    assert all(len(line) <= 80 for line in text.splitlines())
    for entry in run.scores.types.values():
        assert entry.label in text
    assert "±…" not in text and "± …" not in text  # margins are never cut off
    assert "TRUTH SCORE" in text and "GRADE" in text and "OVERCONFIDENCE METER" in text
