# Napoleonic battalion-level battle simulator — design

Status: **draft for review.** No engine code exists yet. Nothing below is built.

This document covers the model, the data schemas, the sources, and the phased plan.
Section 10 lists the decisions I need from you before Phase 1 starts.

---

## 1. What this is

A tool for setting up a battalion-level action, running it hundreds of times, and
reading the distribution of outcomes. It answers questions like "how often does this
attack succeed, and what changes if the defender has two more squadrons?" Playing it
is possible but secondary.

Three consequences shape everything else:

- **Reproducibility comes first.** Same scenario, same data, same seed gives the same
  result on any machine, in Node or in a browser.
- **Every number is inspectable.** Coefficients live in JSON with a unit, a source and
  a note. The sweep tool can vary any of them by path.
- **Every outcome is explainable.** The engine logs why morale changed, not only that
  it did, so a rout can be traced back through the events that caused it.

### Starting point

`prototype/index.html` is not in the repository (the repo was empty when I started).
Phase 1 therefore rebuilds the baseline from the rule list in the brief. If you have
the prototype, commit it to `prototype/index.html` and I will port its rules and
numbers instead of re-deriving them, and note every place the new engine departs.

### Not modelled

Individual companies or men, supply beyond ammunition, engineering and fieldworks
beyond a "walled farm" terrain type, night, multi-day actions, prisoners' escorts,
and anything above a single corps-sized action.

---

## 2. Architecture

```
napoleon/
  DESIGN.md  MODEL.md  CALIBRATION.md
  data/                 # tunable numbers, all JSON (section 4)
  scenarios/            # scenario JSON
  packages/
    engine/             # pure TypeScript, zero runtime dependencies, no DOM, no Node APIs
    cli/                # Node: run, batch, sweep, replay export
    ui/                 # browser: canvas map, replay viewer, live run, editor
```

npm workspaces, TypeScript in strict mode, Vitest for tests, Vite for the UI. The UI
uses plain TypeScript and canvas with no framework. The engine imports nothing; the
CLI and UI import the engine.

### Engine API (sketch)

```ts
const sim = createSim(scenario, data, seed);   // validates, builds initial state
sim.step();                                    // advance one fixed tick
sim.state;                                     // plain serialisable data
sim.drainEvents();                             // events emitted since last drain
sim.issueOrder(order);                         // optional outside input, timestamped
const result = runToEnd(sim, { maxTime });     // headless convenience
const replay = record(scenario, data, seed);   // run with a recorder attached
```

State is plain data (no classes, no closures), so it can be snapshotted, hashed and
restored.

### Determinism rules

- Fixed timestep of 1 s of simulated time. Slower subsystems run on fixed multiples
  of it (unit decisions every 10 s, staggered by unit index; smoke every 5 s).
- No `Math.random`, `Date`, or wall-clock anywhere in the engine. A lint rule enforces it.
- **Counter-based random numbers.** Each draw is a hash of
  `(seed, stream, entity id, tick)` using 32-bit integer arithmetic. Because a draw
  does not depend on how many draws came before it, switching a feature on does not
  shift the random numbers used by unrelated subsystems. This gives paired
  comparisons across toggles and sweep points (the same seed is "the same battle"
  as far as possible), which cuts the number of runs needed to see an effect.
- Only `+ - * /` and `Math.sqrt` on floats, which IEEE 754 defines exactly.
  `sin`, `cos` and `atan2` differ between JavaScript engines in the last bit, so the
  engine carries its own implementations.
- Units are processed in id order. Fire and morale effects are computed from the
  state at the start of the tick and applied together, so iteration order cannot
  favour one side.

### Tick order

1. Weather, smoke drift and decay
2. Command: couriers move, orders arrive, commanders decide
3. Unit decisions (staggered)
4. Formation changes progress
5. Movement and collision
6. Fire
7. Charges and melee
8. Morale: apply accumulated shocks, test for rout, spread rout to neighbours
9. Rout movement and rally tests
10. Army break test, end conditions
11. Recording

### Performance target

A 60-unit, 2-hour action in under one second on one core, using a spatial grid for
neighbour queries. The batch runner spreads runs across cores with worker threads.
This is a target, to be measured in Phase 1.

---

## 3. The model

Scale is real: metres, seconds, men. A unit is an oriented rectangle whose frontage
and depth are computed from its strength, its ranks and its formation.

