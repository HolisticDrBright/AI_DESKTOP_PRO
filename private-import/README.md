# private-import/

Staging directory for the practitioner's own source material.

**Nothing in this directory is committed.** `.gitignore` excludes the whole
directory by wildcard. Only `manifest.example.json` and this README are tracked,
via an explicit negation — see `.gitignore`.

Put spreadsheets, protocol documents and Obsidian exports here, hash them, write
a manifest beside them, and follow `docs/phase9b-operator-import.md`.

Verify before every import:

    git status --porcelain private-import/    # must print nothing new

If that prints a source file, stop and fix the ignore rule before continuing.
