#!/usr/bin/env python3
"""ES-wave-6 §D2 AC-D2-3 — patch .env.docker from a Vercel prod env dump.

Reads the source dump (Vercel-pulled prod env) and the target .env.docker file.
For each key in the source, if also present in the target, replaces the
target value. Preserves target-only keys (local overrides like *_LOCAL,
cloudflared tunnel URL, dev-only DB pointers).

NEVER prints key values. Prints only key names + a count summary.

Usage: python3 scripts/ops/patch-env-docker.py <source.env> <target.env>
"""
import sys
import os
import re
from typing import Dict, List, Tuple

KEY_RE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$')


def parse_env(path: str) -> Tuple[Dict[str, str], List[str]]:
    """Return (kv-map, ordered-keys-with-comments-as-line-strings)."""
    if not os.path.exists(path):
        print(f"[abort] file not found: {path}", file=sys.stderr)
        sys.exit(2)
    kv: Dict[str, str] = {}
    lines: List[str] = []
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            lines.append(line)
            m = KEY_RE.match(line)
            if m:
                kv[m.group(1)] = m.group(2)
    return kv, lines


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <source.env> <target.env>", file=sys.stderr)
        return 2
    source_path, target_path = sys.argv[1], sys.argv[2]
    source_kv, _ = parse_env(source_path)
    target_kv, target_lines = parse_env(target_path)

    updated: List[str] = []
    unchanged: List[str] = []
    target_only: List[str] = [k for k in target_kv if k not in source_kv]

    new_lines: List[str] = []
    for line in target_lines:
        m = KEY_RE.match(line)
        if not m:
            new_lines.append(line)
            continue
        key = m.group(1)
        if key in source_kv:
            new_value = source_kv[key]
            if new_value != target_kv[key]:
                updated.append(key)
            else:
                unchanged.append(key)
            new_lines.append(f"{key}={new_value}")
        else:
            new_lines.append(line)

    # FIX (2026-05-11): the original script silently dropped source-only keys (keys present
    # in prod env but missing from .env.docker), which left 6 prod-required vars (Stripe,
    # Gemini, Scraper, Perplexity) absent and broke UAT for those flows. Append them now.
    source_only_keys = sorted([k for k in source_kv if k not in target_kv])
    if source_only_keys:
        # Drop a trailing empty line if present, then add a header + the new keys
        if new_lines and new_lines[-1] != "":
            new_lines.append("")
        new_lines.append("# ── Added from prod (source-only keys not previously in target) ──")
        for k in source_only_keys:
            new_lines.append(f"{k}={source_kv[k]}")

    with open(target_path, "w", encoding="utf-8") as f:
        f.write("\n".join(new_lines))
        f.write("\n")

    print(f"[patch-env-docker] source={source_path} target={target_path}")
    print(f"[patch-env-docker] updated={len(updated)} unchanged={len(unchanged)} target_only={len(target_only)} source_only_appended={len(source_only_keys)}")
    if source_only_keys:
        print(f"[patch-env-docker] source-only keys appended: {', '.join(source_only_keys)}")
    if updated:
        print(f"[patch-env-docker] updated keys: {', '.join(sorted(updated))}")
    if target_only:
        print(f"[patch-env-docker] preserved target-only keys: {', '.join(sorted(target_only))}")
    # Never print values.
    return 0


if __name__ == "__main__":
    sys.exit(main())
