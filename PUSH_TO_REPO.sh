#!/usr/bin/env bash
# Prepare the REA bundle in a new feature branch; publishing is opt-in.
# Requires Bash (including Git Bash), Git and Node.js. No npm commands are run.
#
# Usage (run from any directory):
#   bash "/path/to/download/PUSH_TO_REPO.sh" [options]
#   bash "/path/to/repo/PUSH_TO_REPO.sh" --target "/path/to/clean/clone"
#
# Options:
#   --target DIR   Clone into DIR, or use an existing clean repository root.
#                  Default: a new temporary directory, retained after completion.
#   --repo URL     Clone URL; default is the public repository below.
#                  An existing target keeps its own origin (no remote changes).
#   --branch NAME  New feature branch (default: chore/rea-worker-bundle-TIME-PID).
#   --push         Commit only the managed files and push that feature branch.
#   -h, --help     Show usage.
#
# Keep this helper beside either the flat download's five other files:
#   rea-worker.yml, deploy.sh, validate-evidence.mjs, .env.example, package.json
# or the installed layout:
#   .github/workflows/rea-worker.yml, deployment/deploy.sh,
#   scripts/validate-evidence.mjs, .env.example, package.json
# A compatible package-lock.json in the installed source is reused if needed.
# Only npm scripts are merged; target package metadata/dependencies win.
# Installed bundles also carry their optional offline checks. Ignore rules for
# local secrets/artifacts are merged, never substituted for the target's rules.
# Existing compatible locks are retained. Missing/unsupported/mismatched locks
# require the printed npm install --package-lock-only --ignore-scripts command
# before committing; --push stops in that case. No lifecycle scripts are run.
# Default mode leaves changes unstaged and prints exact review/commit/push steps.
# It never commits/pushes main or master, force-pushes, deploys, or handles tokens.
set -euo pipefail

# Resolve this BEFORE changing cwd, including when invoked with a relative path.
SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_URL="https://github.com/sahiixx/sahiixx-rea-worker.git"
TARGET_DIR=""
BRANCH="chore/rea-worker-bundle-$(date -u +%Y%m%d%H%M%S)-$$"
PUSH=0
COMMIT_MESSAGE="ci: add REA workflow, deployment helper and evidence validation"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' \
    'Usage: bash PUSH_TO_REPO.sh [--target DIR] [--repo URL] [--branch NAME] [--push]' \
    'Default: prepare a retained local clone on a new feature branch; print publishing steps.' \
    '--target must be a clean repository root, an empty directory, or a new path.' \
    '--repo is used only when cloning; existing targets keep their origin.' \
    '--push explicitly enables a commit and a normal feature-branch push to origin.' \
    'Git and Node.js are required. See the script header for bundle/lockfile details.'
}
print_command() { printf '  '; printf '%q ' "$@"; printf '\n'; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target|--repo|--branch)
      [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 requires a value"
      case "$1" in
        --target) TARGET_DIR="$2" ;;
        --repo) REPO_URL="$2" ;;
        --branch) BRANCH="$2" ;;
      esac
      shift 2
      ;;
    --push) PUSH=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
done

command -v git >/dev/null 2>&1 || die 'Git is required.'
command -v node >/dev/null 2>&1 || die 'Node.js is required.'
case "$BRANCH" in main|master|-*) die 'Choose a new feature branch, not main/master.' ;; esac
git check-ref-format "refs/heads/$BRANCH" >/dev/null || die "Invalid branch: $BRANCH"

if [ -f "$SOURCE_DIR/.github/workflows/rea-worker.yml" ] &&
   [ -f "$SOURCE_DIR/deployment/deploy.sh" ] &&
   [ -f "$SOURCE_DIR/scripts/validate-evidence.mjs" ]; then
  SOURCE_FILES=(.github/workflows/rea-worker.yml deployment/deploy.sh scripts/validate-evidence.mjs .env.example)
elif [ -f "$SOURCE_DIR/rea-worker.yml" ] && [ -f "$SOURCE_DIR/deploy.sh" ] &&
     [ -f "$SOURCE_DIR/validate-evidence.mjs" ]; then
  SOURCE_FILES=(rea-worker.yml deploy.sh validate-evidence.mjs .env.example)
