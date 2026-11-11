"""Look for API keys and other secrets before anything is pushed (Session 10).

    python scripts/scan_secrets.py          everything: the git history, every file
                                            in the project, and the real keys in .env
    python scripts/scan_secrets.py --ci     GitHub Actions: the checked-out files only

What it looks for:
- the real key values in .env, anywhere: every version of every file in the git
  history, every commit message, and every file in the project folder (including
  the ones git ignores, like the answer cache), except .venv and node_modules
- the shapes of keys and tokens from OpenAI, Anthropic, Google, GitHub, AWS,
  Slack, Stripe, Hugging Face, Groq, npm and Netlify, and private key files
- a .env file (other than .env.example) that was ever committed
- assignments like api_key = "..." with a long value, listed to look at

It never prints a secret: a match shows as its first 4 characters and its length.
It exits with 1 if it finds a real key or a key-shaped string, so GitHub Actions
fails the run.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Well-known shapes, as each company issues them. A match is a finding. (The
# tests' made-up keys, like "sk-test-NEVER-SAVE-ME-...", aren't real shapes.)
PATTERNS: dict[str, re.Pattern[bytes]] = {
    "Anthropic API key": re.compile(rb"sk-ant-[A-Za-z0-9]{2,12}-[A-Za-z0-9_\-]{40,}"),
    "OpenAI API key": re.compile(rb"sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_\-]{20,}|[A-Za-z0-9]{48}(?![A-Za-z0-9]))"),
    "Google API key": re.compile(rb"AIza[0-9A-Za-z_\-]{35}"),
    "GitHub token": re.compile(rb"(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})"),
    "AWS access key": re.compile(rb"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    "Slack token": re.compile(rb"xox[abprs]-[A-Za-z0-9\-]{10,}"),
    "Stripe live key": re.compile(rb"(?:sk|rk)_live_[A-Za-z0-9]{20,}"),
    "Hugging Face token": re.compile(rb"\bhf_[A-Za-z0-9]{30,}"),
    "Groq API key": re.compile(rb"\bgsk_[A-Za-z0-9]{40,}"),
    "npm token": re.compile(rb"\bnpm_[A-Za-z0-9]{36}\b"),
    "Netlify token": re.compile(rb"\bnfp_[A-Za-z0-9]{36,}"),
    "private key": re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----"),
}

# Looser: worth a look, but often an example in code or a bot's answer.
LOOSE = re.compile(
    rb"""(?i)\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']([A-Za-z0-9_\-./+=]{24,})["']"""
)

# Findings already looked at and known to be harmless, by file and a fingerprint
# of the matched text (never the text itself). Empty until something needs it.
ALLOWED: set[tuple[str, str]] = set()

SKIP_DIRS = {".git", ".venv", "node_modules", "__pycache__", ".pytest_cache"}
ENV_NAMES = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD)", re.I)


def fingerprint(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def redact(data: bytes) -> str:
    text = data.decode("utf-8", "replace")
    return f"{text[:4]}… ({len(text)} characters)"


@dataclass
class Report:
    findings: list[str] = field(default_factory=list)
    to_look_at: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def scan(self, where: str, data: bytes, keys: dict[str, bytes]) -> None:
        for name, value in keys.items():
            if value in data:
                self.findings.append(f"{where}: the real {name} from .env")
        for kind, pattern in PATTERNS.items():
            for m in pattern.finditer(data):
                if (where.split(" @ ")[0], fingerprint(m.group(0))) in ALLOWED:
                    continue
                self.findings.append(f"{where}: something shaped like a key ({kind}), {redact(m.group(0))}")
        for m in LOOSE.finditer(data):
            self.to_look_at.append(f"{where}: {m.group(0)[:40].decode('utf-8', 'replace')}… ({len(m.group(1))}-character value)")


def git(*args: str) -> bytes:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, check=True).stdout


def env_keys() -> dict[str, bytes]:
    """The secret-looking values in .env, by name. Never printed."""
    path = ROOT / ".env"
    keys: dict[str, bytes] = {}
    if not path.exists():
        return keys
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        if ENV_NAMES.search(name) and len(value) >= 8:
            keys[name.strip()] = value.encode()
    return keys


def scan_history(report: Report, keys: dict[str, bytes]) -> None:
    """Every version of every file on every branch, every commit message, and who made each commit."""
    listing = git("rev-list", "--objects", "--all").decode("utf-8", "replace").splitlines()
    paths: dict[str, str] = {}
    for line in listing:
        sha, _, path = line.partition(" ")
        if path:
            paths.setdefault(sha, path)
    batch = subprocess.run(
        ["git", "cat-file", "--batch"], cwd=ROOT, input="\n".join(paths).encode() + b"\n", capture_output=True, check=True
    ).stdout
    blobs = 0
    i = 0
    while i < len(batch):
        header_end = batch.index(b"\n", i)
        sha, kind, size = batch[i:header_end].decode().split(" ")
        start = header_end + 1
        data = batch[start : start + int(size)]
        i = start + int(size) + 1
        if kind != "blob":
            continue
        blobs += 1
        report.scan(f"history: {paths[sha]} @ blob {sha[:10]}", data, keys)
    committed_env = sorted({p for p in paths.values() if re.search(r"(^|/)\.env($|\.)", p) and not p.endswith(".env.example")})
    for p in committed_env:
        report.findings.append(f"history: {p} was committed")
    messages = git("log", "--all", "--format=%H%x00%B%x00")
    parts = messages.split(b"\x00")
    for h, body in zip(parts[0::2], parts[1::2]):
        report.scan(f"commit message {h.strip()[:10].decode()}", body, keys)
    commits = len(git("rev-list", "--all").split())
    report.notes.append(f"history: {commits} commits on every branch, {blobs} versions of files, every commit message")


def project_files(include_ignored: bool) -> list[Path]:
    if not include_ignored:
        names = git("ls-files", "-z").split(b"\x00")
        return [ROOT / n.decode() for n in names if n]
    out = []
    for path in ROOT.rglob("*"):
        if path.is_file() and not any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            out.append(path)
    return out


def scan_files(report: Report, keys: dict[str, bytes], include_ignored: bool) -> None:
    files = project_files(include_ignored)
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        if rel == ".env":
            continue  # the one place the keys belong
        if rel == ".env.example":
            for line in path.read_text(encoding="utf-8").splitlines():
                name, sep, value = line.partition("=")
                if sep and not line.lstrip().startswith("#") and value.strip():
                    report.findings.append(f"files: .env.example has a value for {name.strip()}")
        try:
            data = path.read_bytes()
        except OSError as e:
            report.notes.append(f"files: couldn't read {rel} ({e.strerror})")
            continue
        report.scan(f"files: {rel}", data, keys)
    report.notes.append(f"files: {len(files)} files{' (including the ones git ignores)' if include_ignored else ''}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ci", action="store_true", help="only the checked-out files, without .env (for GitHub Actions)")
    args = parser.parse_args()

    report = Report()
    keys = {} if args.ci else env_keys()
    if not args.ci:
        names = ", ".join(f"{k} ({len(v)} characters)" for k, v in keys.items()) or "none"
        report.notes.append(f".env: looked for {len(keys)} real keys everywhere: {names}")
        # The check GitHub Actions runs (--ci) only knows the shapes. Make sure they'd catch these keys.
        for name, value in keys.items():
            shapes = [kind for kind, pattern in PATTERNS.items() if pattern.fullmatch(value)]
            report.notes.append(f".env: {name} {'matches the pattern for: ' + shapes[0] if shapes else 'MATCHES NO KNOWN SHAPE, so --ci would miss it'}")
        scan_history(report, keys)
    scan_files(report, keys, include_ignored=not args.ci)

    for line in report.notes:
        print(f"  {line}")
    if report.to_look_at:
        print(f"\nWorth a look ({len(report.to_look_at)}), usually examples in code or answers:")
        for line in report.to_look_at:
            print(f"  ? {line}")
    if report.findings:
        print(f"\nFOUND {len(report.findings)}:")
        for line in report.findings:
            print(f"  ✗ {line}")
        return 1
    print("\nNo API keys or secrets found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
