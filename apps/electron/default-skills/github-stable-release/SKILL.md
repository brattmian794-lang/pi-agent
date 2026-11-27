---
name: github-stable-release
description: "pi-agent 稳定版发布流程：准备版本、提交改动、打 tag 触发构建、发布并核验 GitHub Release。当用户要求发布正式版/稳定版、创建 GitHub Release、上传安装包、端到端提交并发布，或 tag 构建成功但发布页仍只有源码包时使用。"
group: proma
version: "1.0.0"
---

# GitHub Stable Release

Use this procedure to turn a verified application change into a public, downloadable stable GitHub Release. It covers repository hygiene, versioning, local checks, tag-triggered CI, draft publication, and public asset verification. It does not replace platform-specific release-signing requirements or authorize publishing unrelated worktree changes.

## When to Use

- A user requests a stable/formal version, GitHub release, installer publication, or end-to-end commit-and-push release.
- A tag-triggered Electron build succeeded but the Releases page still shows only source archives or an older release.
- A release must be checked for actual installers and localized release notes, not just a green workflow.

Do not use for prereleases unless the user explicitly requests one. Do not publish an existing draft without confirming the requested version and release contents.

## Procedure

1. **Inspect repository state and release conventions.** Run from the repository root:

   ```powershell
   git status --short --branch
   git branch --show-current
   git remote -v
   git log -5 --oneline
   git tag --list "v0.19.*" --sort=-version:refname | Select-Object -First 12
   git ls-remote origin refs/heads/main
   ```

   Confirm the current branch, configured push remote, latest stable/pre-release tags, and whether the remote branch has moved. Preserve unrelated dirty files. Never stage or commit the entire worktree by default.

2. **Read the release workflow and packaging scripts.** In this repository, `.github/workflows/release.yml` triggers on `push.tags: ['v*']`; it builds macOS arm64, macOS Intel, Windows x64, and Linux x64. Inspect the current workflow rather than assuming these names or conditions remain unchanged. The workflow runs `bun run electron:build`, prepares runtime dependencies, then invokes platform `electron-builder --publish always`. The macOS jobs merge `latest-mac.yml` after architecture builds.

3. **Select a stable version and update the owning package.** Read `apps/electron/package.json`, existing tags and release notes. Follow the repository's versioning rule: increment the affected distributable's version for every release. For a release following `0.19.70-beta.14`, this workflow chose stable `0.19.71`, not `0.19.70-beta.15`. Update only the appropriate app package and any other affected publishable package. Check whether the lockfile actually records workspace package versions before changing it. Do not infer the next version from the currently installed binary alone.

4. **Write Chinese release notes and preserve Chinese comments.** Add `release-notes/v<version>.md` with the existing version unchanged, using the project's release-note format shown in recent releases and the user's example:

    ```markdown
    # Proma v<version> 更新

    <一段简短总览，说明本版本最重要的变化>

    ## 新功能

    - **功能名称** — 简要说明行为变化和用户收益。

    ## 产品调整

    - **调整名称** — 简要说明。

    ## 体验优化

    - **优化名称** — 简要说明。

    ## Bug 修复

    - **问题名称** — 简要说明修复结果。
    ```

    Keep only sections that have actual changes; do not add empty headings or invent release content. Group related changes by user-facing outcome, use concise Chinese bullets with `- **短标题** — 说明` phrasing, and put supporting detail after an em dash. Preserve the real version number and all approved release content; formatting changes must not alter facts. Do not use a `下载` section that lists artifact filenames as a substitute for release notes: GitHub already displays downloadable assets below the body. Mention a platform-specific limitation only when relevant to the release. Use UTF-8 text. Any new or modified code comments, user-visible release copy, and commit subject should be Chinese when appropriate. Do not claim a platform package exists until the workflow assets confirm it.

5. **Review only task-related changes.** Inspect staged and unstaged changes separately:

   ```powershell
   git diff --check
   git diff -- apps/electron/package.json apps/electron/src/main/lib/agent-orchestrator.ts
   git status --short
   ```

   Stage explicit paths, for example:

   ```powershell
   git add apps/electron/package.json apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/title-generation.test.ts release-notes/v0.19.71.md
   git diff --cached --check
   git diff --cached --stat
   git diff --cached --name-only
   git diff --cached
   ```

   Confirm no unrelated user changes entered the index. Check comments in the actual diff, not only newly added files.

