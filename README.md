# Codespaces Admin

A standalone, browser-only website for administering GitHub organization Codespaces.
No backend, package installation, build, or deployment secrets are required.

## Host on GitHub Pages

1. Add `index.html`, `.nojekyll`, `.github/workflows/pages.yml`, `.devcontainer/`,
   `tests/app.test.mjs`, and `tests/backup.test.mjs`
   to a GitHub repository, preserving the directory structure.
2. Under **Settings > Pages > Build and deployment**, select **GitHub Actions**.
3. Push to `main` or `master`, or run **Deploy Codespaces Admin to GitHub Pages**
   manually from the Actions tab after the workflow is on the default branch.
4. Open the URL from the deployment's `github-pages` environment.
   Enable **Enforce HTTPS** in Pages settings.

The workflow tests the app, then publishes only `index.html` and `.nojekyll`.
It does not publish exports, attachments, tests, or other repository contents.
Both repository-subpath Pages sites and custom domains work without configuration.

Alternatively, publish `index.html` and `.nojekyll` using Pages' **Deploy from a
branch** option (repository root), or copy them to any HTTPS static web host.
The branch method does not run the included tests.

## Connect

Enter an **organization login** such as `octodemo`, not an enterprise slug or a URL.
Use an organization owner account and a classic personal access token with the
`admin:org` scope. Authorize the token for the organization's SSO if required.
Organization token policies can also restrict access.

The documented APIs are organization-scoped: this app does **not** discover or
administer all organizations belonging to a GitHub enterprise account.
It targets GitHub.com (`https://api.github.com`) only, not GitHub Enterprise Server
or a different API host.

After connecting, the organization is locked for that session. Disconnect before
switching organizations. **Refresh list** reuses the in-memory token without asking
for it again and preserves the current inventory sort and filters. Failed refreshes
also retain the connection for retrying. A browser reload or disconnect clears the
token; use the in-app button rather than reloading the browser.

Inventory and member lookups request 100 results per page and continue until
the reported total is loaded or an empty page is returned, even if GitHub returns
fewer than 100 on an intermediate page. There is no 50-result display limit.
The app reports partial
results and errors rather than substituting sample data.

## Admin controls

- Organization and member Codespaces inventories.
- Synchronized horizontal scrollbars above and below both tables, with widths
  updated automatically when results, filters, tabs, or the viewport change.
- Full-width layout without a maximum-width cap. On desktop, the inventory fills
  the remaining viewport height, with internal scrolling and sticky column headers.
  Small screens retain page scrolling so controls remain accessible.
- Environment columns for OS, region, branch, devcontainer configuration path,
  and prebuild status, with sorting and filtering in both tables.
- Separate sortable and filterable columns for every former detail: ID, billable
  owner, machine type/description, created/updated timestamps, idle timeout,
  retention period/expiry, uncommitted/unpushed changes, commits ahead/behind,
  pending operation, operation-disabled reason, and prebuild availability.
  Missing API values are distinguished from `false` or zero. Date columns have
  independent inclusive date-range filters and display local date and time,
  with the source timestamp available on hover.
- Search inventory by name, owner, repository, state, machine sizes, or actions.
- Sort every column in either table by clicking its heading; click again to reverse.
  CPU cores, RAM (GiB), and storage (GiB) have separate columns in both tables
  and sort numerically; last-used sorting uses actual timestamps.
- Filter each column independently, including available actions, with case-insensitive
  text matching and exact numeric filters for machine sizes. Last-used filters use inclusive date ranges in the browser's local
  timezone. Column filters combine with each other and the inventory search.
  **Clear filters** resets filters without changing the current sort.
- Stop and delete individual Codespaces, with confirmation.
- Replace the Codespaces access policy, including the complete list of usernames
  when choosing `selected_members`.
- Add or remove selected users' organization-billed Codespaces eligibility.

