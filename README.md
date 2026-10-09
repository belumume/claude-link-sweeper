# claude-link-sweeper

Keeps links to Claude sessions, threads and projects, and bare Claude session IDs, off GitHub across every repository this account owns. Claude's GitHub tools append a linked footer to PR bodies and comments on their own, and the Claude review bot posts claude.ai "Fix this" links, so stopping them at the source isn't enough.

Every 10 minutes the workflow checks recent PRs, issues, comments and reviews, and every night it checks all of them:

- PR and issue titles and bodies, and review summaries, are edited to remove the link.
- Comments the account owner wrote are deleted and posted again without it, so it doesn't stay in GitHub's edit history. Review-thread replies go back into the same thread.
- Comments by anyone else, and the first comment of a review thread, are edited in place.
- Commit messages can't be edited, so new ones carrying a link are listed in an issue titled "Commit messages with Claude links" in the private repository named by the `REPORT_REPO` variable (default `belumume/claude-config`), for a later history rewrite.

The logs never name a repository or quote text, because this repository is public.

## Setup

One secret, `SWEEP_TOKEN`: a fine-grained personal access token owned by the account, for all repositories, with Issues and Pull requests set to read and write and Contents set to read. Until it is set, runs succeed and do nothing. When it expires, runs fail, and GitHub emails the failure.

`node test/sweep.test.cjs` runs the sweeper against a fake API. A manual run can sweep everything or do a dry run.
