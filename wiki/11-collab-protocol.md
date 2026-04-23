# 11 — Collab protocol with Codex

This project uses a structured **two-agent review workflow** between two AI coding agents (or an agent + a human reviewer). The lead architect agent ("opus") writes implementations; the reviewer agent ("codex") reviews proposals + implementations + commits before they land. Both communicate through a shared file `.collab/channel.md`.

You inherit:

- A working `.collab/` directory with channel + agents.json + archive of past topics
- A pattern that's worked for ~7 successful topic cycles (038–044) since the project's catchup sprint

If future contributors don't use AI agents, the pattern still works as a **structured human review workflow** — replace "codex" with "your senior reviewer."

## Files

```
.collab/
├── agents.json             ← Address book. Names, pane_ids (tmux), roles.
├── channel.md              ← One active topic. Append-only during active discussion.
└── archive/
    ├── 038_*.md            ← Each completed topic preserved for future reference.
    ├── 039_*.md
    ├── 040_*.md
    ├── ...
```

`.collab/` is in `.gitignore` (per `umple-lsp/.gitignore`). Topic state is local to the dev machine.

## How a topic flows

The "strict iterative cycle" we settled on:

1. **Codex writes a request** in detail to `channel.md`. Defines scope, expected behavior, required tests, anything off-limits.
2. **Opus implements only that item.** No commit yet.
3. **Opus reports back** in `channel.md` with:
   - files changed
   - what was done
   - test results
   - any deviations from spec + reasoning
4. **Codex reviews.** Posts findings in `channel.md`. Either approves or blocks with specific issues.
5. **Iterate** if blocked — opus addresses, reposts, codex re-reviews. Don't commit during iteration.
6. **Once codex approves, opus commits immediately** (no extra user confirmation needed in collab mode — this differs from non-collab mode).
7. **Opus archives** the topic to `.collab/archive/<NNN>_<name>.md`, resets channel to idle.

The point of the cycle: **catch design + correctness issues before they land in master**. Especially valuable for grammar and completion changes where edge cases bite hard.

## Topic numbering

Sequential, three-digit, prefix in the channel filename:

```
.collab/archive/038_req_implementsReq_grammar_catchup.md
.collab/archive/039_req_followups_completion_and_rename.md
.collab/archive/040_zed_release_automation_scope.md
.collab/archive/041_conflict_cleanup_commit.md
.collab/archive/042_association_partial_completion.md
.collab/archive/043_association_type_typed_prefix_cleanup.md
.collab/archive/044_association_arrow_slot_completion.md
```

Pick the next number when starting a new topic.

## Tmux delivery (if using both agents on one machine)

Each agent runs in its own tmux pane. Communication = file write + a short tmux wakeup so the other agent re-reads.

Agents are addressed by `pane_id` (read from `.collab/agents.json` at every send, never cached). The exact send sequence:

```bash
tmux copy-mode -t %24 -q 2>/dev/null   # exit copy mode (must do)
sleep 0.1
tmux send-keys -t %24 -l "[COLLAB] From opus: One-line summary. See .collab/channel.md"
sleep 0.1
tmux send-keys -t %24 Enter             # delayed Enter — prevents key drops
```

The full collab skill (general, not project-specific) lives in each agent's own skills directory — `~/.agent-skills/collab/SKILL.md` for Claude Code (opus), `~/.codex/skills/collab/SKILL.md` for Codex CLI. Always read it once when first using the workflow.

## Practical rules from experience

These are non-obvious things we learned through topics 038–044:

### Don't commit before approval

Codex's review catches real bugs. Topics 042 and 043 both had blocker rounds — codex spotted edge cases I missed. Committing before approval would have shipped wrong fixes.

### After approval, commit immediately

Don't wait for additional user confirmation. The collab skill's `feedback-commit-after-codex-approval` rule explicitly supersedes the general "always confirm before committing" default.

### Push and publish are separate from commit

Codex approval = green light to commit. **Push** to the remote and **npm publish** are separate decisions, usually made by the human user. Default to "commit, then ask before pushing" unless the user has said "go all the way."

### Archive every topic, even rejected ones

The archive is the project's institutional memory. When a future contributor wonders "why isn't this auto-PR'd?" the answer is in `.collab/archive/040_*.md`. Don't delete archives.

### Channel is a discussion record, not a planning doc

`channel.md` is for the back-and-forth. **Don't** put long-term design notes there — they'll get archived and lost. For long-term docs, put them in this `wiki/` folder or in CLAUDE.md.

### The user is the tiebreaker

If opus and codex disagree and neither will yield, the human user is the tiebreaker. Common pattern: codex blocks, opus disagrees, both post their reasoning in channel.md, user reads both and decides.

## What if there's no codex?

If you're a solo developer not using AI review, the same workflow still works:

1. Open a draft PR for each "topic" (instead of writing to channel.md)
2. Self-review the PR diff before merging
3. Run the same programmatic + test verification opus does

The discipline (don't commit before review, isolate one item per cycle, archive the discussion) is the value, not the AI agent specifically.

## Common collab anti-patterns (don't do these)

- **Batching multiple items into one cycle.** If codex requests item 1, do ONLY item 1. Save item 2 for the next cycle. Reduces blast radius and review burden.
- **Implementing speculatively before review.** Don't write 500 lines then ask codex to review. Propose the design first, get a go-ahead, THEN implement.
- **Treating codex's "looks good" comments as commit approval.** They're not. Wait for an explicit "Approved. You can commit."
- **Ignoring blockers because tests pass.** Codex's blockers are usually about edge cases tests don't cover. Address them.

## Where to read more

- General collab skill (per-agent): `~/.agent-skills/collab/SKILL.md` (Claude Code) or `~/.codex/skills/collab/SKILL.md` (Codex CLI) — same protocol, different install paths
- Project-specific tweaks: `CLAUDE.md` and `CODEX.md` (both gitignored — local instructions for each agent)
- Past topic archives: `.collab/archive/`