The linked API does not provide a current-access-policy read endpoint, so the
policy form is deliberately unset rather than presenting a guessed current value.
Selecting `selected_members` replaces the existing selected-user list.
Deletion is asynchronous and can destroy uncommitted or unpushed work.
Use Refresh to check the current state after GitHub accepts a request.

### Base-image availability

The documented organization Codespaces responses do **not** contain the container
base image or resolved running image digest, so the app does not show a base-image column. `machine.operating_system` is the machine OS, not an image
name. `devcontainer_path` identifies the configuration path, not the configuration
contents or the actual running image.

To investigate an image, inspect the indicated repository devcontainer configuration
and any referenced Dockerfile. Its current `image`, `build`, or Dockerfile `FROM`
declarations are not proof of what an existing Codespace is running: local edits,
build stages, variable substitutions, and rebuild history can differ. This app
does not fetch repository files, require extra repository scopes, or execute
commands inside users' Codespaces.

API reference:
<https://docs.github.com/en/rest/codespaces/organizations?apiVersion=2026-03-10>

## Credentials and hosting

GitHub Pages serves public application code; it does not authenticate website
visitors. Each administrator supplies their own token. GitHub enforces authorization
for API requests. There is no shared server credential.

Tokens are held in page memory, removed from the input after connecting, and cleared
on disconnect or reload. They are not placed in URLs, cookies, browser storage,
repository files, or Actions secrets. Requests go directly to `api.github.com`
using the `2026-03-10` API version. No proxy or CORS bypass is used.

Only enter a privileged token into a deployment you trust. Whoever can modify the
site's JavaScript could access entered tokens. Protect the publishing branch, use
short-lived tokens, and disconnect when finished. There are no external scripts,
fonts, analytics, or third-party runtime dependencies. The page's content security
policy restricts API connections to `api.github.com` and blocks form navigation.

Browser/network restrictions or enterprise policy may prevent API requests. The
app displays these failures; check browser developer tools and organization
policies rather than weakening browser security.

## Validate locally

With Node.js 22 or newer:

```sh
node --test tests/app.test.mjs tests/backup.test.mjs
```

Serve the folder with any local HTTP static server for browser development.
Production hosting should use HTTPS.

## Automatic Codespaces backups

The `.devcontainer/devcontainer.json` starts an unattended backup service whenever
the container starts. Rebuild an existing Codespace to apply this configuration.
The service takes an initial snapshot, then checks every 60 seconds, creating a
new `codespace-backup/<UTC timestamp>-<unique ID>` branch on `origin` when the saved
working tree or source commit changes. It does not switch your working branch,
alter your staging area, or commit to your working branch. The snapshot includes
tracked changes, deletions, and non-ignored untracked files, plus the current
commit's history. Unchanged snapshots do not create additional branches.

**Keep secrets and private files out of Git.** Non-ignored untracked files are
automatically published to the repository; tracked files are included even if
later added to `.gitignore`. Backup branches are not automatically deleted.
Git hooks are deliberately bypassed for unattended backup pushes, and backup
commits use the `Codespace Backup` identity without signing. Repository rules,
credentials, or unavailable networking can still prevent a push.

Failed pushes remain queued as local Git refs and are retried on subsequent
intervals and container starts. Errors and push results are recorded in
`$(git rev-parse --absolute-git-dir)/codespace-backup/backup.log`.
The service attempts a final backup if it receives a termination signal, but
Codespaces has no guaranteed shutdown hook. **This is best-effort protection,
not a zero-loss guarantee:** unsaved editor buffers, ignored files, uncommitted
submodule contents, and changes since the last successful snapshot are not
protected remotely. A stopped Codespace normally retains saved files; deleting
it also destroys any backups that have not been pushed.

The service requires Git, Bash, `flock`, and `timeout` (included in the configured
image), and non-interactive push access to `origin`. It does not request or store
additional credentials. To run a single backup when the service is not running:

```sh
bash .devcontainer/backup.sh once
```