6. **Check encoding before committing.** Read the changed files in the editor/tooling and scan for common mojibake markers such as `Ã`, `Â`, `â€`, `ï¿½`, `锟斤拷`, or U+FFFD. PowerShell example:

   ```powershell
   Select-String -Path apps/electron/src/main/lib/agent-orchestrator.ts,apps/electron/src/main/lib/title-generation.test.ts,release-notes/v0.19.71.md -Pattern 'Ã.|Â.|â€|ï¿½|锟斤拷|�'
   ```

   No matches is a useful check, not proof of every possible encoding issue. Git's `LF will be replaced by CRLF` warning is a line-ending conversion notice, not evidence of Chinese corruption. ANSI color escape sequences in build output are terminal formatting, not garbled source text.

7. **Run project checks and local Electron build.** Proma uses Bun:

   ```powershell
   bun test apps/electron/src/main/lib/title-generation.test.ts
   bun run --filter='@proma/electron' typecheck
   bun run electron:build
   git diff --check
   ```

   Wait for the command to finish and capture its exit status. `electron:build` covers main process, agent runtime, terminal runtime, preload, renderer, CLI, native helpers and resources; a successful local build is not a substitute for remote platform packaging. Check `git status --short` afterward for generated tracked files and keep unrelated user changes untouched.

8. **Commit only reviewed release paths with a Chinese subject.** Example:

   ```powershell
   git commit -m "修复 Agent 会话自动命名并发布 v0.19.71"
   ```

   Then verify the commit and working tree. Do not amend or rewrite unrelated commits.

9. **Create and push the stable tag.** First ensure the remote does not already have the target tag:

   ```powershell
   git ls-remote --tags origin "refs/tags/v0.19.71"
   ```

   If absent and the commit is correct:

   ```powershell
   git tag -a v0.19.71 -m "发布 v0.19.71"
   git push origin main v0.19.71
   ```

   Use the actual branch and version. Pushing the `v*` tag is the release-workflow trigger. If a push fails with a transient connection error, verify remote refs and retry idempotently; do not recreate or force-move a tag that has already been published.

10. **Wait for the exact GitHub Actions run.** `gh` may not be installed. The public Actions API can identify the run:

    ```powershell
    $headers = @{ 'User-Agent' = 'PI-Desktop-release-check'; 'Accept' = 'application/vnd.github+json' }
    Invoke-RestMethod -Uri 'https://api.github.com/repos/OWNER/REPO/actions/runs?per_page=10' -Headers $headers |
      Select-Object -ExpandProperty workflow_runs |
      Select-Object -First 5 name,event,status,conclusion,head_branch,head_sha,html_url
    ```

    Match `head_branch` to `v<version>` and `head_sha` to the release commit. For the original tag-triggered run require `event=push`; a recovery run may be `workflow_dispatch`, but it must target the exact `v<version>` ref and same expected SHA. Check the jobs endpoint for every platform and the macOS metadata merge. Inspect cancelled jobs' annotations and completed steps before classifying failure: a hosted-runner acquisition cancellation is capacity pressure, not a build defect. In this workflow, a cancelled architecture can make the merge job `skipped` and the whole run fail even while other platforms succeed. A green run confirms workflow steps succeeded; it does not prove the release is public.

    After publication, verify public availability independently of the authenticated API. An anonymous release API request can return HTTP 403 while the public release page returns HTTP 200 and displays the expected release title. In that case, retain the authenticated `draft=false`/`prerelease=false` evidence, check the public page and representative installer/updater-metadata URLs, and report the anonymous API limitation rather than treating it as a failed release. The web page's `Assets N` count includes the two source archives, so it can exceed the release API's uploaded-asset count by two; do not require those counts to match. An HTTP 200 asset response verifies public routing, not a complete installer download, integrity, or installation.

    To recover an arm64 macOS job cancelled before it starts, first query its annotation. If it says the hosted runner was not acquired, do not change or recreate the tag. Request the workflow's supported manual dispatch against the same tag:

    ```powershell
    $dispatch = @{ ref = 'v0.19.77' } | ConvertTo-Json
    Invoke-WebRequest -UseBasicParsing -Method Post `
      -Uri 'https://api.github.com/repos/OWNER/REPO/actions/workflows/release.yml/dispatches' `
      -Headers $headers -ContentType 'application/json' -Body $dispatch
    ```

    A successful dispatch returns HTTP 204. Query runs by workflow and event, then require both `head_branch == v<version>` and `head_sha == <release commit>`; do not keep monitoring the earlier failed run. If using `rerun-failed-jobs`, verify the new `run_attempt` and inspect its job states: an accepted rerun can remain queued or be cancelled again by the same runner-capacity constraint. Retry only after checking the last attempt and avoiding overlapping duplicate releases. Once all platform jobs succeed, verify that the macOS merge job ran in that same successful run.