### 3.1 Baseline (Phase 1)

**Unit state.** Strength in men (integers), morale 0–100, position, facing,
formation, status (formed, shaken, routed, dispersed), and a per-unit tally of
where every man went: present, killed or wounded, straggled, captured. The sum of
those tallies never changes. That is the conservation invariant the tests check.

**Formations.**

| Formation | Fire | Movement | Melee | As a target |
|---|---|---|---|---|
| Line | All files bear; 2 effective ranks | Slow, halts to dress | Weak if struck in flank or rear | Thin: a roundshot passes through 2–3 men |
| Column of divisions | Front two ranks of the leading division only | Fast | Shock bonus on closing | Deep: a roundshot passes through many ranks |
| Square | One face toward any enemy, reduced | Barely moves | Cavalry charge resolves almost always in its favour | Dense: worst case for roundshot and canister |

Changing formation takes time from the drill tables, and a unit caught mid-change
counts as disordered: it fires poorly and fights as if flanked.

**Musketry.** A unit fires in cycles set by its rate of fire. Each cycle:

```
casualties ~ Binomial(muskets bearing, p)
p = rangeCurve(range) × battlefieldFactor × targetCover × shooterState
```

`rangeCurve` takes its shape from period range trials. `battlefieldFactor` scales
that down to the far lower hit rates seen in action (section 5.2 explains the
choice). The first volley gets a bonus because it was loaded carefully.

**Artillery.** Roundshot: probability of an effective round by range, times men hit
per effective round, which grows with target depth along the line of fire (so
enfilade and columns suffer). Canister: balls per round, times hit chance per ball
by range, times the fraction of the cone the target fills. The battery chooses
canister inside canister range. The "canister outperforms roundshot inside its
range" test checks the outcome, not the choice.

**Charges and melee.** Period accounts and later studies (du Picq, Griffith, Muir)
agree that formed bodies seldom crossed bayonets in the open: one side gave way
before contact. So a charge is resolved in two steps. First a resolve contest as the
attacker closes: the attacker may falter and halt into a firefight, the defender may
break, or both stand. Only then, if both stand, a short melee decided by numbers,
formation shock, facing, morale and terrain. Columns earn their shock mainly in the
first step. Cavalry against infantry uses the same structure with a formation table
(square, line frontal, line flank or rear, column, disordered).

**Cavalry.** After any charge a squadron is blown: it cannot charge again and
fights at a penalty until it has rallied and rested for a set time.

**Morale.** Morale falls from casualties (weighted more heavily when taken in flank,
from artillery, or quickly), from being charged, from cavalry nearby when not in
square, and from friends routing within a radius. It recovers slowly when not under
fire, faster with supports on the flanks and rear. Below one threshold a unit is
shaken and will not close with the enemy. Below a second it routs.

**Rout and rally.** A routed unit runs for its own rear and sheds stragglers. At
intervals it tests to rally; the chance rises with distance from the enemy and falls
with losses. A rallied unit returns formed with low morale. A unit that routs twice,
or falls below a strength floor, disperses for good.

**Army break.** When the share of an army's units that are routed or dispersed
reaches the break fraction (0.6 from the brief, a named parameter) the army breaks
and the run ends. Runs also end at a scenario time limit.

**Terrain.** Baseline terrain is area features: ridge (advantage to the higher
unit in fire and melee, slows the climber), wood (cover, slows movement, disorders
formed troops, bars cavalry charges), walled farm (strong cover, large melee bonus
to the defender, holds a limited garrison).

**Per-unit behaviour and postures.** Each army has a posture: defend, attack in
line, attack in column. Each unit picks targets, formation and movement from its
posture and local situation (form square if cavalry threatens, return fire, charge
when the enemy is shaken, guns hold and fire). This is the brief's baseline AI and
it stays as the behaviour used when command and control is toggled off.

### 3.2 Deeper model (Phase 4)

Each feature has a toggle in the scenario's `features` block. With a toggle off the
engine behaves exactly as it did before the feature existed, which the tests pin
down with stored state hashes. Features are added in the brief's priority order.