else
  die "Incomplete bundle in $SOURCE_DIR; expected the flat download or installed layout."
fi
for file in "${SOURCE_FILES[@]}" package.json PUSH_TO_REPO.sh; do
  [ -f "$SOURCE_DIR/$file" ] || die "Missing source file: $SOURCE_DIR/$file"
done

if [ -z "$TARGET_DIR" ]; then
  TARGET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rea-worker-prepare.XXXXXX")"
fi
if [ -d "$TARGET_DIR" ] &&
   [ "$(git -C "$TARGET_DIR" rev-parse --is-inside-work-tree 2>/dev/null || true)" = true ]; then
  [ -z "$(git -C "$TARGET_DIR" rev-parse --show-prefix)" ] || die '--target must be a repository root.'
else
  git clone -- "$REPO_URL" "$TARGET_DIR"
fi
cd -- "$TARGET_DIR"
TARGET_DIR="$(pwd -P)"
[ "$TARGET_DIR" != "$SOURCE_DIR" ] || die 'Source and target must be separate directories.'
[ -z "$(git status --porcelain --untracked-files=all)" ] || die 'Target has local changes; use a clean clone.'
git remote get-url origin >/dev/null || die 'Target must have an origin remote.'

DEFAULT_REF="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD || true)"
[ "origin/$BRANCH" != "$DEFAULT_REF" ] || die 'Cannot publish directly to the default branch.'
if git show-ref --verify --quiet "refs/heads/$BRANCH" ||
   git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  die "Branch already exists: $BRANCH; choose a new --branch."
fi

MANAGED_FILES=(.github/workflows/rea-worker.yml deployment/deploy.sh scripts/validate-evidence.mjs .env.example package.json PUSH_TO_REPO.sh package-lock.json .gitignore)
OPTIONAL_FILES=()
for file in scripts/deploy-script.check.mjs scripts/push-helper.check.mjs scripts/validate-evidence.check.mjs; do
  if [ -f "$SOURCE_DIR/$file" ]; then
    OPTIONAL_FILES+=("$file")
    MANAGED_FILES+=("$file")
  fi
done
# Refuse to overwrite ignored local files or follow target symlinks on copy/write.
[ -z "$(git ls-files --others --ignored --exclude-standard -- "${MANAGED_FILES[@]}")" ] ||
  die 'Target has ignored local files at bundle destinations; move them first.'
for file in .github .github/workflows deployment scripts "${MANAGED_FILES[@]}"; do
  [ ! -L "$file" ] || die "Target path is a symlink: $file"
done
if [ "$PUSH" -eq 1 ]; then
  git var GIT_AUTHOR_IDENT >/dev/null || die 'Configure your Git identity before using --push.'
  git var GIT_COMMITTER_IDENT >/dev/null || die 'Configure your Git identity before using --push.'
fi
git checkout -b "$BRANCH"

# Node edits JSON, never executes bundle/repository code. Script-only merges do
# not change dependency resolution. Never substitute a foreign dependency graph.
LOCK_STATUS="$(node - "$SOURCE_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const sourceDir = process.argv[2];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const read = file => {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!record(value)) throw new Error(`${file} must contain a JSON object`);
  return value;
};
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const dependencyMaps = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const resolutionFields = [...dependencyMaps, 'peerDependenciesMeta', 'overrides', 'workspaces', 'bundleDependencies', 'bundledDependencies'];
const compatible = (lock, pkg) =>
  [2, 3].includes(lock.lockfileVersion) && record(lock.packages) && record(lock.packages['']) &&
  dependencyMaps.every(key => same(lock.packages[''][key] || {}, pkg[key] || {}));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