11. **Inspect the authenticated release and assets before publishing.** This repository's `electron-builder --publish always` creates a **draft** release. The merge workflow explicitly supports draft releases. Anonymous `/releases/tags/v<version>` may return 404, and the public Releases page may show only tag source archives while the draft has installer assets. Do not treat that as a packaging failure until checking the authenticated draft.

    `gh` was unavailable in the observed Windows environment. If Git Credential Manager has an authorized GitHub credential, it can be used in memory without printing the secret:

    ```powershell
    $credentialOutput = @('protocol=https','host=github.com','path=OWNER/REPO','') | git credential fill
    if ($LASTEXITCODE -ne 0) { throw 'GitHub credential helper did not return credentials' }
    $credential = @{}
    foreach ($line in $credentialOutput) {
      $pair = $line -split '=',2
      if ($pair.Count -eq 2) { $credential[$pair[0]] = $pair[1] }
    }
    if (-not $credential.ContainsKey('password')) { throw 'GitHub credential is unavailable' }
    $headers = @{
      'User-Agent'='PI-Desktop-release-check'
      'Accept'='application/vnd.github+json'
      'Authorization'="Bearer $($credential.password)"
      'X-GitHub-Api-Version'='2022-11-28'
    }
    $listUrl = 'https://api.github.com/repos/OWNER/REPO/releases?per_page=100&refresh=' + [DateTime]::UtcNow.Ticks
    $releases = Invoke-RestMethod -Uri $listUrl -Headers $headers
    $release = $releases | Where-Object tag_name -eq 'v0.19.71' | Select-Object -First 1
    $release | Select-Object id,tag_name,name,draft,prerelease,published_at,html_url
    $release.assets | Select-Object name,size,state,browser_download_url
    ```

    Never print, log, paste, or persist `$credential.password` or authorization headers. Stop and report an authentication blocker if no authorized credential is available.