**1. Command and control.** Army → corps → division → brigade → unit. Commanders
are entities on the map with a position, a command radius, an initiative rating and
a staff delay. An order is typed (attack objective, defend position, hold, support,
move, withdraw, reserve) and may carry a formation directive and a trigger (a clock
time or a condition). An order travels by courier at riding speed over the actual
distance, can be delayed or lost, and waits out the recipient's staff delay at each
level before passing down. A unit inside its brigadier's radius follows current
orders. A unit outside it keeps its last order and reacts only locally. A commander
with no fresh orders who sees the situation change (flank turned, objective taken,
neighbour routed) may act on their own with probability set by their initiative.
Commanders can become casualties; succession takes time.

Scenarios carry each side's written orders, so every scenario runs unattended.
Player intervention goes into the same order queue at the army commander and
suffers the same delays. A scenario flag permits direct orders for experiments.
All interventions are recorded in the replay.

**2. Fatigue and ammunition.** Fatigue rises with marching (by pace, slope and
ground), fighting and formation changes, and falls at rest. It slows movement and
fire, weakens melee, and lowers morale recovery. Infantry carry a set number of
rounds per man and guns a set number of rounds by type; fouling lowers the rate of
fire as rounds are spent. Resupply is a simple timed rule tied to distance from the
unit's parent formation.

**3. Skirmishers.** Modelled as a screen attached to a parent battalion or brigade,
not as free map units, because companies are below this simulator's resolution. A
screen takes men out of the parent's ranks, sits a set distance ahead, wears down
enemy formed troops and gunners at a low steady rate, shields its parent from the
enemy's screen, and is driven in by a formed advance or by cavalry. Opposing screens
fight each other first. Light battalions may deploy entirely.

**4. Quality and experience.** Classes (militia, conscript, line, veteran, guard)
adjust morale thresholds, rally chance, rate and steadiness of fire, drill times and
the resolve contest. With the toggle off every unit uses the line class.

**5. Line of sight and elevation.** Every scenario has a heightmap from the start.
With this toggle off, height gives only the flat baseline ridge modifier and
everything sees everything. With it on, the engine traces sight lines over the
heightmap and through woods and buildings: troops on a reverse slope cannot be seen
or hit by direct fire, slope affects movement and fatigue continuously, and
commanders can react only to what they can see.

**6. Smoke.** A coarse grid of smoke density, fed by each discharge, drifting with
the wind and thinning over time. Smoke along the line of fire lowers hit chance and
shortens visibility, which also degrades command.

**7. Weather and ground.** Weather (clear, rain, heavy rain, fog) and ground (firm,
soft, mud, frozen) change musket misfire rates, visibility, movement (guns and
cavalry most of all) and the bounce of roundshot. Soft ground removes most of the
ricochet effect.

---

## 4. Data

### 4.1 The rule for numbers

No tunable number appears in engine code. Each lives in JSON as a parameter object:

```json
"frontagePerFile": {
  "value": 0.65,
  "unit": "m",
  "source": "reglement-1791",
  "confidence": "sourced",
  "note": "Two French pieds per file. British regulation gives 22 in (0.56 m); see doctrine/british.json."
}
```

`confidence` is one of `sourced` (taken from a cited work), `derived` (computed
from sourced figures, with the arithmetic in the note) or `assumption` (my
judgement, with the reasoning in the note). The loader rejects any number without a
unit, a source id and a note, then flattens the objects to plain numbers for the
engine. A CLI command prints every parameter with its confidence, so you can list
all assumptions at once.

Curves use the same wrapper:

```json
"rangeCurve": {
  "x": "m", "y": "fraction of rounds striking a battalion-front target",
  "points": [[75, 0.60], [150, 0.40], [225, 0.25], [300, 0.20]],
  "interpolation": "linear",
  "source": "scharnhorst-1813", "confidence": "sourced", "note": "..."
}
```

### 4.2 Files

```
data/
  sources.json          # id -> full citation
  doctrine/*.json       # per nation: ranks, frontage per file, pace length, cadences, drill times
  weapons/*.json        # muskets, rifles, sabre and lance, guns by calibre
  units/*.json          # unit types: arm, default strength, weapon, doctrine, allowed formations
  morale.json           # shocks, thresholds, contagion radius, rally, army break fraction
  melee.json            # resolve contest and melee tables by formation and facing
  terrain.json          # terrain types and their modifiers
  quality.json  command.json  fatigue.json  skirmish.json  smoke.json  weather.json
```

### 4.3 Scenario

