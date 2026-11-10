# Napoleonic battalion-level battle simulator

Set up a battle, run it many times, and read the distribution of outcomes. A
simulation tool first and a game second.

- `DESIGN.md`: the plan as agreed.
- `MODEL.md`: every rule and formula in plain language, with what is known to be implausible.
- `CALIBRATION.md`: d'Erlon's attack at Waterloo run through the model, compared with the event.

## Quick start

Needs Node 22 or later (tested on 22 and 26).

```
npm install
npm test                                              # engine tests
npm run napsim -- run scenarios/pitched.json --seed 1 --log
npm run napsim -- batch scenarios/pitched.json --runs 500 --out out/pitched
npm run ui                                            # replay viewer, live runs, editor
```

## Command line

```
napsim run <scenario.json> [--seed N] [--set path=value ...] [--log] [--json] [--out result.json] [--replay out.json]
napsim batch <scenario.json> [--runs N] [--seed0 N] [--out dir] [--jobs N] [--set path=value ...]
napsim sweep <scenario.json> --param path=v1,v2,... [--param ...] [--runs N] [--out dir]
napsim params [--confidence assumption] [--csv] [--out file]
napsim verify <replay.json>
```

(`napsim` here means `npm run napsim --`.)

- **run** plays one battle. `--log` prints the event log, `--replay` records a file the UI can load.
- **batch** runs N seeds in parallel and prints win rates with 95% intervals, loss
  distributions, duration, and when and where each side broke. With `--out` it writes:
  - `runs.csv`: one row per run.
  - `routs.csv`: one row per rout, with position and cause.
  - `units.csv`: one row per unit per run, with its losses.
  - `summary.csv`, `summary.json`: one row per sweep point.
- **sweep** does the same at every combination of the given values, on the same seeds,
  so differences between points are not noise from different battles.
- **params** lists every coefficient with its unit, source and confidence.
  `--confidence assumption` shows only the guesses.
- **verify** re-runs a replay and checks that its result, unit tracks and events all
  reproduce exactly.

Unknown options, stray arguments and mistyped parameter paths are errors, not ignored.

Paths for `--param` and `--set` start with `data:` or `scenario:`. Array elements can
be addressed by index or by `id`:

```
--param 'data:morale.casualtyShock=1,2,3'
--param 'data:weapons.guns.field_8pdr.canisterBattlefieldFactor=0.025,0.05,0.1'
--param 'scenario:sides.french.deploy.cav=0..8..2'
--param 'scenario:features.smoke=false,true'
--set   scenario:features.weatherGround=true --set scenario:weather.ground=mud
```

A feature's settings do nothing unless the feature is on: the last line switches on
weather and ground as well as choosing mud.

### On Windows

- Keep the single quotes around `--param` values. PowerShell splits an unquoted
  `a=1,2,3` on the commas before the program sees it.
- If `npm run napsim -- ...` loses its arguments, call the program directly:
  `npx tsx packages/cli/src/main.ts batch scenarios/pitched.json --runs 200`.
- If PowerShell says running scripts is disabled, use `npm.cmd` and `npx.cmd`.
- Write files with `--out`, not `>`: Windows PowerShell re-encodes redirected output,
  which mangles the accented names. The CSV files are UTF-8; Excel needs to be told so
  on import.

## Scenarios

| File | What it is |
|---|---|
| `pitched`, `column`, `squares`, `battery`, `counter` | The prototype's five presets at real scale |
| `pitched-orders` | The pitched battle run from written orders through a chain of command |
| `reverse-slope` | Defenders drawn back behind the crest; for comparing runs with and without line of sight |
| `derlon` | The centre of d'Erlon's attack at Waterloo, all features on |
| `derlon-ordinary-columns` | The same with the French in ordinary battalion columns, as a counterfactual |

Every scenario runs unattended from its written orders. Deeper-model features are
switched per scenario in its `features` block: `commandControl`, `fatigue`,
`ammunition`, `skirmishers`, `quality`, `elevationLos`, `smoke`, `weatherGround`.

`tools/gen-presets.mjs` and `tools/gen-derlon.mjs` regenerate the scenario files.
`tools/prototype-baseline.mjs` runs the original prototype headless for comparison.
`tools/derlon-report.mjs <out dir>` breaks a d'Erlon batch down by formation.
`tools/rerun-documented-numbers.sh` re-runs every batch quoted in `MODEL.md` and
`CALIBRATION.md`; run it after changing the engine or the data.

## Interface

`npm run ui` opens three tabs:

- **Replay**: load a recorded run (or record one in the page), scrub it, and click a
  unit to see its history and the chain of morale events behind its rout.
- **Live run**: run a scenario in the browser. You may give orders, and they are
  recorded, but nothing needs you to.
- **Editor**: place units, draw terrain, build the chain of command, write orders,
  save and load scenario JSON, and test-run the result.

## Layout

```
data/                 every coefficient, as JSON with unit, source, confidence and note
scenarios/            scenario files
packages/engine/      the simulation: pure TypeScript, no dependencies, no DOM, deterministic
packages/cli/         run, batch, sweep, params, verify
packages/ui/          canvas interface
prototype/            the original single-file prototype
tools/                scenario generators and reports
```

## Reading the numbers

The sources behind the data files were checked only through web-search summaries of
secondary pages; no original text was read, and `data/sources.json` says so against
each work. Each parameter says how far it can be
trusted: `sourced`, `secondary`, `recalled` (from memory), `derived`, `prototype` or
`assumption`. Most morale and command coefficients are assumptions. `MODEL.md`
section 11 lists what the sweeps show to be most influential and what still looks wrong.