12. **Publish a verified draft with localized notes.** Before changing `draft`, require the exact tag, expected commit, every required platform installer, update metadata, blockmaps where expected, and the UTF-8 Chinese release notes. Discover exact artifact filenames and nonzero sizes from the API; do not use an assumed asset count. The Proma build currently emits five primary installers (macOS arm64 DMG, macOS Intel DMG, Windows x64 EXE, Linux AppImage, Linux DEB), two macOS ZIP update archives, updater metadata, and blockmaps. Require both macOS architectures and a successfully merged `latest-mac.yml` before publishing stable.

    PowerShell `Get-Content` output has been observed serialized into release body text together with `PSPath` and other file metadata. Read notes as a plain UTF-8 string with `[IO.File]::ReadAllText((Resolve-Path ...).Path, [Text.Encoding]::UTF8)` and explicitly send UTF-8 bytes. Patch the existing draft by release ID, first keeping `draft=true`; include `tag_name` explicitly if the returned draft is untagged or does not match the intended version:

    ```powershell
    $notes = [IO.File]::ReadAllText((Resolve-Path "release-notes/v0.19.71.md").Path, [Text.Encoding]::UTF8)
    $draftPayload = @{
      tag_name='v0.19.71'
      name='pi-agent v0.19.71 更新'
      body=$notes
      draft=$true
      prerelease=$false
    } | ConvertTo-Json -Depth 5
    $release = Invoke-RestMethod -Method Patch `
      -Uri "https://api.github.com/repos/OWNER/REPO/releases/$($release.id)" `
      -Headers $headers `
      -ContentType 'application/json; charset=utf-8' `
      -Body ([Text.Encoding]::UTF8.GetBytes($draftPayload))
    if (-not $release.draft -or $release.tag_name -ne 'v0.19.71' -or $release.body.Trim() -ne $notes.Trim()) {
      throw 'Draft tag, state, or Chinese release body did not verify'
    }
    ```

    Re-read the authenticated releases collection after the patch and verify the same release ID, exact API `tag_name`, `draft=true`, correct localized body, and installer assets. **Do not require draft `html_url` or asset `browser_download_url` paths to contain the version tag.** GitHub commonly uses an `untagged-<id>` path for draft pages and assets even when the API `tag_name` is correct; this is normal while the release remains a draft. Publish when the API tag and all content checks pass, then verify that the public `/releases/tags/v<version>` endpoint returns `draft=false` and that its page and asset URLs resolve under the published tag. If the API `tag_name` itself is missing or wrong, keep the release as a draft, explicitly PATCH `tag_name`, and re-query it before proceeding; do not repeatedly PATCH solely to alter draft URLs.

    Only after all these checks pass, publish that same release ID:

    ```powershell
    $publishPayload = @{ tag_name='v0.19.71'; draft=$false; prerelease=$false; make_latest='true' } | ConvertTo-Json
    $published = Invoke-RestMethod -Method Patch `
      -Uri "https://api.github.com/repos/OWNER/REPO/releases/$($release.id)" `
      -Headers $headers `
      -ContentType 'application/json; charset=utf-8' `
      -Body ([Text.Encoding]::UTF8.GetBytes($publishPayload))
    $published | Select-Object tag_name,name,draft,prerelease,published_at,html_url
    ```

    Re-query the public endpoint after publication. Do not set `prerelease=$false` for a requested prerelease. If credentials or required assets are unavailable, leave the draft intact and clearly report that stable publication is not complete.

13. **Verify anonymously from the public endpoint and page.** After publishing:

    ```powershell
    $publicHeaders = @{ 'User-Agent'='PI-Desktop-public-verification'; 'Accept'='application/vnd.github+json' }
    $publicRelease = Invoke-RestMethod -Uri 'https://api.github.com/repos/OWNER/REPO/releases/tags/v0.19.71' -Headers $publicHeaders
    $publicRelease | Select-Object tag_name,name,draft,prerelease,published_at,html_url
    $publicRelease.assets | Select-Object name,size,browser_download_url
    ```

        Require HTTP success, `draft=false`, `prerelease=false` for a stable release, localized release body, and nonzero installer asset sizes. Open `https://github.com/OWNER/REPO/releases/tag/v<version>` in the browser and verify the title/body and downloadable assets are visible. The public Releases index should show the version as Latest when appropriate. If anonymous GitHub API requests are rate-limited, do not treat that as release failure: verify metadata and assets through the authenticated release-by-ID endpoint, then make anonymous HTTP requests to the public release page and representative installer URLs (follow redirects and require HTTP 200). Report which checks were performed; do not claim anonymous API verification if rate-limited.

## Pitfalls