```json
{
  "format": "napsim-scenario", "version": 1,
  "name": "Meadow: attack in column on a line",
  "map": {
    "width": 2000, "height": 1500, "cellSize": 25,
    "elevation": [[...], ...],
    "features": [
      { "type": "wood", "polygon": [[x, y], ...] },
      { "type": "walled_farm", "polygon": [[x, y], ...], "name": "La Ferme" }
    ]
  },
  "weather": { "sky": "clear", "ground": "firm", "windFrom": 270, "windSpeed": 3 },
  "features": {
    "commandControl": false, "fatigue": false, "ammunition": false, "skirmishers": false,
    "quality": false, "elevationLos": false, "smoke": false, "weatherGround": false
  },
  "timeLimit": 7200,
  "sides": [
    {
      "id": "blue", "name": "French", "posture": "attack_column", "retreatToward": [0, 750],
      "command": {
        "id": "I-corps", "level": "corps",
        "commander": { "name": "...", "radius": 800, "initiative": 0.5, "at": [x, y] },
        "children": [ { "id": "1-div", "level": "division", "children": [ ... ] } ]
      },
      "units": [
        { "id": "fr-45e-1", "type": "fr_line_battalion", "parent": "1-bde",
          "men": 550, "quality": "line", "at": [x, y], "facing": 90, "formation": "column" }
      ],
      "groups": [
        { "id": "heavy_cav", "type": "fr_cuirassier_squadron", "parent": "cav-bde",
          "count": 4, "men": 130, "deployAlong": [[x1, y1], [x2, y2]], "facing": 90 }
      ],
      "orders": [
        { "at": 0, "to": "1-div", "type": "attack", "objective": [x, y], "formation": "column" },
        { "when": { "unitRouted": "fr-45e-1" }, "to": "cav-bde", "type": "support", "target": "1-div" }
      ]
    }
  ]
}
```

`groups` exist so that a sweep over a unit count is a change to one number.

### 4.4 Replay

A replay stores recorded state. It does not rely on re-simulating in the browser.
That keeps old replays viewable after the engine or the data changes. It also embeds
the scenario, seed, data hash and inputs, so the CLI can re-run it and confirm the
recording still matches.

```json
{
  "format": "napsim-replay", "version": 1,
  "engineVersion": "0.1.0", "dataHash": "...", "seed": 42,
  "scenario": { ... }, "inputs": [ ... ],
  "sampleInterval": 5,
  "tracks": {
    "fr-45e-1": { "x": [...], "y": [...], "facing": [...], "men": [...],
                  "morale": [...], "formation": [...], "status": [...] }
  },
  "events": [
    { "id": 790, "t": 1272, "type": "rout", "unit": "fr-25e-2", "at": [x, y], "parent": 771 },
    { "id": 812, "t": 1312, "type": "morale", "unit": "fr-45e-1", "delta": -14,
      "cause": "friend_routed", "from": "fr-25e-2", "parent": 790 }
  ],
  "result": { ... }
}
```

Every morale change is an event with a cause and, where one exists, a parent event.
The inspector walks those links backwards from a rout, across units, to show the
chain: "45e routed ← 25e routed 40 s earlier, 120 m away ← 25e charged in flank by
the Scots Greys".

### 4.5 Batch output

- `runs.csv`: one row per run. Seed, sweep values, winner, end reason, duration, and
  per side: starting men, killed and wounded, straggled, captured, units routed,
  time of army break, position of the unit whose rout tipped the army over, and
  centroid of all routed units at that moment.
- `routs.csv`: one row per rout. Run, side, unit, time, position, root cause of
  its chain. This is the table for "where did they break" maps.
- `summary.csv` and `summary.json`: one row per sweep point. Win rates with 95%
  Wilson intervals, casualty mean, median, 10th and 90th percentiles, duration
  distribution, break-time distribution.

Sweeps address any number by path, in data or scenario, and reuse the same seed list
at every point:

```
napsim batch scenarios/meadow.json --runs 500
napsim sweep scenarios/meadow.json --runs 200 \
  --param data:morale.contagion.friendRoutShock=4,8,12,16
napsim sweep scenarios/meadow.json --runs 200 \
  --param scenario:sides.blue.groups.heavy_cav.count=0..6
```

---

## 5. Sources and headline figures

### 5.1 An honest note on verification