try {
  const target = read('package.json');
  const bundle = read(path.join(sourceDir, 'package.json'));
  if (!record(bundle.scripts) || !Object.values(bundle.scripts).every(value => typeof value === 'string')) {
    throw new Error('Bundle package.json must have a scripts object containing strings');
  }
  if (target.scripts !== undefined && (!record(target.scripts) ||
      !Object.values(target.scripts).every(value => typeof value === 'string'))) {
    throw new Error('Target package.json has an invalid scripts object');
  }
  let ready = false;
  if (fs.existsSync('package-lock.json')) {
    // Existing dependency graph takes precedence; a scripts merge needs no rewrite.
    ready = compatible(read('package-lock.json'), target);
  } else {
    const sourceLock = path.join(sourceDir, 'package-lock.json');
    const sameResolution = resolutionFields.every(key => same(bundle[key], target[key]));
    // Workspace packages are not part of this six-file bundle.
    if (fs.existsSync(sourceLock) && sameResolution && !target.workspaces) {
      const lock = read(sourceLock);
      if (compatible(lock, target)) {
        for (const key of ['name', 'version']) {
          if (target[key] === undefined) {
            delete lock[key];
            delete lock.packages[''][key];
          } else {
            lock[key] = target[key];
            lock.packages[''][key] = target[key];
          }
        }
        write('package-lock.json', lock);
        ready = true;
      }
    }
  }
  target.scripts = { ...target.scripts, ...bundle.scripts };
  write('package.json', target);
  let ignore = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
  const eol = ignore.includes('\r\n') ? '\r\n' : '\n';
  const lines = new Set(ignore.split(/\r?\n/));
  const missing = ['.env', '.env.*', '!.env.example', '.dev.vars', '.dev.vars.*', 'artifacts/'].filter(rule => !lines.has(rule));
  if (missing.length) {
    if (ignore && !ignore.endsWith('\n')) ignore += eol;
    fs.writeFileSync('.gitignore', ignore + missing.join(eol) + eol);
  }
  process.stdout.write(ready ? 'ready' : 'needs-sync');
} catch (error) {
  console.error(`Cannot merge package files: ${error.message}`);
  process.exit(1);
}
NODE
)"

mkdir -p .github/workflows deployment scripts
for ((i = 0; i < ${#SOURCE_FILES[@]}; i++)); do
  cp -- "$SOURCE_DIR/${SOURCE_FILES[$i]}" "${MANAGED_FILES[$i]}"
done
cp -- "$SOURCE_DIR/PUSH_TO_REPO.sh" PUSH_TO_REPO.sh
for file in "${OPTIONAL_FILES[@]+"${OPTIONAL_FILES[@]}"}"; do
  cp -- "$SOURCE_DIR/$file" "$file"
done
chmod +x deployment/deploy.sh PUSH_TO_REPO.sh

printf '\nPrepared: %s\nFeature branch: %s\n' "$TARGET_DIR" "$BRANCH"
printf '\nReview and publish in Bash (including Git Bash):\n'
print_command cd -- "$TARGET_DIR"
if [ "$LOCK_STATUS" != ready ]; then
  printf '\nA compatible lockfile is required. Generate/sync it first (may access the npm registry):\n'
  print_command npm install --package-lock-only --package-lock=true --ignore-scripts --no-audit --no-fund
fi
print_command git status --short
# Explicit paths only; --force also allows .env.example when .env* is ignored.
print_command git add --force -- "${MANAGED_FILES[@]}"
print_command git update-index --chmod=+x -- deployment/deploy.sh PUSH_TO_REPO.sh
print_command git diff --cached --check
print_command git diff --cached
print_command git commit -m "$COMMIT_MESSAGE"
print_command git push --set-upstream origin "HEAD:refs/heads/$BRANCH"
printf 'Then open a pull request from %s into the repository default branch.\n' "$BRANCH"

if [ "$PUSH" -eq 0 ]; then
  printf '\nPreparation complete; changes are unstaged. Run the commands above after review.\n'
  exit 0
fi
[ "$LOCK_STATUS" = ready ] || die '--push stopped before staging/committing; complete the lockfile prerequisite and use the printed commands.'
git add --force -- "${MANAGED_FILES[@]}"
git update-index --chmod=+x -- deployment/deploy.sh PUSH_TO_REPO.sh
git diff --cached --check
if git diff --cached --quiet; then
  printf '\nNo changes to commit or push.\n'
  exit 0
fi
git commit -m "$COMMIT_MESSAGE"
git push --set-upstream origin "HEAD:refs/heads/$BRANCH"
printf '\nPublished feature branch: %s\n' "$BRANCH"
