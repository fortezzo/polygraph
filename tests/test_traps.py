"""Tests for the trap library and the `polygraph traps` commands.

Most tests build a tiny, valid trap library in a temporary folder, break one
thing on purpose and check that the problem gets caught with a clear message.
None of them use the internet.
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path

import pytest
from typer.testing import CliRunner

from polygraph import cli
from polygraph.traps import (
    DEFAULT_FOLDER,
    TYPE_INFO,
    Consistency,
    StickToDocument,
    TrapLibraryError,
    TrapType,
    check_library,
    find_type,
    load_library,
    pick_random,
)
from polygraph.traps.display import format_number

# --- A tiny library that passes every rule -----------------------------------


def make_trap(kind: TrapType, number: int = 1, **changes) -> dict:
    trap = {
        "id": f"{TYPE_INFO[kind].id_prefix}-{number:03d}",
        "type": kind.value,
        "question": f"Test question number {number} for {kind.value}?",
        "follow_ups": [],
        "truth": "The truth.",
        "honest_looks_like": "Says the truth.",
        "caught_if": "Says something else.",
        "source": {"title": "A source", "url": "https://example.com/source"},
        "verified_on": "2026-01-15",
    }
    extras = {
        TrapType.GHOST_FACT: {"searches": ['"a made-up thing"']},
        TrapType.FAKE_CITATION: {"source": {"title": "A paper", "url": "https://doi.org/10.1000/test"}},
        TrapType.PRESSURE_TEST: {"follow_ups": ["Are you sure?"]},
        TrapType.CONSISTENCY: {
            "rewordings": [f"Second wording {number}?", f"Third wording {number}?", f"Fourth wording {number}?"]
        },
        TrapType.NUMBER_TRAP: {"answer_value": 5, "answer_unit": "cents"},
        TrapType.STICK_TO_DOCUMENT: {"document": "test-policy", "answerable": True},
    }
    trap.update(extras.get(kind, {}))
    trap.update(changes)
    return trap


def good_files(traps_per_type: int = 1) -> dict[str, dict]:
    files = {}
    for kind, info in TYPE_INFO.items():
        traps = [make_trap(kind, n) for n in range(1, traps_per_type + 1)]
        content: dict = {"type": kind.value, "traps": traps}
        if kind is TrapType.STICK_TO_DOCUMENT:
            content["documents"] = [
                {"id": "test-policy", "title": "A made-up policy", "fictional": True, "text": "Refunds within 2 hours."}
            ]
            traps.append(make_trap(kind, traps_per_type + 1, answerable=False))
        files[info.file_name] = content
    return files


def write_library(folder: Path, files: dict[str, object]) -> Path:
    for name, content in files.items():
        text = content if isinstance(content, str) else json.dumps(content, indent=2)
        (folder / name).write_text(text, encoding="utf-8")
    return folder


@pytest.fixture
def good_folder(tmp_path: Path) -> Path:
    return write_library(tmp_path, good_files())


def problems_for(tmp_path: Path, files: dict[str, object]) -> list[str]:
    return [str(problem) for problem in check_library(write_library(tmp_path, files)).problems]


# --- The real library ----------------------------------------------------------


def test_the_real_trap_library_passes():
    library = check_library(DEFAULT_FOLDER)

    assert library.problems == []
    assert all(count >= 10 for count in library.counts().values()), library.counts()
    assert len(library.traps) >= 80
    assert re.fullmatch(r"[0-9a-f]{12}", library.fingerprint)


def test_the_real_library_follows_the_session_2_rules():
    library = load_library(DEFAULT_FOLDER)

    # Consistency traps ask the same question 4 different ways.
    for trap in library.of_type(TrapType.CONSISTENCY):
        assert isinstance(trap, Consistency)
        assert len(trap.wordings()) == 4

    # 2 or 3 short made-up documents, each with exactly one question it doesn't answer.
    assert 2 <= len(library.documents) <= 3
    for doc_id, document in library.documents.items():
        assert document.fictional is True
        questions = [t for t in library.of_type(TrapType.STICK_TO_DOCUMENT) if t.document == doc_id]
        assert sum(not t.answerable for t in questions) == 1
        assert len(document.text.split()) < 250, f"{doc_id} should be short"

    # Every truth for these types has a web link.
    for kind in (TrapType.FALSE_PREMISE, TrapType.PRESSURE_TEST, TrapType.NUMBER_TRAP):
        assert all(trap.source.url for trap in library.of_type(kind))


# --- A small valid library ------------------------------------------------------


def test_a_small_valid_library_passes(good_folder):
    library = load_library(good_folder)

    assert library.ok
    assert len(library.traps) == 9  # one of each type, plus a second document question
    assert set(library.documents) == {"test-policy"}
    document_traps = library.of_type(TrapType.STICK_TO_DOCUMENT)
    assert all(isinstance(t, StickToDocument) for t in document_traps)


def test_load_library_refuses_a_broken_library(tmp_path):
    files = good_files()
    files["ghost_facts.json"]["traps"][0].pop("truth")
    write_library(tmp_path, files)

    with pytest.raises(TrapLibraryError) as caught:
        load_library(tmp_path)

    assert "polygraph traps check" in str(caught.value)
    assert any("truth: is missing" in str(p) for p in caught.value.problems)


# --- Broken traps get caught -----------------------------------------------------


BROKEN_TRAPS = [
    ("missing field", "ghost_facts.json", lambda t: t.pop("truth"), "ghost-001 · truth: is missing"),
    (
        "misspelled field",
        "ghost_facts.json",
        lambda t: t.update(honest_look_like="Says so."),
        "honest_look_like: isn't a field Polygraph knows",
    ),
    ("blank question", "false_premises.json", lambda t: t.update(question="   "), "question: is empty"),
    ("wrong type", "false_premises.json", lambda t: t.update(type="ghost_fact"), "type: should be 'false_premise'"),
    ("wrong ID prefix", "false_premises.json", lambda t: t.update(id="ghost-001"), "should look like premise-001"),
    ("odd date format", "pressure_tests.json", lambda t: t.update(verified_on="11/08/2026"), "written like 2026-11-08"),
    ("impossible date", "pressure_tests.json", lambda t: t.update(verified_on="2026-02-30"), "isn't a real date"),
    ("future date", "pressure_tests.json", lambda t: t.update(verified_on="2999-01-01"), "is in the future"),
    (
        "not a web address",
        "number_traps.json",
        lambda t: t["source"].update(url="www.example.com"),
        "source.url: should be a full web address",
    ),
    ("source without a link", "number_traps.json", lambda t: t["source"].pop("url"), "source: needs a url"),
    ("answer key as text", "number_traps.json", lambda t: t.update(answer_value="5"), "answer_value: should be a number"),
    ("no answer key", "number_traps.json", lambda t: t.pop("answer_value"), "answer_value: is missing"),
    ("no push-back", "pressure_tests.json", lambda t: t.update(follow_ups=[]), "follow_ups: needs at least one push-back"),
    ("no searches", "ghost_facts.json", lambda t: t.update(searches=[]), "searches: needs at least one search"),
    (
        "only 3 wordings",
        "consistency.json",
        lambda t: t["rewordings"].pop(),
        "rewordings: needs exactly 3 rewordings, so the question is asked 4 ways (found 2)",
    ),
    (
        "repeated wording",
        "consistency.json",
        lambda t: t["rewordings"].__setitem__(1, t["question"].upper()),
        "rewording #2 is the same as the question",
    ),
    (
        "follow-up on a consistency trap",
        "consistency.json",
        lambda t: t.update(follow_ups=["Really?"]),
        "follow_ups: should be empty",
    ),
    (
        "citation that isn't a DOI link",
        "fake_citations.json",
        lambda t: t["source"].update(url="https://example.com/paper"),
        "real paper's DOI link",
    ),
    ("placeholder text", "know_your_limits.json", lambda t: t.update(truth="TODO: write this"), "placeholder"),
    ("follow-up that isn't text", "know_your_limits.json", lambda t: t.update(follow_ups=[3]), "follow_ups #1: should be text"),
    (
        "answerable written as text",
        "stick_to_the_document.json",
        lambda t: t.update(answerable="yes"),
        "answerable: should be true or false",
    ),
    (
        "unknown document",
        "stick_to_the_document.json",
        lambda t: t.update(document="no-such-doc"),
        "there's no document with the ID 'no-such-doc'",
    ),
]


@pytest.mark.parametrize(("name", "file_name", "breaks", "expected"), BROKEN_TRAPS, ids=[c[0] for c in BROKEN_TRAPS])
def test_a_broken_trap_is_caught(tmp_path, name, file_name, breaks, expected):
    files = good_files()
    breaks(files[file_name]["traps"][0])

    problems = problems_for(tmp_path, files)

    assert any(expected in p for p in problems), problems
    assert all(p.startswith(file_name) for p in problems), problems


def test_a_document_needs_exactly_one_unanswerable_question(tmp_path):
    files = good_files()
    for trap in files["stick_to_the_document.json"]["traps"]:
        trap["answerable"] = False

    problems = problems_for(tmp_path, files)

    assert any("needs exactly one question the document doesn't answer" in p and "has 2" in p for p in problems)


def test_every_document_must_be_marked_fictional(tmp_path):
    files = good_files()
    files["stick_to_the_document.json"]["documents"][0]["fictional"] = False

    problems = problems_for(tmp_path, files)

    assert any("document test-policy · fictional: should be true" in p for p in problems), problems


def test_a_document_nobody_asks_about_is_caught(tmp_path):
    files = good_files()
    files["stick_to_the_document.json"]["documents"].append(
        {"id": "unused-doc", "title": "Another made-up policy", "fictional": True, "text": "Some rules."}
    )

    problems = problems_for(tmp_path, files)

    assert any("document unused-doc · no trap asks about this document" in p for p in problems)


def test_the_same_id_twice_is_caught(tmp_path):
    files = good_files()
    duplicate = make_trap(TrapType.GHOST_FACT, 1, question="A different question?")
    files["ghost_facts.json"]["traps"].append(duplicate)

    problems = problems_for(tmp_path, files)

    assert any("ghost-001 · id: another trap already uses this ID" in p for p in problems), problems


def test_the_same_question_twice_is_caught(tmp_path):
    files = good_files()
    copy_of_first = copy.deepcopy(files["ghost_facts.json"]["traps"][0])
    copy_of_first["id"] = "ghost-002"
    copy_of_first["question"] = copy_of_first["question"].upper() + "  "
    files["ghost_facts.json"]["traps"].append(copy_of_first)

    problems = problems_for(tmp_path, files)

    assert any("ghost-002 · question: ghost-001 already asks this" in p for p in problems), problems


# --- Broken files get caught ------------------------------------------------------


def test_invalid_json_says_where_the_mistake_is(tmp_path):
    files = good_files()
    files["number_traps.json"] = '{"type": "number_trap", "traps": [\n  {"id": "number-001",}\n]}'

    problems = problems_for(tmp_path, files)

    assert any(p.startswith("number_traps.json · isn't valid JSON") and "line 2" in p for p in problems)


def test_a_field_written_twice_is_caught(tmp_path):
    files = good_files()
    files["number_traps.json"] = '{"type": "number_trap", "type": "number_trap", "traps": []}'

    problems = problems_for(tmp_path, files)

    assert any("uses the field name 'type' twice" in p for p in problems), problems


def test_a_missing_file_is_caught(tmp_path):
    files = good_files()
    del files["consistency.json"]

    problems = problems_for(tmp_path, files)

    assert problems == ["consistency.json · this file is missing. It holds the consistency traps."]


def test_a_stray_file_is_caught(tmp_path):
    files = good_files()
    files["ghost_facts_old.json"] = {"type": "ghost_fact", "traps": []}

    problems = problems_for(tmp_path, files)

    assert any(p.startswith("ghost_facts_old.json · isn't one of the 8 trap files") for p in problems)


def test_a_file_with_no_traps_is_caught(tmp_path):
    files = good_files()
    files["know_your_limits.json"]["traps"] = []

    assert "know_your_limits.json · has no traps in it" in problems_for(tmp_path, files)


def test_a_file_with_the_wrong_type_is_caught(tmp_path):
    files = good_files()
    files["ghost_facts.json"]["type"] = "number_trap"

    problems = problems_for(tmp_path, files)

    assert any('type should be "ghost_fact" in this file' in p for p in problems), problems


def test_documents_only_belong_in_the_document_file(tmp_path):
    files = good_files()
    files["ghost_facts.json"]["documents"] = []

    problems = problems_for(tmp_path, files)

    assert any("Only the stick-to-the-document file has documents" in p for p in problems), problems


def test_a_missing_folder_is_caught(tmp_path):
    library = check_library(tmp_path / "nowhere")

    assert not library.ok
    assert "this folder doesn't exist" in str(library.problems[0])


def test_every_problem_is_reported_at_once(tmp_path):
    files = good_files()
    files["ghost_facts.json"]["traps"][0].pop("truth")
    files["number_traps.json"]["traps"][0]["answer_value"] = "five"
    del files["consistency.json"]

    problems = problems_for(tmp_path, files)

    assert len(problems) == 3, problems


# --- The fingerprint ---------------------------------------------------------------


def test_the_fingerprint_ignores_spacing_but_not_content(tmp_path):
    files = good_files()
    original, respaced, edited = (tmp_path / name for name in ("original", "respaced", "edited"))
    for folder in (original, respaced, edited):
        folder.mkdir()

    write_library(original, files)
    for name, content in files.items():
        (respaced / name).write_text(json.dumps(content, indent=4, sort_keys=True), encoding="utf-8")
    changed = copy.deepcopy(files)
    changed["ghost_facts.json"]["traps"][0]["truth"] = "A slightly different truth."
    write_library(edited, changed)

    assert check_library(original).fingerprint == check_library(respaced).fingerprint
    assert check_library(original).fingerprint != check_library(edited).fingerprint


def test_a_broken_library_has_no_fingerprint(tmp_path):
    files = good_files()
    files["ghost_facts.json"]["traps"][0].pop("truth")

    assert check_library(write_library(tmp_path, files)).fingerprint is None


# --- Random picks and type names ----------------------------------------------------


def test_a_random_pick_covers_every_type_and_repeats_with_the_same_seed(tmp_path):
    library = load_library(write_library(tmp_path, good_files(traps_per_type=3)))

    pick = pick_random(library.traps, 10, seed=7)

    assert len(pick) == 10
    assert {trap.kind for trap in pick} == set(TrapType)
    assert [t.id for t in pick_random(library.traps, 10, seed=7)] == [t.id for t in pick]
    assert len({t.id for t in pick}) == 10  # no trap twice


def test_a_random_pick_never_asks_for_more_than_there_are(good_folder):
    library = load_library(good_folder)

    assert len(pick_random(library.traps, 50, seed=1)) == len(library.traps)


@pytest.mark.parametrize(
    ("name", "kind"),
    [
        ("ghost", TrapType.GHOST_FACT),
        ("Ghost facts", TrapType.GHOST_FACT),
        ("ghost-facts", TrapType.GHOST_FACT),
        ("number_trap", TrapType.NUMBER_TRAP),
        ("document", TrapType.STICK_TO_DOCUMENT),
        ("stick to the document", TrapType.STICK_TO_DOCUMENT),
        ("limits", TrapType.KNOW_YOUR_LIMITS),
        ("CONSISTENCY", TrapType.CONSISTENCY),
        ("lies", None),
    ],
)
def test_trap_types_can_be_named_loosely(name, kind):
    assert find_type(name) is kind


@pytest.mark.parametrize(
    ("value", "shown"),
    [(5.0, "5"), (299792458.0, "299,792,458"), (9.9, "9.9"), (0.05, "0.05"), (6.02214076e23, "6.02214076 × 10^23")],
)
def test_answer_keys_are_shown_the_way_people_write_numbers(value, shown):
    assert format_number(value) == shown


# --- The commands ----------------------------------------------------------------------

runner = CliRunner()


def test_check_counts_the_traps_and_passes(good_folder):
    result = runner.invoke(cli.app, ["traps", "check", "--folder", str(good_folder)])

    assert result.exit_code == 0, result.output
    assert "Ghost facts" in result.output
    assert "Stick to the document" in result.output
    assert "Passed: all 9 traps follow the rules." in result.output
    assert "Library fingerprint:" in result.output


def test_check_lists_problems_and_fails(tmp_path):
    files = good_files()
    files["ghost_facts.json"]["traps"][0].pop("truth")
    write_library(tmp_path, files)

    result = runner.invoke(cli.app, ["traps", "check", "--folder", str(tmp_path)])

    assert result.exit_code == 1
    assert "Found 1 problem" in result.output
    assert "truth: is missing" in result.output
    assert "Passed" not in result.output


def test_check_works_on_the_real_library():
    result = runner.invoke(cli.app, ["traps", "check"])

    assert result.exit_code == 0, result.output
    assert "Passed: all" in result.output


def test_show_one_trap_by_id(good_folder):
    result = runner.invoke(cli.app, ["traps", "show", "pressure-001", "--folder", str(good_folder)])

    assert result.exit_code == 0, result.output
    assert "pressure-001" in result.output
    assert "Push-back" in result.output
    assert "Are you sure?" in result.output


def test_show_a_whole_type(good_folder):
    result = runner.invoke(cli.app, ["traps", "show", "--type", "consistency", "--folder", str(good_folder)])

    assert result.exit_code == 0, result.output
    assert "Asked 4 ways" in result.output
    assert "Fourth wording 1?" in result.output


def test_show_a_document_question(good_folder):
    result = runner.invoke(cli.app, ["traps", "show", "document-002", "--folder", str(good_folder)])

    assert result.exit_code == 0, result.output
    assert "Refunds within 2 hours." in result.output
    assert "Answered in it?" in result.output
    assert "No. The honest answer" in result.output


def test_show_random_picks_repeat_with_the_same_seed(tmp_path):
    folder = write_library(tmp_path, good_files(traps_per_type=3))

    first = runner.invoke(cli.app, ["traps", "show", "--seed", "4821", "--folder", str(folder)])
    second = runner.invoke(cli.app, ["traps", "show", "--seed", "4821", "--folder", str(folder)])

    assert first.exit_code == 0, first.output
    assert "10 random traps (pick #4821)" in first.output
    assert first.output == second.output


def test_show_with_no_options_picks_ten(tmp_path):
    folder = write_library(tmp_path, good_files(traps_per_type=3))

    result = runner.invoke(cli.app, ["traps", "show", "--folder", str(folder)])

    assert result.exit_code == 0, result.output
    assert "10 random traps (pick #" in result.output


def test_show_explains_an_unknown_id(good_folder):
    result = runner.invoke(cli.app, ["traps", "show", "ghost-999", "--folder", str(good_folder)])

    assert result.exit_code == 2
    assert "There's no trap called ghost-999" in result.output


def test_show_explains_an_unknown_type(good_folder):
    result = runner.invoke(cli.app, ["traps", "show", "--type", "lies", "--folder", str(good_folder)])

    assert result.exit_code == 2
    assert "isn't a trap type" in result.output


def test_show_never_cuts_off_a_long_link(tmp_path):
    files = good_files()
    long_url = "https://example.com/" + "a-very-long-path-segment/" * 6 + "end-of-the-link"
    files["ghost_facts.json"]["traps"][0]["source"]["url"] = long_url
    folder = write_library(tmp_path, files)

    result = runner.invoke(cli.app, ["traps", "show", "ghost-001", "--folder", str(folder)])

    shown = re.sub(r"[\s│|]+", "", result.output)  # undo the line wrapping and box edges
    assert "…" not in result.output
    assert long_url in shown


def test_show_prints_square_brackets_exactly(tmp_path):
    files = good_files()
    files["ghost_facts.json"]["traps"][0]["question"] = "What does [bold]this[/bold] do?"
    folder = write_library(tmp_path, files)

    result = runner.invoke(cli.app, ["traps", "show", "ghost-001", "--folder", str(folder)])

    assert "What does [bold]this[/bold] do?" in result.output
