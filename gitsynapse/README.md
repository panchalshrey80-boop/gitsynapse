# GitSynapse

A desktop Git client with an AI copilot, built for people who have just started
using Git and cannot remember the commands.

It drives the `git` already installed on your machine — no bundled git, no
shadow index, no proprietary repository format. Whatever GitSynapse does, you can
repeat in Git Bash and get the same result. Every command it runs is shown to
you before it runs, and shown again in the output afterwards.

---

## What it does

**Works without any AI at all.** Staging, committing, diffing, branching,
merging, stashing, tagging, fetching, pulling, pushing, conflict resolution, and
a real commit graph. The AI layer sits on top; it is not a dependency.

**The copilot turns intent into commands.** Describe the outcome — *"undo my
last commit but keep the changes"* — and it answers with a short explanation
plus the exact commands required, each one labelled with what it will do to your
repository. Nothing executes until you approve it.

**Safety is enforced by the app, not requested politely from the model.** See
[Trust model](#trust-model) below.

---

## Quick start

Requires **Node.js 18.17+** and **Git** on your `PATH`.

```bash
cd gitsynapse
npm install
npm start
```

Then open the address it prints (default `http://127.0.0.1:4173`).

To use the copilot: click the gear icon, choose a provider, paste that provider's
API key, press **Test connection**, pick a model, and save. One key per provider
is kept, so switching back and forth does not mean re-pasting anything.

| Provider | Get a key | Default model | Wire format |
| --- | --- | --- | --- |
| **Mesh** *(default)* | [meshapi.ai](https://www.meshapi.ai/) — `rsk_…` | `openai/gpt-4o-mini` | OpenAI-compatible |
| **OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) — `sk-or-…` | `anthropic/claude-sonnet-5` | OpenAI-compatible |
| **OpenAI** | [platform.openai.com](https://platform.openai.com/api-keys) — `sk-…` | `gpt-4o-mini` | OpenAI-compatible |
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com/settings/keys) — `sk-ant-…` | `claude-sonnet-5` | Messages API |
| **Groq** | [console.groq.com/keys](https://console.groq.com/keys) — `gsk_…` | `openai/gpt-oss-120b` | OpenAI-compatible |

Model ids are vendor-specific, and the **Load models** button lists what your key
can actually reach — which is what to trust when a default has moved on. Every
key is encrypted on disk with AES-256-GCM, is never returned to the browser, and
is sent only to the provider it belongs to.

### Desktop app

```bash
npm run app        # runs in Electron
```

---

### Upgrading from 0.x (when this was GitDesk)

The app was renamed for 1.0.0. Nothing is lost in the move:

- **Settings and your API key** are copied once from the old location
  (`%APPDATA%\GitDesk\config` on Windows, `~/.gitdesk` elsewhere) into the new
  one, the first time the app starts and only if the new location is empty. The
  machine key travels with the settings — the saved API key is encrypted with
  it, so copying the config alone would leave a key that could not be read.
- **Environment variables** are read under both names. `GITSYNAPSE_*` is
  preferred; `GITDESK_*` still works, so scripts that set `GITDESK_PORT` or
  `GITDESK_CONFIG_DIR` keep working unchanged.
- **A key saved before providers existed belongs to Mesh**, which was the only
  option then. It is picked up as the Mesh key rather than appearing to vanish,
  and it now lives alongside per-provider keys for the other four.
- **A pre-1.0 settings file is upgraded in memory** on read — including the
  change from a single cached model list to one per provider — so the file stays
  readable by an older build if you go back.

---

## The Windows installer

`release/GitSynapse-setup.exe` — a single-file NSIS installer.

| | |
| --- | --- |
| Size | 71.5 MB (233 MB installed) |
| Installs to | `%LOCALAPPDATA%\Programs\GitSynapse` by default |
| Admin rights | **Not required.** `RequestExecutionLevel highest` stays unelevated for standard accounts and elevates only if the account can, so an administrator may also choose a machine-wide folder |
| Removes | Uninstaller + Add/Remove Programs entry; asks before deleting your settings, API key and chat history from `%APPDATA%\GitSynapse` |
| Requires | Git on your `PATH` ([git-scm.com](https://git-scm.com)) — the installer warns if it is missing |

It ships a single locale (`en-US`) and only the files the app needs, which is why
it is 71 MB rather than the ~110 MB an untuned Electron build produces.

### Building it yourself

```bash
npm install
npm run build:icons     # renders assets/icon.png and icon.ico from vector source
npm run dist:win        # -> release/GitSynapse-setup.exe
```

`npm run dist:win` works on **Windows, Linux and macOS** and needs no Wine:

1. `electron-builder --win --x64 --dir` produces the unpacked app — pure Node.
2. `scripts/brand-exe.cjs` applies the icon and version metadata with `resedit`,
   a pure-JavaScript PE resource editor. electron-builder normally does this by
   shelling out to `rcedit` through Wine, which cannot work without root.
3. `scripts/build-windows.js` wraps the result with `makensis`.

Step 3 needs NSIS. On Windows electron-builder provides it. Elsewhere the build
script fetches electron-builder's own copy automatically (`apt install nsis` or
`brew install makensis` also works).

**Verify what you built** before trusting it — 7-Zip can read NSIS archives:

```bash
7z t release/GitSynapse-setup.exe    # -> "Everything is Ok", 22 files
7z l release/GitSynapse-setup.exe    # lists GitSynapse.exe, resources/app.asar, ...
```

### Collapsing the side panels

Both panels collapse independently, so the space goes to whatever you are
reading. `Ctrl+B` hides the copilot; `Ctrl+\` hides the sidebar. The toolbar
toggle sits at the far left of the top bar rather than inside the sidebar, so it
stays on screen while the sidebar is hidden — there is no state you cannot get
back from, and no second floating button to hunt for.

Closing both is the useful case: the Changes view goes back to a side-by-side
list and diff at 1024px, where an open panel would otherwise force them to
stack. Because the two widths are set through `--col-sidebar` and `--col-copilot`,
the responsive breakpoints only restate widths rather than every combination of
collapsed panels — one rule instead of four.

---

## How the copilot is wired

```
You type  ──▶  GitSynapse server  ──▶  your provider (Mesh/OpenRouter/
                     │                    OpenAI/Anthropic/Groq)
                     │                    │
                     │  repo context      │  prose + ```gitplan JSON
                     │◀───────────────────┘
                     ▼
        safety classification (server-side)
                     ▼
        you approve ──▶ git runs ──▶ output shown in the chat
```

The model returns two things: a short markdown explanation, which streams into
the chat token by token, and a fenced `gitplan` block containing strict JSON —
one entry per command, as an **argument array**, never a shell string.

```json
{
  "summary": "Stage the stylesheet and commit it",
  "steps": [
    { "args": ["add", "--", "app.css"], "why": "Stage the new file", "risk": "safe" },
    { "args": ["commit", "-m", "Add stylesheet"], "why": "Record the change", "risk": "writes" }
  ]
}
```

### When the copilot goes wrong

Three failure modes are handled explicitly, because a chat panel that simply
stops is indistinguishable from a broken app.

**A command that never finishes.** Every git process is bounded by a timeout
chosen from a policy in `src/server/git/command.js` — 30s for the reads the UI
blocks on, 60s for ordinary writes, 5 minutes for anything that talks to a
remote, 10 for a first clone. The deadline is not the whole story: a killed
`git` can leave a child (ssh, a credential helper, a pager) holding the output
pipes open, and in that case the process `close` event never arrives. A grace
timer settles the call anyway and reports a timeout, so the request always
returns.

**A prompt that cannot be answered.** stdin is `/dev/null`, so a command that
decides to ask a question gets EOF instead of blocking forever. `GIT_TERMINAL_PROMPT=0`
and `SSH_ASKPASS_REQUIRE=never` refuse credential prompts outright, which is why
a missing password produces an explanatory error rather than a frozen window.

**A stream that stops mid-answer.** The renderer arms two watchdogs — 70s of
silence, 5 minutes total — and the server sends a terminal event on every path.
If a reply still ends without a conclusion (a dropped socket, a restarted
server), the turn is closed with a visible banner instead of a blinking caret.

Transient upstream failures (429, 5xx, a dropped connection) are retried once,
but only when nothing has been rendered yet — repeating a half-finished answer
would append a second one to it. Outbound text is scrubbed of lone surrogates
and control characters, which is the usual reason a request that worked once
starts failing with HTTP 400 forever after.

---

## Working-tree noise

`git status --untracked-files=all` reports everything git does not know about,
which in a real project means `__pycache__`, `*.pyc`, `*.lnk`, `.DS_Store` and
editor swap files. GitSynapse keeps those out of the file list, and three rules
keep that honest:

- Only **untracked** files are filtered. A tracked or deliberately staged file
  is always shown, whatever it is named — hiding something the user already
  acted on would silently change what a commit contains.
- Nothing is hidden silently. The Changes view ends with a row reading
  `3 hidden · mac files, bytecode, shortcuts`; hovering it lists the exact
  paths.
- One click on **Add ignores** writes the standard patterns to `.gitignore`, so
  git itself stops reporting them. The pattern list lives on the server, so a
  request cannot inject arbitrary lines. `.gitignore` is left as a normal
  working-tree change for you to review and commit.

The copilot is told how many files were filtered and is instructed to offer to
ignore them rather than propose deleting them.

---

## Trust model

This is the part that matters, because a tool that runs commands in your repo
earns its trust or it does not.

**1. Arguments, never shell strings.** Every command runs through
`spawn(binary, argv, { shell: false })`. There is no string concatenation
anywhere on the path from your typing to the process, so quoting and injection
problems cannot arise.

**2. The server decides the risk, not the model.** The model's own `risk` label
is recorded but never trusted. `src/server/ai/safety.js` classifies the argument
vector independently, and the stricter of the two wins. A model that labels
`reset --hard` as "safe" changes nothing.

**3. Shell escape hatches are hard-blocked.** These are not risky Git — they are
ways to execute arbitrary programs through Git, so they are refused outright:

| Blocked | Why |
| --- | --- |
| `-c alias.x=!cmd` | Runs a shell command |
| `--exec-path`, `--upload-pack`, `--receive-pack` | Loads an arbitrary binary |
| `--ext-diff` | Runs an external diff program |
| `--config-env`, `git config` without `--local` | Environment/config injection |
| `--git-dir`, `--work-tree` | Retargets Git at another repository |
| `rebase --exec` | Runs a command per commit |
| `filter-branch`, `filter-repo`, `daemon`, `credential`, `send-email` | Out of scope by design |

**4. Destructive commands need a specific, deliberate approval.** `reset
--hard`, `clean -f`, `push --force`, `branch -D`, `stash drop` and friends
require a separate flag that the UI sets only after a dialog named the exact
command. Approving a plan does not silently approve a history rewrite inside it.

**5. Inputs that Git would read as flags are rejected.** A branch name cannot
start with `-`; paths are resolved and refused if they escape the repository
root; branch names are validated through `git check-ref-format` itself.

**6. The local server refuses to talk to strangers.** It binds to `127.0.0.1`
and validates `Host` and `Origin` on every request, which closes the
DNS-rebinding hole a bare loopback bind leaves open. State-changing requests
must be JSON, which removes the form-POST CSRF vector.

**7. Your API key never enters the page.** It is stored encrypted server-side
and returned to the renderer only as a mask. If it is never in the DOM, it
cannot leak through a screenshot or a renderer bug.

**8. Git runs with no stdin and a deadline.** Every process gets
`stdio: ['ignore', 'pipe', 'pipe']` and a timeout from the policy in
`command.js`; on Windows a timeout kills the whole process tree with
`taskkill /T`. See [When the copilot goes wrong](#when-the-copilot-goes-wrong).

**9. Git cannot hang waiting for a password.** `GIT_TERMINAL_PROMPT=0` is forced,
so a missing credential produces an error explaining how to fix it rather than a
process that never returns.

---

## Testing

Two suites, both runnable offline. Together they cover the parts of this app
that can damage a repository.

```bash
npm test            # both suites
npm run test:api    # 77 checks: classification, parsing, process runner, HTTP, safety, AI, providers
npm run test:ui     # 90 checks: real browser, real UI, real repository
```

`npm run test:api` builds a throwaway repository, starts the real server against
it, and stands up **three mock providers**: an OpenAI-compatible endpoint, a
second one mounted under `/openai/v1` (the path Groq uses), and an Anthropic
Messages endpoint that streams `content_block_delta` frames. The entire copilot
path — streaming, plan extraction, risk override, executor gating, per-provider
keys, model lists and the error mapping for a rejected key — is exercised
without spending API credit or needing a key.

The mocks assert on the wire format, not just the outcome: that Anthropic is
sent `x-api-key` and a top-level `system` with no `Authorization: Bearer`, that
its message roles strictly alternate, that `max_tokens` is present, and that a
provider's base URL override never leaks onto another provider.

`npm run test:ui` drives the actual interface in headless Chrome: it clicks
through staging, committing, the diff pane, the history graph, the branch list
and the settings dialog, and fails on any console error or uncaught exception.
It also writes screenshots to `screenshots/`.

`npm run shots` renders the copilot-with-plan and approval-sheet screens, which
need a streaming response the main suite cannot produce on its own.

`npm run tour` rebuilds `ui-preview.html`, the standalone interface tour. It
reads the product name and version from `package.json` and the provider table
from the provider registry, so the tour cannot advertise a name, a version or a
model the app does not ship. The screenshots are re-encoded to JPEG through
headless Chrome, which keeps the whole tour a single file that opens offline.

### What the tests caught

These were real defects found by the suites during development, not hypotheticals:

- `git stash list` was given `for-each-ref` placeholder syntax (`%(objectname)`)
  instead of log formatting (`%h`, `%gd`), so the stash list rendered a literal
  format string.
- `[hidden]` was overridden by component `display` rules, leaving an invisible
  modal scrim covering the entire window on first launch.
- `api.remotes()` returned `{ remotes: [...] }` while every caller expected an
  array, which broke the Branches view with an uncaught exception.
- Toasts sat over the send button and, because they captured pointer events,
  intermittently **swallowed clicks** on it.
- `Element.append(null)` inserted the literal text `null` under each copilot
  step.
- `git show` prints no file list for a merge commit, so merging showed "0 files
  changed"; now `-m --first-parent` is used and the merge is labelled.
- Blanket approval of a plan bypassed the destructive-command gate entirely
  (`confirmed: true` short-circuited it). The gate is now a separate flag.
- A killed git process whose grandchild kept the output pipes open **never
  settled**; the promise hung for the orphan's full 30s lifetime. The test
  measures it: 30,007ms without the grace timer, 6s with it.
- `git commit -m` was shown without quotes, so the command the Copy button
  handed over would not have worked when pasted into a shell.
- A CSS class with no matching rule rendered three quick-prompt chips as one
  unseparated sentence; the suite now fails when any class in the DOM is
  unstyled.
- A copilot reply that contained no plan lost its **last eight characters** on
  screen: the parser holds back a tail while it checks for a fence, and the
  held-back prose was only ever delivered inside the plan event. The transcript
  had the full text, which is exactly why it went unnoticed.
- Switching provider in the settings dialog kept the previous vendor's model id,
  so the first message after the switch would have 404'd. The default now
  follows the provider, while an id you typed yourself is left alone.
- Upgrading from a pre-1.0 config file kept the old `modelsCache` array where the
  new code expects a map, silently breaking the cached model list per provider.
  The load path now normalises the old shape in memory.
- The config-directory migration copied a developer's real settings (and last
  opened repository) into isolated test sandboxes, which is how the suite found
  it: a "fresh install" opened a repository nobody asked for. Migration now
  happens only at the app's own default location, or when Electron names the
  legacy folder outright.

---

## Project layout

```
src/server/
  index.js              Express app, static hosting, error handling
  guard.js              Host/Origin validation, rate limiting
  store.js              Encrypted settings, chat history
  ai/safety.js          Independent risk classification and the blocklist
  ai/text.js            Outbound text hygiene: surrogates, control characters
  ai/agent.js           System prompt, repo context, streaming plan extractor
  ai/providers.js       Provider registry: endpoints, defaults, wire protocols
  ai/client.js          HTTP client for both protocols (SSE, deadlines, retries)
  env.js                Environment and config-directory conventions
  git/command.js        Command rendering (shell-safe quoting) and timeout policy
  git/runner.js         spawn wrapper: no stdin, deadlines, tree kill, output caps
  git/junk.js           Build/OS noise classification and ignore patterns
  git/porcelain.js      Parsers for --porcelain and --format output
  git/repository.js     Read-only repository queries
  git/actions.js        Validated write operations
  git/executor.js       The choke point every AI command passes through
  routes/               HTTP surface (repo, actions, ai, system)

src/renderer/           No build step, no framework: ES modules + CSS
  css/                  Design tokens, layout, components, diff, chat
  js/api.js             Typed client for the local server
  js/chat.js            Copilot panel, plan cards, approval sheets
  js/views/             Changes, History, Branches/Remotes/Stashes/Tags, Picker

electron/               Desktop shell: window, native folder picker, packaging
scripts/                Test suites, icon generator, build, chrome-libs.sh
```

## Keyboard shortcuts

| | |
| --- | --- |
| `Ctrl+O` | Open a repository |
| `Ctrl+1…5` | Changes · History · Branches · Stashes · Tags |
| `Ctrl+B` | Show/hide the copilot |
| `Ctrl+\` | Show/hide the sidebar |
| `Ctrl+P` | Push |
| `Ctrl+,` | Settings |
| `/` | Focus the copilot input |
| `R` | Refresh |
| `Esc` | Stop a streaming reply, or close a dialog |

## Limits worth knowing

- **Merge conflicts** are resolved per file by choosing a side or marking a
  file resolved. There is no hunk-level conflict editor yet.
- **Credentials** are handled by Git itself. GitSynapse runs non-interactively, so
  install Git Credential Manager or use an SSH key; a missing credential
  produces an explanatory error, not a password prompt.
- **GitSynapse runs git, not your shell.** If the copilot answers "remove the
  cache directory" with `rm -rf __pycache__` or `del /s /q __pycache__`, that
  step is refused with the reason and a better alternative. `rm` is a real git
  subcommand, so `git rm <path>` still works on tracked files (it is
  `destructive`, and deletes from the working tree); `del`, `rmdir`, `mkdir`,
  `cd`, `mv`, `powershell` and the rest are not git commands and cannot run.
- **History rewriting** commands (`rebase -i`, `commit --amend` beyond the last
  commit) are deliberately narrow.
- **One API key per provider, and that is the ceiling.** There is no keychain
  integration, no OAuth flow, and no proxy: the key is encrypted with AES-256-GCM
  under a per-installation secret in your user folder. Someone who can already
  read that folder can read the key, which is the same trust boundary as a
  `.git-credentials` file.
- **Only the five providers in the table are built in.** They cover both wire
  formats in use, so another OpenAI-compatible endpoint usually works by setting
  a base URL override — but only through the API, not the settings dialog, which
  offers the built-in list.
- **The AI sees metadata, not your code**, unless you ask for a commit message
  or an explanation — then the diff is sent to your configured provider,
  truncated to 14 KB.
- **The Windows build is not code-signed.** Windows SmartScreen will show a
  "Windows protected your PC" warning on first run; choose *More info* →
  *Run anyway*. Signing requires a paid certificate. The SHA-256 of the built
  installer is written to `release/GitSynapse-setup.exe.sha256` so you can verify
  the download independently.
