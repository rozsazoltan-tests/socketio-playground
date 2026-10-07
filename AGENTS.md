# Teaching playgrounds

This open-source course playground teaches a selected concept end to end, not a product dashboard or production template.

## Code and comments

Build the smallest coherent working example. Keep sources inspectable and tests meaningful. Remove obsolete code and dependencies only within task scope. Avoid speculative abstractions or frameworks; avoid unrelated refactors.

Write English teaching comments at key setup, responsibility boundaries, lifecycle, data flow, validation, async ordering, errors, and cleanup. Explain decisions and what learners should notice, not obvious lines. Preserve security and concurrency protections in demos.

## Documentation

Write the README in natural English, with concise prose, few headings, and small annotated examples explaining flow and expected observations. Verify prerequisites, commands, and configuration. Distinguish runnable examples from excerpts and assumptions from verified behavior. Avoid marketing, badge clutter, API catalogs, invented URLs, and unverified guarantees.

Document deployment only when relevant. Describe verified prerequisites, setup, startup or build requirements, environment handling, restart, and limitations. Do not assume provider compatibility, proxy behavior, or ports.

## Interfaces and state

For UIs, use native controls, plain layouts, and subtle purposeful styling. Keep content and diagnostics legible, label states beyond color, and support narrow screens. Bound content; use internal scrolling where appropriate. Preserve intentional design when changing logic; avoid decoration unless requested.

Explain connection, reset, and state changes. Confirm destructive actions and explain their scope. Label demo shortcuts: selectable personas are not authentication; temporary memory is not durable storage. Explain privacy. Retain validation, authorization, escaping, error paths, bounded state, and cleanup. Never imply delivery, reading, or success without evidence.

## Tools and verification

Inspect instructions, source, tests, manifests, and lockfiles. Use selected runtimes and package managers; install reproducibly. Keep documented versions and configuration aligned.

Verify relevant automated checks and real behavior. Report evidence and limits honestly; reuse still-valid results instead of rerunning unchanged checks. Preserve unrelated user changes.

## Publication

Exclude disposable local artifacts; preserve intentionally tracked generated files. Never publish secrets, personal domains, private hostnames, or actual environment values. Respect the existing license and publishing identity. Do not invent either.

Require explicit permission for each commit, push, branch change, or remote mutation.