I am working from memory of this literature and do not have the books in front of
me. The figures below are the ones I intend to use, and I believe they are close,
but none has been checked against a page yet. In Phase 1 every figure goes into the
data files with a source id, and I will check the ones I can reach (the period
regulations and trials are out of copyright and largely online). Any figure I cannot
check stays marked `unverified` in its note. The modern secondary works are not
freely available. If you own any of them, tell me which and I will give you a short
list of figures to confirm.

### 5.2 Where sources disagree: musketry

Period range trials and battlefield results differ by more than a factor of ten.
Trials against a cloth target the size of a battalion front record 40–75% hits at
about 75 m. Estimates from actual engagements run from roughly 3–5% of rounds fired
at close range down to a fraction of one percent across a whole battle.

**Choice:** the range trials set the shape of the curve by distance. Hughes's
battlefield estimates set its absolute level, through one named parameter
(`battlefieldFactor`). That parameter is the single most influential assumption in
the model and will be the first thing swept in the Phase 2 report.

A second disagreement is column against line. Oman held that the line won by
firepower arithmetic. Griffith, Arnold and Muir argue the decision came from a close
volley followed by a bayonet advance, and that French columns usually meant to
deploy and were caught before they could. **Choice:** the later view. That is why
the model has a resolve contest before melee and a real time cost for deploying.

### 5.3 Figures

| Quantity | Planned value | Source | Status |
|---|---|---|---|
| Musket trial hits, battalion-front target | 60% at 75 m, 40% at 150 m, 25% at 225 m, 20% at 300 m | French trials as reported by Hughes; cross-checked against Scharnhorst 1813 | From memory |
| Battlefield hit rate, close-range volleys | About 3–5% of rounds fired | Hughes, *Firepower* | From memory |
| Rate of fire | 2–3 rounds a minute at first, 1–2 sustained | Hughes; Muir | From memory |
| Misfires | About 1 in 6 dry, far worse in rain | Hughes | From memory |
| Rounds carried | 60 per man British, 50–60 French | Muir; Nafziger | From memory |
| Frontage per file | 0.65 m French, 0.56 m (22 in) British | Règlement 1791; Dundas 1792 | From memory |
| Ranks | 3 French (third rank contributes little fire), 2 British | Règlement 1791; Dundas; Nosworthy | From memory |
| French pace and cadences | 0.65 m pace; 76, 100 and 120 paces a minute, giving 49, 65 and 78 m/min | Règlement 1791 | From memory |
| British pace and cadences | 0.76 m pace; 75 and 108 paces a minute, giving 57 and 82 m/min | Dundas 1792 | From memory |
| Line advance in practice | Below regulation rate because of halts to dress | Nosworthy; Muir | Assumption on size of reduction |
| Square movement | 15–25 m/min | None found | Assumption |
| Cavalry gaits | Walk about 100, trot about 210, gallop about 320 m/min | Nafziger | From memory |
| Cavalry frontage | About 1 m per file, 2 ranks | Nafziger | From memory |
| Time blown after a charge | 10–20 min to rally and breathe | Accounts in Muir; no table | Assumption |
| Column to line, 600 men | 2–3 min | Nafziger's computed drill times | From memory |
| Column to square | 30–60 s | Nafziger | From memory |
| Line to square | 2–4 min | Nafziger | From memory |
| Unlimber, limber up | About 1 min, 1–3 min | Kiley; Hughes | From memory |
| Roundshot effective range | 6-pdr 600–700 m, 9-pdr about 800 m, 12-pdr about 900 m; extreme about twice that | Hughes; Kiley | From memory |
| Roundshot accuracy by range | Müller's trials | Müller 1811, via Hughes | Values to be entered from source |
| Canister range | 6-pdr to about 350 m, 12-pdr heavy canister to about 500 m | Hughes; Kiley | From memory |
| Canister spread | Cone about one tenth of the range in diameter | Hughes | From memory |
| Gun rate of fire | 1–2 roundshot a minute, 2–3 canister | Hughes | From memory |
| Rounds per gun | About 200 with caissons (Gribeauval) | Kiley | From memory |
| Courier speed | About 300 m/min across country | None found | Assumption |
| Staff delay per level | Minutes, longest at corps | Accounts in Muir | Assumption |
| Morale shocks, thresholds, contagion radius, rally odds | n/a | No quantitative source exists | Assumption, checked against the anchors in 5.4 |

