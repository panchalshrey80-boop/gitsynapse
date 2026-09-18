/**
 * Working-tree noise.
 *
 * `git status --untracked-files=all` lists every file git does not know about,
 * which in a real directory means hundreds of rows of things the user never
 * intends to commit: Python bytecode, Windows shortcut files, macOS metadata.
 * A `__pycache__` directory alone can push forty entries into the panel and
 * bury the two files that matter, and the same junk is fed to the copilot as
 * repository context.
 *
 * Those paths are therefore classified here and filtered out of the file list.
 * Two rules keep the filtering honest:
 *
 *   1. Only *untracked* files are ever hidden. A file that is tracked, or that
 *      the user explicitly staged, always shows — hiding something the user
 *      already acted on would be a lie.
 *   2. Nothing is hidden without a visible trace: the status carries the count
 *      and the paths, the Changes view shows a row offering to ignore them
 *      permanently, and one click writes the patterns to `.gitignore` so git
 *      itself stops reporting them.
 *
 * @typedef {object} JunkRule
 * @property {string} label   Full name, used in tooltips.
 * @property {string} short   Short name, used in the narrow sidebar row.
 * @property {string[]} ignore Lines to write to .gitignore.
 * @property {(path:string, segments:string[])=>boolean} match
 */

/** @type {JunkRule[]} */
export const JUNK_RULES = [
  {
    label: 'Python bytecode',
    short: 'bytecode',
    ignore: ['__pycache__/', '*.py[cod]'],
    match: (filePath, segments) => segments.includes('__pycache__')
      || /\.py[cod]$/i.test(filePath),
  },
  {
    label: 'Windows shortcuts',
    short: 'shortcuts',
    ignore: ['*.lnk'],
    match: (filePath) => /\.lnk$/i.test(filePath),
  },
  {
    label: 'Windows metadata',
    short: 'OS files',
    ignore: ['Thumbs.db', 'ehthumbs.db', 'desktop.ini', '$RECYCLE.BIN/'],
    match: (filePath, segments) => /^(thumbs\.db|ehthumbs\.db|desktop\.ini)$/i.test(filePath)
      || segments.includes('$RECYCLE.BIN'),
  },
  {
    label: 'macOS metadata',
    short: 'mac files',
    ignore: ['.DS_Store', '._*', '.Spotlight-V100/', '.Trashes/'],
    match: (filePath, segments) => filePath === '.DS_Store'
      || filePath.startsWith('._')
      || segments.includes('.Spotlight-V100')
      || segments.includes('.Trashes'),
  },
  {
    label: 'editor swap files',
    short: 'swap files',
    ignore: ['*.swp', '*.swo', '*~'],
    match: (filePath) => /\.sw[po]$/.test(filePath) || filePath.endsWith('~'),
  },
];

/**
 * Every gitignore line GitSynapse may write, in a stable order.
 * @type {string[]}
 */
export const JUNK_IGNORE_LINES = JUNK_RULES.flatMap((rule) => rule.ignore);

/**
 * Matches a path against the junk rules.
 *
 * @param {string} filePath Repository-relative, forward slashes.
 * @returns {JunkRule|null}
 */
export function classifyJunk(filePath) {
  const normalised = String(filePath || '').replace(/\\/g, '/');
  if (!normalised) return null;
  const segments = normalised.split('/');
  const name = segments[segments.length - 1];

  for (const rule of JUNK_RULES) {
    if (rule.match(name, segments)) return rule;
  }
  return null;
}

/**
 * Splits a status file list into what the user should see and what is noise.
 *
 * @param {Array<{path:string, staged?:boolean, untracked?:boolean, conflicted?:boolean}>} files
 * @returns {{visible:any[], noise:Array<{path:string, label:string}>}}
 */
export function partitionJunk(files) {
  const visible = [];
  const noise = [];

  for (const file of files) {
    // Tracked and staged files are never hidden: the user has already made a
    // decision about them, and a commit must show what it will contain.
    const hideable = file.untracked && !file.staged && !file.conflicted;
    const rule = hideable ? classifyJunk(file.path) : null;

    if (rule) noise.push({ path: file.path, label: rule.label, short: rule.short });
    else visible.push(file);
  }

  return { visible, noise };
}

/**
 * Builds the ignore lines for the junk actually present, so a click does not
 * litter `.gitignore` with rules for file types the project never produces.
 *
 * @param {Array<{path:string}>} noise
 * @returns {string[]}
 */
export function ignoreLinesFor(noise) {
  const lines = new Set();
  for (const entry of noise) {
    const rule = classifyJunk(entry.path);
    for (const line of rule?.ignore || []) lines.add(line);
  }
  return [...lines];
}
