// Strict command-line parsing: unknown options, missing values and stray arguments are errors.
// Silent acceptance cost real runs: `--run 3` ran 200 battles, and PowerShell splits `a=1,2,3` on the commas.

export type OptKind = 'value' | 'flag' | 'multi';
export type Opts = Record<string, string[]>;

export function parseArgs(cmd: string, argv: string[], spec: Record<string, OptKind>, positionals: number): { pos: string[]; opt: Opts } {
  const pos: string[] = [];
  const opt: Opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    const kind = spec[key];
    if (!kind) throw new Error(`${cmd}: unknown option --${key}. Options: ${Object.keys(spec).map((k) => '--' + k).join(', ')}`);
    if (kind === 'flag') {
      opt[key] = ['true'];
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) throw new Error(`${cmd}: option --${key} needs a value`);
    i++;
    if (kind === 'value' && opt[key]) throw new Error(`${cmd}: option --${key} given twice`);
    (opt[key] ??= []).push(val);
  }
  if (pos.length > positionals) {
    const extra = pos.slice(positionals).join(' ');
    throw new Error(`${cmd}: unexpected argument${pos.length - positionals > 1 ? 's' : ''} '${extra}'. If this was a comma list such as a=1,2,3 typed in PowerShell, put the whole parameter in single quotes: --param 'data:path=1,2,3'`);
  }
  return { pos, opt };
}

export function intOpt(opt: Opts, key: string, fallback: number, min: number): number {
  const raw = opt[key]?.[0];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${key} must be a whole number of at least ${min}, not '${raw}'`);
  return n;
}