The morale numbers are the weakest part of any such model. They cannot be sourced,
only constrained by outcomes, so they will all be marked `assumption` and the
Phase 2 report will show how sensitive results are to each.

### 5.4 Outcome anchors

These are checks, not tuning targets. Each phase report compares batch results
against them and says where the simulation disagrees.

- Two steady battalions in a firefight at about 100 m: a decision in roughly 5–15
  minutes, not seconds and not an hour.
- Formed cavalry against a steady square: repulsed almost every time. No Allied
  square broke at Waterloo. Garcia Hernandez (1812) is the standard exception.
- Cavalry into the flank of a line: destruction within minutes. At Albuera (1811)
  Colborne's brigade lost well over half its men this way.
- Canister inside its range causes several times the casualties per round of roundshot.
- Columns under roundshot lose markedly more per round than lines.
- Units usually break with a minority of their men down. Most of a beaten unit's
  loss comes after it breaks.

### 5.5 Bibliography

Period:
- *Règlement concernant l'exercice et les manœuvres de l'infanterie*, 1 August 1791.
- David Dundas, *Rules and Regulations for the Formations, Field-Exercise, and Movements of His Majesty's Forces*, 1792.
- Gerhard von Scharnhorst, *Über die Wirkung des Feuergewehrs*, 1813.
- William Müller, *The Elements of the Science of War*, 1811.
- Georg von Reisswitz, *Kriegsspiel*, 1824. A period Prussian simulation whose
  rate and loss tables are a useful cross-check.
- Charles Ardant du Picq, *Études sur le combat* (published 1880).

Modern:
- B. P. Hughes, *Firepower: Weapons Effectiveness on the Battlefield, 1630–1850*, 1974.
- B. P. Hughes, *Open Fire: Artillery Tactics from Marlborough to Wellington*, 1983.
- George Nafziger, *Imperial Bayonets*, 1996.
- Rory Muir, *Tactics and the Experience of Battle in the Age of Napoleon*, 1998.
- Brent Nosworthy, *Battle Tactics of Napoleon and His Enemies*, 1995.
- Paddy Griffith, *Forward into Battle*, 2nd ed., 1990.
- James Arnold, "A Reappraisal of Column Versus Line in the Peninsular War", 2004.
- Charles Oman, "Column and Line in the Peninsular War", 1910 (the view argued against).
- Kevin Kiley, *Artillery of the Napoleonic Wars*, 2004.
- Mark Adkin, *The Waterloo Companion*, 2001.
- Alessandro Barbero, *The Battle: A New History of Waterloo*, 2005.

---

## 6. Interface

**Look.** Procedurally drawn paper (no image assets), hills as hachures generated
from the heightmap (short strokes down the slope, heavier where steeper, after the
Lehmann method in use at the time), woods as stippled clumps, farms as inked plans.
Units are blue and red blocks drawn to their true frontage and depth, with a
diagonal for cavalry and gun ticks for batteries. Serif lettering.

**Replay viewer.** Load a replay file, play, pause, scrub, change speed. Clicking a
unit opens its inspector: strength and morale over time as small charts, formation
and status as a strip, and the morale event list. Selecting a rout shows its causal
chain and highlights the units involved on the map at the moments that mattered.

**Live run.** The same view driven by the engine in the browser. Paused or running,
you may issue an order to a commander; it goes into the order queue and is recorded.

**Editor (Phase 5).** Place and drag units and commanders, set formation, facing,
strength and quality, build the command tree, paint elevation with a brush, draw
terrain polygons, write orders with times and triggers, set weather and toggles,
save and load scenario JSON. Validation runs on every change and a "test run"
button runs the scenario once.

---

## 7. Tests

- **Determinism.** Same scenario, data and seed give an identical state hash at
  every sampled tick. Different seeds give different results. A stored hash for a
  reference scenario catches accidental behaviour changes.
- **Conservation.** At every tick, for every unit, present + killed and wounded +
  straggled + captured + detached to a screen equals the starting strength. No
  tally ever goes negative and no side's total ever rises.
- **Toggle isolation.** With every Phase 4 feature off, the reference hash matches
  the Phase 1 value.
