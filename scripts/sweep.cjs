#!/usr/bin/env node
// Sweeps every repository the token's owner owns for links to Claude sessions,
// threads and projects, and for bare Claude session IDs (patterns live in
// claude-link-guard.cjs), and removes them:
//   - PR and issue titles and bodies, and review summaries, are edited.
//   - Comments the owner wrote are deleted and posted again without the link,
//     so the link doesn't survive in GitHub's edit history. Review-thread
//     replies are reposted into the same thread.
//   - Comments by anyone else (bots included) and review-thread openers are
//     edited, since reposting them would change their author or break the thread.
//   - Commit messages can't be edited; new ones carrying a link are listed in an
//     issue in REPORT_REPO so history can be rewritten later.
//
// Env: SWEEP_TOKEN (fine-grained PAT, all repos: Issues, Pull requests RW,
// Contents R), FULL=true to sweep everything instead of the recent window,
// REPORT_REPO (owner/name, should be private), DRY_RUN=true to change nothing.
// Output names no private repository and quotes no text, because the logs of
// this public repository are public.

const { hasLink, scrubField } = require('./claude-link-guard.cjs');

const TOKEN = process.env.SWEEP_TOKEN;
const FULL = process.env.FULL === 'true';
const DRY_RUN = process.env.DRY_RUN === 'true';
const REPORT_REPO = process.env.REPORT_REPO || '';
// Scheduled runs often start late, so each run looks back well past its interval
const WINDOW_MINUTES = Number(process.env.WINDOW_MINUTES || 90);
const REPORT_TITLE = 'Commit messages with Claude links';

// Errors name API paths; keep repository names out of the public log
const redact = (msg) => String(msg).replace(/\/repos\/[^/\s]+\/[^/\s:]+/g, '/repos/<repo>');

let fetchImpl = (...args) => fetch(...args);