- **Green Actions run but no public release:** electron-builder assets may have uploaded successfully to a draft. The public tag page can show only the two GitHub-generated source archives. Check the authenticated releases list for `draft=true`, inspect assets, then publish the draft. CI success is not publication verification.
- **Anonymous tag endpoint returns 404:** draft releases are hidden from unauthenticated release endpoints. Query the authenticated `/releases` collection and filter by exact `tag_name`; do not conclude that no package was built until checking the workflow and draft assets.
- **Installer assets missing:** inspect every platform job and its `electron-builder --publish always` step; verify `latest-mac.yml` merge separately. Do not publish until required platform installers are present.
- **Push failure to github.com:443:** this can be transient. Check `git ls-remote`, current commit and tag, then retry a normal push. Never force-update a release tag to get around an uncertain network result.
- **`gh` command unavailable:** use GitHub's public REST API for run status. For draft management, use an existing authorized Git Credential Manager credential only in memory; never print or store its token.
- **Unrelated dirty worktree:** stage explicit release paths only. Do not include user edits to README, root package metadata, scripts, or local `.pi` files unless they are explicitly part of the release request.
- **UTF-8/terminal warnings:** verify source and release body text themselves. LF/CRLF notices and ANSI colors are not Chinese mojibake. Avoid reconstructing Chinese from a garbled terminal rendering; re-read the UTF-8 file and check GitHub's rendered release body.
- **Incorrect release notes:** the GitHub draft body may not automatically use `release-notes/v<version>.md`. Explicitly set the body during publication and verify the rendered page.
- **Stable vs prerelease flags:** a numeric stable tag alone does not make the GitHub Release stable. Verify both `draft=false` and `prerelease=false` and ensure `make_latest` is set as intended.
- **Hosted arm64 runner capacity:** a workflow can spend a long time queued, then cancel the macOS arm64 job before any build step runs. Read the job annotation; `not acquired by Runner of type hosted` is runner capacity, not a source or signing failure. A rerun can be accepted yet remain queued or be cancelled again. Dispatch the existing workflow against the exact stable tag when appropriate, check the new run ID/attempt, and keep the draft private until arm64 packaging and macOS metadata merge succeed.
- **Wrong run monitored after recovery:** persist the new run ID immediately after `workflow_dispatch` or rerun. Filter by both exact tag ref and release commit SHA. A successful older tag run or partial platform job does not satisfy the latest recovery run.
- **PowerShell release body corruption:** do not assign a release-note file using a provider/command pipeline and assume it is a string. Use `[IO.File]::ReadAllText((Resolve-Path $path).Path, [Text.Encoding]::UTF8)` and submit `[Text.Encoding]::UTF8.GetBytes($json)` to the GitHub API. Verify the exact returned `body`; reject values containing serialized provider metadata such as `PSPath`.
- **Draft URL contains `untagged-*`:** this is expected for GitHub draft pages and asset download URLs, even when the authenticated release API correctly reports `tag_name=v<version>`. Do not block publication or repeatedly PATCH the draft solely because these URLs use `untagged-*`. Verify the exact API `tag_name`, draft/prerelease state, notes, non-empty required assets, and updater metadata; then publish the same release ID and verify the public `/releases/tags/v<version>` endpoint and downloadable assets. Only treat it as a tag problem if the API `tag_name` itself is wrong or missing; keep that draft private and repair/re-query the tag first.
- **Authenticated API list appears stale or release is absent:** assign the REST response to `$releases` before filtering, query that array, and use `Cache-Control: no-cache` or a cache-busting query parameter when checking immediately after upload/patch. Verify the returned release ID and assets rather than relying on release title alone.
- **Anonymous GitHub API rate limit:** a 403 rate-limit response does not mean publication failed. Use authenticated API to verify the same release ID, exact tag, `draft=false`, `prerelease` flag, localized body, and non-empty assets. Then verify the public release page and representative installer URLs anonymously (follow redirects; expect HTTP 200). State explicitly that the anonymous API check was rate-limited instead of claiming it passed.

## Verification

A release is complete only when all of the following are observed:

- Explicit-path commit and annotated stable tag are on the configured GitHub remote.
- The release workflow run has `status=completed`, `conclusion=success`, and the expected release SHA/ref. For a manual recovery run, `event=workflow_dispatch` is acceptable only when `head_branch` is the exact stable tag; every platform package job and the macOS metadata merge succeeded in that same run.
- Authenticated pre-publish inspection found the required installer assets and localized body in the exact tag's draft.
- Public verification confirms `draft=false`, the correct prerelease flag, localized Chinese notes, and non-empty installer assets. Prefer opening the public release page and verifying its rendered body/download links; if the browser is unavailable, record successful anonymous release-API verification and explicitly note that visual verification was not performed.
- The relevant test, typecheck, local Electron build, and `git diff --check` passed; unrelated worktree changes remain untouched.