- **Behaviour**, each run over many seeds with a stated pass rate:
  - A steady square repels cavalry.
  - Cavalry breaks a line taken in flank.
  - The same line met frontally usually holds or does far better.
  - Canister causes more casualties than roundshot at the same target inside canister range.
  - A column takes more roundshot casualties than a line at the same range.
  - A square takes more than either.
  - A line outshoots a column in a stand-up firefight.
  - A column crosses the same ground faster than a line.
  - Blown cavalry loses to fresh cavalry.
  - A rout lowers the morale of friends inside the radius and not of those outside it.
  - Some routed units rally when unpursued; an army breaks at the break fraction.
  - Wood and farm reduce casualties taken; uphill defenders do better than level ones.
- Each Phase 4 feature adds its own (an order arrives later when the commander is
  farther away; a unit on a reverse slope takes no direct fire; and so on).

---

## 8. Historical calibration scenario

**Recommended: d'Erlon's attack at Waterloo, about 13:30–15:00 on 18 June 1815.**

It is among the best documented actions of the period, and it exercises most of the
model at once: columns advancing on a line, a preparatory bombardment over wet
ground, defenders on a reverse slope, a cavalry counter-charge into disordered
infantry, and that cavalry then blown and cut up by fresh horse. Most of the Phase 4
toggles should visibly move the result, which makes it a good test of them.

Proposed scope: the centre of the attack. Donzelot's and Marcognet's divisions with
part of the grand battery and supporting cavalry, against Picton's division,
Bijlandt's brigade and the Union Brigade. La Haye Sainte and the Papelotte flank are
left out. That is roughly 17 French battalions against about 12 Allied battalions
and 9 squadrons.

The note in `CALIBRATION.md` will compare, across a batch: whether the attack is
repulsed, how long it takes, French losses including prisoners, British heavy
cavalry losses, and whether the cavalry overreaches. It will state plainly where
the simulation diverges and what that suggests about the model.

The alternative, the assault on the Pratzen Heights at Austerlitz, is a cleaner
infantry action but less well documented at battalion level and exercises fewer
features.

---

## 9. Phased plan

Each phase ends with something you can run and a short report of batch numbers,
including anything that looks historically implausible. I will report implausible
results as findings and leave the numbers alone unless a source supports changing
them. `MODEL.md` is updated in the same commit as every rule.

**Phase 1: engine, CLI, tests.** Workspace setup, data loader and validator, the
baseline model of section 3.1, a generic scenario and small fixture scenarios, the
tests of section 7.
You can run: `npm test`, and `napsim run scenarios/meadow.json --seed 1` for a
text summary and event log, with `--replay out.json` to record.

**Phase 2: batch runner and reports.** Parallel batch, sweeps over data and
scenario paths, the CSV and JSON outputs of section 4.5, a parameter listing command.
You can run: the `napsim batch` and `napsim sweep` commands above.
Report: baseline win rates and distributions for each posture pairing, and the
first sensitivity sweeps (`battlefieldFactor` and the morale assumptions).

**Phase 3: UI with replay.** Period map rendering, replay loading and scrubbing,
unit inspector with history and rout chains, live run with optional orders.
You can run: `npm run ui`, then open a replay written by the CLI.

**Phase 4: deeper model.** One feature at a time, in priority order: command and
control, fatigue and ammunition, skirmishers, quality, line of sight and elevation,
smoke, weather and ground. Each arrives with its toggle, its data file, its
`MODEL.md` section, its tests, and a paired on/off batch comparison.

**Phase 5: editor and historical scenario.** The editor of section 6, the d'Erlon
scenario, and `CALIBRATION.md`.

---

## 10. Decisions needed

Each has a default. Replying "go" accepts all of them.

1. **Prototype.** It is not in the repo. Default: rebuild the baseline from the
   brief. If you can commit `prototype/index.html`, I will port it instead.
2. **Historical scenario.** Default: d'Erlon's attack, centre only, as scoped in
   section 8.
3. **Sources.** Default: the list in 5.5, with Hughes as the anchor for weapon
   effect and Nafziger for drill times. Tell me if you own any of them or prefer
   others.
4. **Musketry and column-versus-line choices** in 5.2. Default: as stated.
5. **Skirmishers as attached screens**, not free units. Default: yes.
6. **Replays store recorded state** and are verifiable by re-running, instead of
   being re-simulated in the browser. Default: yes.
7. **Toolchain.** npm workspaces, Vitest, Vite, no UI framework. Default: yes.
