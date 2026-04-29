# Changelog

## 1.0.1 - 2026-04-29

- Added GitHub Actions Trusted Publishing release infrastructure for future npm publishes.
- Updated release documentation for maintainer handoff. No runtime LSP behavior changes from 1.0.0.

## 1.0.0 - 2026-04-29

- Added broader semantic coverage across completion, hover, go-to-definition, references, rename, workspace symbols, inlay hints, semantic tokens, and code actions.
- Improved association, requirement, trace, port, state, method, class, trait, and enum language intelligence.
- Added class-scoped transition event symbols so `trace transition eventName;` can resolve, find references, hover, and complete real transition events.
- Expanded Tree-sitter grammar and query coverage for additional Umple constructs, with corpus checks to guard parser regressions.
- Improved formatter safety and parser-visible formatting behavior, including idempotence and symbol-preservation checks.
- Updated docs for editor behavior, local development, publishing, parser/highlighting boundaries, and future maintenance.