async function api(method, path, body) {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const err = new Error(`${method} ${path.split('?')[0]}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function* paginate(path) {
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const items = await api('GET', `${path}${sep}per_page=100&page=${page}`);
    yield* items;
    if (items.length < 100) return;
  }
}

function makeSweeper(me, since) {
  const stats = { checked: 0, edited: 0, reposted: 0, failed: 0, commits: [] };
  const sinceQ = since ? `since=${since}` : '';
  const q = (path, extra = '') => {
    const parts = [sinceQ, extra].filter(Boolean).join('&');
    return parts ? `${path}?${parts}` : path;
  };

  async function attempt(fn) {
    try {
      if (!DRY_RUN) await fn();
      return true;
    } catch (err) {
      console.error(`  failed: ${redact(err.message)}`);
      stats.failed++;
      return false;
    }
  }

  async function edit(method, path, fields) {
    const update = {};
    for (const [key, value] of Object.entries(fields)) {
      if (hasLink(value)) update[key] = scrubField(value);
    }
    if (!Object.keys(update).length) return;
    if (await attempt(() => api(method, path, update))) stats.edited++;
  }

  async function sweepRepo(repo) {
    const r = repo.full_name;
    for await (const issue of paginate(q(`/repos/${r}/issues`, 'state=all'))) {
      stats.checked++;
      const kind = issue.pull_request ? 'pulls' : 'issues';
      await edit('PATCH', `/repos/${r}/${kind}/${issue.number}`, { title: issue.title, body: issue.body });
      if (issue.pull_request) {
        for await (const review of paginate(`/repos/${r}/pulls/${issue.number}/reviews`)) {
          stats.checked++;
          await edit('PUT', `/repos/${r}/pulls/${issue.number}/reviews/${review.id}`, { body: review.body });
        }
      }
    }
    for await (const c of paginate(q(`/repos/${r}/issues/comments`))) {
      stats.checked++;
      if (!hasLink(c.body)) continue;
      if (c.user && c.user.login === me) {
        const number = c.issue_url.split('/').pop();
        const ok = await attempt(async () => {
          await api('POST', `/repos/${r}/issues/${number}/comments`, { body: scrubField(c.body) });
          await api('DELETE', `/repos/${r}/issues/comments/${c.id}`);
        });
        if (ok) stats.reposted++;
      } else {
        await edit('PATCH', `/repos/${r}/issues/comments/${c.id}`, { body: c.body });
      }
    }
    for await (const c of paginate(q(`/repos/${r}/pulls/comments`))) {
      stats.checked++;
      if (!hasLink(c.body)) continue;
      if (c.user && c.user.login === me && c.in_reply_to_id) {
        const number = c.pull_request_url.split('/').pop();
        const ok = await attempt(async () => {
          await api('POST', `/repos/${r}/pulls/${number}/comments/${c.in_reply_to_id}/replies`, { body: scrubField(c.body) });
          await api('DELETE', `/repos/${r}/pulls/comments/${c.id}`);
        });
        if (ok) stats.reposted++;
      } else {
        await edit('PATCH', `/repos/${r}/pulls/comments/${c.id}`, { body: c.body });
      }
    }
    if (since && repo.pushed_at && repo.pushed_at >= since) {
      const seen = new Set();
      for await (const branch of paginate(`/repos/${r}/branches`)) {
        for await (const commit of paginate(`/repos/${r}/commits?sha=${encodeURIComponent(branch.name)}&since=${since}`)) {
          if (seen.has(commit.sha)) continue;
          seen.add(commit.sha);
          if (hasLink(commit.commit.message)) stats.commits.push(`${r}@${commit.sha.slice(0, 12)} (${branch.name})`);
        }
      }
    }
  }

  return { stats, sweepRepo };
}

// The token shares its owner's hourly API budget with everything else they run,
// so a recent sweep only visits repositories with an issue or PR updated in the
// window (a new or edited comment or review updates its PR or issue), found with
// one search per kind instead of listing every repository. Returns null, meaning
// sweep them all, if the search comes back incomplete.
async function touchedRepos(me, since) {
  const names = new Set();
  const stamp = since.replace(/\.\d+Z$/, 'Z');
  for (const kind of ['is:issue', 'is:pr']) {
    for (let page = 1; ; page++) {
      const query = encodeURIComponent(`user:${me} ${kind} updated:>=${stamp}`);
      const res = await api('GET', `/search/issues?q=${query}&per_page=100&page=${page}`);
      if (res.incomplete_results || page > 10) return null;
      for (const item of res.items) names.add(item.repository_url.split('/repos/')[1]);
      if (res.items.length < 100) break;
    }
  }
  return names;
}

async function report(commits) {
  if (!commits.length || !REPORT_REPO || DRY_RUN) return;
  let issue = null;
  for await (const i of paginate(`/repos/${REPORT_REPO}/issues?state=open`)) {
    if (!i.pull_request && i.title === REPORT_TITLE) {
      issue = i;
      break;
    }
  }
  const lines = new Set((issue && issue.body ? issue.body.split('\n') : []).filter((l) => l.startsWith('- ')));
  for (const c of commits) lines.add(`- ${c}`);
  const body =
    'Commits whose messages carry a Claude link or session ID. Messages can only be fixed by rewriting history.\n\n' +
    [...lines].join('\n') + '\n';
  if (issue) await api('PATCH', `/repos/${REPORT_REPO}/issues/${issue.number}`, { body });
  else await api('POST', `/repos/${REPORT_REPO}/issues`, { title: REPORT_TITLE, body });
}

async function main() {
  if (!TOKEN) {
    console.log('::warning::SWEEP_TOKEN secret is not set, so nothing was swept.');
    return true;
  }
  const me = (await api('GET', '/user')).login;
  const since = FULL ? null : new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
  const touched = since ? await touchedRepos(me, since) : null;
  const { stats, sweepRepo } = makeSweeper(me, since);
  let repos = 0;
  for await (const repo of paginate('/user/repos?affiliation=owner')) {
    if (repo.archived) continue;
    if (touched && !touched.has(repo.full_name) && !(repo.pushed_at && repo.pushed_at >= since)) continue;
    repos++;
    try {
      await sweepRepo(repo);
    } catch (err) {
      console.error(`A repository could not be swept: ${redact(err.message)}`);
      stats.failed++;
    }
  }
  try {
    await report(stats.commits);
  } catch (err) {
    console.error(`The commit report could not be written: ${redact(err.message)}`);
    stats.failed++;
  }
  console.log(
    `${FULL ? 'Full' : 'Recent'} sweep${DRY_RUN ? ' (dry run)' : ''}: ${repos} repos, ${stats.checked} items checked, ` +
      `${stats.edited} edited, ${stats.reposted} reposted, ${stats.commits.length} commit(s) listed, ${stats.failed} failed.`
  );
  return stats.failed === 0;
}

if (require.main === module) {
  main().then(
    (ok) => process.exit(ok ? 0 : 1),
    (err) => {
      console.error(err.status === 401 ? 'SWEEP_TOKEN was rejected (expired or revoked).' : redact(err.message));
      process.exit(1);
    }
  );
}

module.exports = { makeSweeper, main, setFetch: (f) => (fetchImpl = f) };
