# Standing conventions — pulse-backend

## Commits
- **Path-scoped only**: `git add <file> [<file> ...]` — never `git add -A`, never `git add .`
- **No trailers**: no `Co-Authored-By`, no `Signed-off-by`, no any trailer line, ever
- **Every commit is pushed** immediately after it is created

## Build gate
Run `node --check <file>` before committing any `.js` change.

## Permanently untracked
`tools/` is permanently untracked — never stage or commit anything under `tools/`.

## Migrations
Plain `.sql` files in `supabase/` only.  Apply via Supabase MCP (`apply_migration`) — never run raw SQL directly against the database.  Migration files are named `<timestamp>_<description>.sql`.

## Reports
Paste raw command output verbatim — no summaries, no "as shown above", no paraphrasing.  If output is long, paste the relevant tail; never replace it with prose.
