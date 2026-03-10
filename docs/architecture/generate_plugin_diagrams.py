#!/usr/bin/env python3
"""Regenerate all Paperclip plugin system architecture diagrams.

Usage:
    python3 docs/architecture/generate_plugin_diagrams.py

Prerequisites:
    brew install graphviz
    pip3 install diagrams
"""

import subprocess, sys, os

os.chdir(os.path.join(os.path.dirname(__file__), "../.."))

scripts = [
    ("plugin-architecture",    "Architecture Overview"),
    ("plugin-lifecycle",       "Lifecycle & Event Flow"),
    ("plugin-trust-surfaces",  "Trust Model & Surfaces"),
]

for slug, label in scripts:
    print(f"Generating {label}...")
    result = subprocess.run(
        [sys.executable, f"docs/architecture/_gen_{slug}.py"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"  ERROR: {result.stderr}")
        sys.exit(1)
    print(f"  → docs/architecture/{slug}.png + .pdf")

print("\nAll plugin diagrams regenerated.")
