# MODEL

Every rule and formula in the engine, in plain language. Updated in the same commit
as the code. Parameter names in `code font` are keys in the `data/` files, where each
has a unit, a source and a note. `napsim params` lists them all.

Contents: 1 conventions · 2 porting from the prototype · 3 units and formations ·
4 the tick and movement · 5 fire · 6 contact and melee · 7 morale, rout, rally ·
8 events and cause chains · 9 unit behaviour · 10 terrain · 11 known implausibilities ·
12 deeper-model features

---

## 1. Conventions

- **Scale.** Metres, seconds, men. Men are integers.
- **Map.** x runs east, y runs south, origin at the north-west corner. Facings in
  scenario files are compass bearings (0 north, 90 east).
- **Time.** Fixed step of 1 s. A scenario ends at its `timeLimit`, 100 s
  (`aftermathDuration`) after an army breaks, or after `stallLimit` (default 1,200 s)
  with nobody moving, firing or being hit ("stalemate").
- **Randomness.** Each random draw is a hash of (seed, subsystem, unit number, tick).
  It does not depend on how many draws were made before, so changing one coefficient
  or switching on one feature leaves unrelated draws untouched. The same seed is "the
  same battle" as far as possible across a sweep.
- **Determinism.** The engine uses only `+ - * /`, `sqrt` and integer operations, with
  its own sine, cosine and arctangent, so results are bit-identical in Node and in
  browsers. Losses are queued during a phase and applied together, so the order in
  which units are processed cannot favour a side.
- **Sides.** Exactly two. Each has a `rear` direction: routed units flee along it and
  formed units start facing the opposite way.

## 2. Porting from the prototype

The baseline rules come from `prototype/index.html`. That prototype works in pixels
and in compressed time. The port keeps its rules and its dimensionless coefficients
and replaces its scale with real figures.

- **Time factor 7.** The prototype musket reloads in 3.2 s; a real one in about 22 s.
  Every prototype rate "per second" is divided by 7 and every duration multiplied by
  7, unless a historical figure replaces it.
- **Distance factor 1.4 m per pixel.** The prototype line is 96 px wide; a 600-man
  line is about 135 m. Prototype distances used by unit behaviour and morale are
  multiplied by 1.4, unless a historical figure replaces them.
- **Replaced by historical figures:** unit frontage and depth, march rates, formation
  change times, musket and gun range curves, gun reload times, unlimber time.

Deliberate departures from the prototype, each with its reason:

| Prototype | Engine | Why |
|---|---|---|
| Fixed unit footprints | Frontage and depth computed from men, ranks and formation | Real scale. Footprints shrink with losses. |
| All infantry identical | French three ranks, two firing; British two ranks, both firing | Doctrine data. This is the arithmetic behind line against column. |
| Line fires with 0.9 of its men, column 0.28, square 0.3 | Muskets bearing computed from files in front and ranks that fire (section 5.1) | Derived from the formation, not asserted. |
| Volley loss = men × factor × uniform noise | Binomial draw over muskets bearing | Integer men; variance comes from the process. |
| Cavalry unit of 300 | Two squadrons of 150 | The brief's unit of account. A lone squadron is more brittle than the prototype's unit: the same loss is twice the share of its strength. |
| Formation change 3.5 s (about 25 s real) | 45–150 s from the drill tables | Sourced. Makes being caught mid-change a real risk. |
| Infantry forms square when targeted cavalry is within 185 px | When the cavalry could arrive before the square is formed, plus a margin (9.1) | The fixed distance assumed the 3.5 s change. |
| Line turns at 0.4 rad/s | Wheels on a pivot at the quick pace: rate = speed / frontage | Real scale. A 110 m line needs about three minutes to wheel a quarter circle. |
| Cavalry blown only after a repulse, for 7 s | Blown after a repulse or once a charge's melee ends, for `blownTime` (300 s) | The brief says cavalry are blown after a charge; 49 s is too short to rally horses. |
| "On the ridge" as a region | Height from the heightmap: 5 m higher than the opponent is the high ground; a gradient above 3% is a slope | Scenarios define hills by elevation. |
| Units in melee stand still | A unit with an attack order keeps closing if its opponent's footprint has shrunk away | Needed once footprints shrink. |
| Contact shock every time two units touch | Not repeated for the same pair within `recontactTime` (120 s) | Same reason. |
| Attack in line: column beyond 210 px, line inside | Same, but a battalion already in line returns to column only beyond twice that | At real drill times the switch back and forth left units re-forming under fire. |
| Battle ends when an army breaks | Runs 100 s longer | So pursuit losses are counted. |
| Lost men vanish | Killed and wounded, prisoners, and dispersed are tallied separately | Conservation and reporting. |

How the port's outcomes compare with the prototype's is in section 11.

## 3. Units and formations

A unit has: men present, killed and wounded, prisoners, dispersed; morale 0–100;
steadiness `q` (a multiplier on morale loss, lower is steadier, from its quality
class); position, facing, formation; status formed, routed or gone.

**Conservation.** `men + casualties + captured + dispersed + detached = starting men`
for every unit at every tick. Checked by the tests.

**Footprint** (width × depth), from doctrine data:

```
line:    width = men / ranks × fileWidth                 depth = ranks × rankDepth
column:  deep  = ranks × columnDivisions
         width = men / deep × fileWidth
         depth = (columnDivisions − 1) × width × columnIntervalFraction + deep × rankDepth
square:  side  = men / (4 × squareRanks) × fileWidth + 2 × squareRanks × rankDepth
cavalry: width = men / ranks × fileWidth                 depth = ranks × rankDepth
battery: width = guns × gunInterval                      depth = fixed
```

A 600-man French battalion is 112 m × 2 m in line, 37 m × 43 m in column of
divisions and 32 m square. A British one is 168 m in line (two deep). A 150-sabre
squadron is 75 m wide. A six-gun battery is 90 m.

**Formation change** takes the drill-book time for that pair of formations. Until it
is complete the unit cannot move or fire and is treated as "forming" in melee and
when charged.

**Distance between units** is the gap between their rectangles (zero if they overlap).

**Flank and rear.** An attacker within `frontArc` (60°) of the target's facing is in
front; out to `flankArc` (132°) is the flank; beyond is the rear. A square has no flank.

## 4. The tick and movement

### 4.1 Order of a tick

1. Timers run down (reload, formation change, blown, charge impetus). Units due to
   reconsider do so (section 9).
2. Contact and melee (section 6).
3. Break tests: destroyed below `destroyedFraction` (12%) of starting men; routs at
   or below `routThreshold` (20).
4. Movement, including flight and rally.
5. Fire (section 5).
6. Morale recovery.
7. Army break test.
8. End conditions.

### 4.2 Movement

Speed in m/s:

```
line     cadenceLine × paceLength / 60 × lineDressingFactor     French 0.66, British 0.76
column   cadenceColumn × paceLength / 60                         French 1.08, British 1.37
square   squareSpeed                                             0.25
cavalry  trotSpeed 3.5; chargeSpeed 5.3 within chargeStartRange (200 m) of its target
battery  speed                                                   0.6
routed   routSpeed                                               infantry 1.8, cavalry 4.6
```

Multiplied by the terrain type's movement factor if inside a wood or farm, otherwise
by `slopeMove` (0.88) on ground steeper than `slopeThreshold`.

A unit turns toward its heading at its turn rate and steps off once it is pointed
within 23° (infantry, guns) or 52° (cavalry). Infantry wheels at
`column speed / frontage` radians per second; cavalry and guns use a fixed rate.
A square does not turn.

A unit ordered to attack moves until it reaches its stopping distance: contact for
cavalry and for infantry told to charge; `engageRange` (110 m) for infantry told to
fire; 0.9 of effective roundshot range for a battery.

Friends closer than 0.62 of their combined radii push the moving unit aside. Formed
units stay 30 m inside the map edge.

### 4.3 Simultaneous losses

Losses from melee, and then from fire, are collected and applied together at the end
of that phase. Fractions of a man are carried forward per unit, so men stay whole.

## 5. Fire

### 5.1 Musketry

A formed battalion that is halted, loaded, not in melee and not changing formation
fires at the nearest formed enemy within `openFireRange` (135 m) and within 40° of its
front (a square fires in any direction). A battery counts as 40 m farther when
choosing. Units already in melee are not fired on.

```
muskets = files in front × ranks that fire × rankAndFileShare(0.9)
   line    men / ranks × firingRanks            French 360 of 600, British 540
   column  men / (ranks × columnDivisions) × firingRanks      French 120, British 108
   square  men / (4 × squareRanks) × squareFiringRanks        French 90, British 68

p = trialCurve(range) × battlefieldFactor
    × (moraleFloor + (1 − moraleFloor) × morale / 100)
    × 0.5 if the target is a battery, × 1.25 if it is a column
    × the target's cover, × 1.15 if the firer has the high ground

casualties ~ Binomial(muskets, p)
```

`trialCurve` is Scharnhorst's 1813 result on a board 6 ft × 100 ft: 46% at 75 m, 32%
at 150 m. `battlefieldFactor` (0.04) scales it to battle: 1.8% of rounds at 75 m.
Reload takes `60 / roundsPerMinute` (30 s), varied by ±10%.

Cavalry that takes a volley inside 85 m with morale below 52 recoils (section 6.4).

### 5.2 Artillery

A battery fires at the highest-scoring formed enemy within maximum roundshot range,
provided it has been halted for `unlimberTime` (60 s), is loaded, and is pointed
within 12.6° of the target. Score: square 3, column 2.2, line 1, cavalry 1.3, battery
0.6; divided by `1 + distance / (0.6 × effective range)`; × 2.5 inside canister range.

Guns in action = `guns × men present / starting men`.

**Roundshot** (beyond canister range):

```
ranks traversed = ranks (line, frontal); ranks × columnDivisions (column);
                  as a column (square); 2 (cavalry); 1 (battery);
                  the cap for anything taken in flank or rear
                  — never more than maxRanksTraversed (8)
men per hit     = ranks traversed × menPerRank (0.5), × squareTargetFactor (1.33) for a square
casualties      = guns × roundshotCurve(range) × roundshotBattlefieldFactor (0.5) × men per hit
                  × 0.8 if the target is on higher ground × the target's cover
```

`roundshotCurve` is Müller's 6-pdr trial: all rounds on target to 475 m, 31% at 870 m,
17% at 1,100 m. Per salvo of six guns inside 475 m: 4.5 men on a French line, 3 on a
British line, 12 on a column, 16 on a square.

**Canister** (inside `canisterRange`, 350 m):

```
casualties = guns × canisterHitsCurve(range) × canisterBattlefieldFactor (0.1)
             × 1.5 square, 1.25 column, 1.0 line, 0.6 cavalry, 0.4 battery × cover
```

About 33 men per six-gun salvo at 180 m, 21 at 300 m.

Each salvo is varied by ±30% and rounded to whole men at random in proportion to the
fraction. Reload: roundshot 35 s, canister 24 s, ±10%.

## 6. Contact and melee

### 6.1 Contact

Two enemy units closer than `contactDistance` (5 m) are in contact, and stay so until
the gap exceeds four times that.

- If one is routed, the formed one cuts it down: 3.4 men/s by cavalry, 1.0 by
  infantry. 70% of these losses are counted as prisoners. No morale effect.
- Blown cavalry neither harms nor is harmed by infantry or guns it touches.
- Otherwise the two are in melee.

### 6.2 Shock on first contact

Applied once when a pair first touches (not again within 120 s):

| Event | Effect |
|---|---|
| Cavalry reaches a steady square (formed, morale ≥ 40) | Cavalry loses 14 × q, recoils blown (6.4) |
| Cavalry reaches a shaken square | Square loses 12 × q |
| Cavalry reaches other infantry | Infantry loses 10 × q in front, 22 × q in flank, 30 × q in rear, 26 × q if changing formation |
| Cavalry or infantry reaches a battery | Battery loses 35 or 30 |
| A moving column reaches infantry | Target loses 8 × q |

Cavalry that was charging gains charge impetus for 18 s.

### 6.3 Melee

Each second each side loses `lethality (0.0043) × opponent's power` men.

```
power = men × arm factor (cavalry 2.2, infantry 1, gunners 0.15)
        × matchup factor (below)
        × 1.15 with the high ground
        × (0.5 + morale / 100)
```

| Attacker | Against | Factor |
|---|---|---|
| Infantry | Cavalry | square steady 1.5, square shaken 0.6, column 0.45, line 0.32, forming 0.2 |
| Infantry | Infantry or guns | column 1.2, line 1.0, square 0.7, forming 0.6; × 1.5 into the flank or rear of infantry not in square |
| Cavalry | Infantry | steady square 0.1, shaken square 0.7; otherwise front 1.2, flank 2.2, rear 3.0, × 1.5 if the infantry is forming; × the terrain's factor for infantry inside it (farm 0.4) |
| Cavalry | Guns | 3.0 |
| Cavalry | Anything | × 1.4 while impetus lasts; × 0.5 if either is in a wood |

A unit in contact with two enemies strikes each at full power, as in the prototype.

### 6.4 Blown cavalry

A squadron is blown for `blownTime` (300 s) when it recoils from a square or a
volley, and when a melee it charged into ends. A recoiling squadron falls back 240 m
and will not charge the same steady target frontally for 200 s. While blown it does
not choose new targets, gallop, or fight infantry and guns. It can still be
attacked by cavalry, and it still cuts down routed troops it is touching.

## 7. Morale, rout, rally, army break

**Starting morale** 86, or 96 for units with steadiness below 0.9.

**Loss from casualties:**

```
Δmorale = −(men lost / starting men × 100) × casualtyShock (1) × cause factor × q
          × 0.5 for gun crews
cause factor: musketry in front 1.0; musketry in flank or rear 1.6;
              musketry on a column within 75 m 2.15; roundshot 1.2; canister 1.4; melee 1.5
```

**Rout.** At or below 20 a formed unit routs. A battery is abandoned and removed. A
routed battalion counts as a column-sized mob. When a unit routs or is destroyed,
every formed friend within `rippleRadius` (250 m) loses 7 × its q, and every formed
enemy within it gains 4.

**Flight and rally.** A routed unit runs toward its rear. While no formed enemy is
within 350 m it recovers 0.86 morale/s up to 60. It rallies on reaching 48 if it
still has 30% of its starting men, has rallied fewer than twice, and its army has not
broken. A rallied battalion re-forms in line in 20 s. A routed unit that leaves the
map or falls below 12% strength is gone and its men are counted as dispersed.

**Recovery.** A formed unit not in melee and not hit for 35 s recovers 0.19 morale/s,
up to `100 × (0.5 + 0.5 × men / starting men)`.

**Army break.** When the formed units of an army fall to 40% of its starting number
(`armyBreakFraction` 0.6 broken), it breaks: every remaining unit routs. If both
armies cross the line in the same second, both break and nobody wins.

## 8. Events and cause chains

Every morale change is recorded with its cause and, where there is one, the unit
that caused it and the event that led to it. Changes with the same cause and source
are merged over ten seconds.

When a unit routs, the event lists the causes of its morale loss over the previous
`chainWindow` (300 s), largest first, with the ids of the underlying morale events.
A "friend routed" cause points at that friend's rout event, which has its own list.
Following those links gives the chain across units. Each rout also carries:

- `topCause`: the cause that took the most morale.
- `trigger`: the last cause before it broke.
- `rootCause` and `rootUnit`: if the top cause was a friend routing, the root cause
  of that friend's rout, followed back to the first unit in the chain.

Event types: `morale`, `rout`, `destroyed`, `guns_abandoned`, `gone`, `rally`,
`contact`, `formation`, `fire`, `blown`, `army_broken`, `input`, `end`. Batch runs
keep only the summary events; recorded runs keep all of them.

## 9. Unit behaviour

Each unit reconsiders every `thinkInterval` (4 s). There is no plan above the unit
unless command and control is on (section 12). A unit under a manual order skips this.

### 9.1 Infantry

1. **Square.** Form square if unblown enemy cavalry is within 140 m (280 m to stay in
   square), or if cavalry that is attacking this battalion is within
   `(time to form square + 30 s) × 4.5 m/s + (1 − q) × 125 m`.
2. Otherwise by posture:
   - **Defend:** form line, stand.
   - **Attack in column:** form column and charge the nearest enemy foot or guns.
   - **Attack in line:** column beyond `deployRange` (300 m) from the nearest enemy
     foot or guns, line inside it. Advance to 110 m and fire. Charge instead if the
     target is a battery, or its morale is below 55, or 8 below the attacker's own.

### 9.2 Cavalry

Scores every enemy within its leash (460 m defending, 870 m attacking) and attacks
the best if it scores above 12. Base scores, less distance / 12.6 m (or / 16.8 m for
attacking cavalry against infantry): guns 62 (−22 if infantry stands within 120 m of
them); blown cavalry 58, fresh cavalry 44; infantry that will still be forming when
the charge arrives 70; infantry reachable in flank or rear 58; shaken infantry 52;
infantry hit in the last 18 s 40; steady infantry frontally 36 attacking, 18
defending; a shaken square 52; a steady square never; routed troops within 420 m 42.

With no target: attacking cavalry keeps 180 m behind its side's leading infantry on
its own wing; defending cavalry returns to its post.

### 9.3 Artillery

Stands and fires. When its side attacks and no enemy is within 0.9 of effective
range, it advances until one is.

## 10. Terrain

| | Wood | Walled farm |
|---|---|---|
| Movement: infantry, cavalry, guns | 0.55, 0.4, 0.55 | 1, 1, 1 |
| Casualties from musketry, artillery | × 0.7, × 0.6 | × 0.45, × 0.5 |
| Cavalry in melee, in or against | × 0.5 | no effect |
| Cavalry against infantry inside | no effect | × 0.4 |

**Height.** Hills are defined in the scenario as elliptical mounds or as an explicit
grid, and combined into a heightmap. A unit at least `heightAdvantageMin` (5 m) above
its opponent has the high ground: melee power × 1.15, musketry × 1.15, and roundshot
fired up at it × 0.8. Ground steeper than 3% slows movement to 0.88. In the baseline
everything can see everything; line of sight comes with the elevation feature.

## 11. Plausibility: corrections made and problems still open

### 11.1 Corrections made

Two coefficients ported from the prototype gave results well outside the historical
record at real scale. Both were changed after the Phase 2 sweeps. The prototype's
values can be restored from the command line to see the difference.

**Change A: `casualtyShock` 1 → 3.** With the prototype's value, frontal musketry
took 1 morale per 1% of strength lost, so fire alone needed about 66% casualties to
rout a battalion and units were shot to pieces where they stood. At 3 a line
battalion breaks after about 22% losses to frontal musketry, 16% to canister and 10%
to close fire on a column; a guard battalion stands about half as much again.

**Change B: `routRecoveryRate` 0.86 → 0.05 morale/s.** The prototype's rate, divided
by 7, rallied a broken battalion in about 35 seconds and sent it back into the
attack; battalions routed, rallied and re-attacked three times in half an hour.
Regaining the 28 points needed to rally now takes about nine minutes.

Effect on the pitched-battle preset (200 runs; French attack a ridge in line):

| | Prototype values | A only | A and B |
|---|---|---|---|
| Allied win | 100% | 100% | 100% |
| Median duration | 28 min | 33 min | 15 min |
| French killed and wounded | 61% | 49% | 17% |
| French total loss | 81% | 72% | 29% |
| Allied killed and wounded | 12% | 9% | 3% |

Column against line (200 runs), with A and B: the columns are repulsed every time,
losing 12% against 2%, and the cause recorded for nearly every rout is close musketry
on the column. That is the Peninsular pattern.

### 11.2 Still open

1. **Attackers do worse than in the prototype.** See the table below. At real scale
   a battalion spends about eight times as long inside canister range and twice as
   long inside musket range as the prototype's did, because the prototype's units
   moved several times too fast for its weapon ranges. The direction is plausible:
   an unprepared frontal attack on a ridge with guns should usually fail.
2. **Numbers do not help a column attack.** Twelve battalions attacking four in
   column lose as surely as four do. They arrive in waves of four, each column
   meets a fresh line alone, breaks within ten seconds of contact, and the army
   gives up when two waves have gone. A 3:1 attack that never succeeds is doubtful.
3. **Unlimited canister.** With no ammunition limit a battery fires canister for as
   long as a target stands in range. Canister is the leading cause of French routs
   in the pitched battle, and its trial-to-battle factor is the most influential
   single coefficient found so far (sweep below). The ammunition feature limits it.
4. **Melee losses.** Smaller than before change A but still several percent per
   side in a few seconds. Period evidence is that bayonet fights were rare, short
   and caused few casualties.
5. **Melee has no randomness.** Its outcome is fixed by the state at contact, so
   infantry-only scenarios vary very little between seeds (duration p10 to p90 of
   the column preset: 18.4 to 18.5 min).
6. **Infantry fire passes through friends.** No masking by friendly units.
7. **A battalion knows when cavalry has picked it as a target.** Kept from the prototype.
8. **Attack in line deploys inside canister range.** `deployRange` (300 m) was
   outside canister range in the prototype and is inside it at real ranges.

### 11.3 Port against prototype

Share of runs won by the French. The prototype column is its own simulation run
headless (`tools/prototype-baseline.mjs`, 200 runs). "none" is no decision in two hours.

| Preset | Prototype | Port, prototype values | Port, with A and B |
|---|---|---|---|
| Pitched battle (French attack in line) | 34% | 0% | 0% |
| Column against line | 8% | 0% | 0% |
| Cavalry against squares (with two batteries) | 97% | 100% | 99% |
| The grand battery | 64% | 61%, none 25% | 99% |
| Allied counterattack (French defend) | 60% | 100% | 100% |

### 11.4 Sensitivity (Phase 2 sweeps, 150-200 runs per point, same seeds at every point)

| Coefficient | Scenario | Values | Effect |
|---|---|---|---|
| Canister battlefield factor | Pitched | 0.025, 0.05, 0.1, 0.2 | French win 21%, 2%, 0%, 0% (prototype morale values) |
| Musket battlefield factor, both sides | Pitched | 0.02, 0.04, 0.08 | None: the attack is decided by canister before musketry matters |
| Musket battlefield factor, defender | Column | 0.01, 0.02, 0.04, 0.08 | French win 3%, 0%, 0%, 0%; Allied loss 10%, 6%, 2%, 0% |
| `casualtyShock` | Pitched | 1, 2, 3, 4, 6 | French killed and wounded 61%, 56%, 49%, 42%, 30%; winner unchanged |
| `rippleFriend` | Pitched | 0, 7, 14, 21 | No visible effect on the winner |
| `blownTime` | Pitched | 60, 300, 900 s | No visible effect on the winner |
| French batteries | Pitched | 0, 2, 4, 6 | French win 0%, 0%, 0%, 3%; battle lasts 14, 15, 19, 22 min |
| French battalions | Column | 4 to 12 | French win 0% throughout (item 2 above) |
| French posture | Pitched | line, column | No difference in the winner or in losses |

## 12. Deeper-model features

Each feature is switched on in the scenario's `features` block, or for a batch with
`--set scenario:features.<name>=true`. With a feature off, none of its code runs and
results are identical to the baseline; a pinned state hash in the tests guards this.
To compare, sweep the toggle: `--param scenario:features.<name>=false,true` runs
both on the same seeds.

### 12.1 Command and control (`commandControl`)

Parameters: `data/command.json`. All are assumptions; no quantitative source was found.

**Hierarchy.** Each side has a tree of formations (army or corps, division, brigade),
each with a commander who has a position, a command radius, an initiative rating and
a staff delay. Units belong to a formation. If the scenario gives no tree, one is
made: a headquarters 300 m behind the army, infantry brigades of four battalions,
one cavalry brigade per wing, and guns attached to the nearest brigade.

A brigadier rides 80 m behind the centre of his formed units; a higher commander
200 m behind the centre of his subordinates; the top commander stays where the
scenario puts him.

**Orders.** `attack`, `defend`, `hold`, `support`, `move`, `withdraw`, `reserve`,
with an optional objective point, a formation (line or column) for attacks, and a
target formation for support. A scenario's written orders each have a time (`at`) or
a trigger (`when`: a unit has routed, half a formation has broken, enemy within a
distance of a formation). With no written orders, the side's posture becomes one
standing order to the whole army.

Orders dated 0 are the orders of the day: every unit has them when the action
opens. Any later order goes through the chain:

1. The top commander's staff writes it: `staffDelay` for his level, ±25%.
2. A courier rides to the recipient at `courierSpeed` (5 m/s). With probability
   `courierLossChance` (5%) he is lost on the way; the order is sent again
   `resendTime` (300 s) later.
3. The recipient's staff delay passes, then the order takes effect at his formation.
4. He sends couriers to his subordinate commanders, who repeat steps 3 and 4.
5. A unit adopts its formation's order when it is inside the command radius of a
   living commander in its chain. Until then it keeps its previous order.

Default staff delays: army and corps 240 s, division 150 s, brigade 60 s. Default
radii: 1,500, 1,200, 800 and 400 m.

**What an order does to a unit.** It sets the unit's posture (attack in line or in
column for `attack`, defend for everything else) and may give it a place to go: the
objective, shifted by the unit's offset from its formation's centre when the order
took effect, so formations keep their shape.

- `attack` with an objective: march on it in column until formed enemy is within
  `engageRadius` (500 m), then fight as the posture says.
- `move`, `defend` with an objective, `support`, `withdraw`: march to the place in
  column, then stand. A supporting formation keeps 250 m behind the one it supports.
  Infantry and guns stop and fight if formed enemy comes within 335 m, except when withdrawing.
- `reserve`: stand in column; fight only if the enemy closes.
- `hold`, `defend` without an objective: stand.
- Cavalry that is not ordered to attack or defend looks for targets only within 0.3
  of its usual distance.

The per-unit reactions of section 9 (forming square, returning fire, cavalry
choosing targets) still apply inside whatever the order allows.

**Initiative.** Every `initiativeInterval` (60 s) each subordinate commander reviews
his formation. If a reason to act exists he acts with probability equal to his
initiative; the new order takes half his staff delay and goes to his units and
subordinates in the usual way.

| Situation | What he may do |
|---|---|
| Half his units have routed or gone | Withdraw 400 m |
| Attacking, and over half his formed units are below morale 45 | Halt for 300 s, then resume |
| Not ordered to attack, and a vulnerable enemy (morale below 55, changing formation, or in melee) is within 150 m of his infantry or 500 m of his cavalry | Attack it for 480 s, then return to his orders |

**Out of command.** A formed unit outside every radius in its chain recovers morale
at half rate. A routed unit inside one recovers at double rate.

**Commander casualties.** While formed enemy is within 200 m of a commander he has a
0.02% chance per second of being hit. His formed units within his radius lose 6 × q.
A successor takes over after 180 s, with 0.7 of the initiative and 0.8 of the
radius. In between, the formation has no commander: no orders pass, and its units
are out of command unless a higher commander's radius covers them.

**Player orders** go to a formation through the same chain from the top commander,
unless marked direct.

**Deciding undecided battles.** A scenario may name an objective and its defender.
If neither army has broken when the run ends, the attacker wins if he has more
formed men within the objective's radius than the defender; otherwise the defender
wins. Results record which rule decided (`decidedBy`).

**Effect** (200 runs each, same seeds):

| Scenario | Off | On |
|---|---|---|
| Pitched battle, no written orders | Allied win 100%, 15 min, French K/W 17% | Allied win 100% (89% by breaking the French, the rest on the objective), 20 min, French K/W 25% |
| Column against line | Allied 100%, French loss 12% | Allied 100%, French loss 13% |
| Allied counterattack | French 100% | French 99% |

With orders dated 0 and no written plan the feature changes little: its effects come
from commanders halting or pulling back beaten formations, which lengthens battles.

`scenarios/pitched-orders.json` shows the rest: the French guns bombard for ten
minutes, then the division is ordered to attack in column. In a typical run the
order is issued at 10:00, leaves headquarters at 14:06, takes effect at the division
at 16:24 and at the two brigades at 18:05 and 18:34. The attack is repulsed and the
division commander pulls it back on his own initiative; the Allies win on the
objective in 99% of runs and the French army itself breaks in only 1%. Sweeping the
corps staff delay (30, 240, 900 s) and courier speed (2, 5 m/s) does not change who
wins here, because the defenders have nothing to do but wait.

Implausible or weak points:
- After a repulse the guns of both sides go on firing for the rest of the two hours
  (French total loss 54%), because ammunition is unlimited until the next feature.
- Commanders know the state of their units exactly and at once.
- Initiative has only the three behaviours in the table.

### 12.2 Fatigue (`fatigue`) and ammunition (`ammunition`)

Two separate toggles. Parameters: `data/fatigue.json`, `data/ammunition.json`. The
ammunition loads have sources of a kind; every rate and effect is an assumption.

**Fatigue** runs from 0 (fresh) to 1 (spent).

| Gained from | Amount |
|---|---|
| Marching (infantry, guns) | 0.05 per km |
| Cavalry at the trot, at the gallop | 0.08, 0.6 per km |
| Slope, wood or farm | × 1.5 |
| Each volley, each salvo | 0.004, 0.003 |
| Melee | 0.003 per second |
| Each change of formation | 0.02 |

A unit that is halted, not in melee and has not fired for 45 s recovers 0.0004 per
second (0.24 in ten minutes).

Effects, each linear in fatigue: speed × (1 − 0.4 f); reload time × (1 + 0.5 f);
melee power × (1 − 0.4 f); morale recovery × (1 − 0.5 f); morale lost per casualty
× (1 + 0.3 f). Cavalry above 0.8 cannot gallop, so it gets neither charge speed nor
the charge bonus.

**Ammunition.**

- Infantry carry `cartridges` rounds a man (French 50, British 60). A volley costs
  each man who fired one round, averaged over the battalion: a British line spends
  1 round a man per volley, a French line 0.67 (its third rank does not fire), a
  column about 0.2. Below half a round the battalion cannot fire, and one attacking
  in line goes in with the bayonet instead of halting to shoot.
- The first volley of the day hits 1.5 times as hard (`firstVolleyBonus`).
- Fouling builds over 25 volleys. Fully fouled, reload time is × 1.5 and hits × 0.8.
- A battalion with no formed enemy within 400 m for 600 s is brought back up to half
  a load from its reserve, once, and its barrels count as clean again.
- A battery has roundshot and canister per gun (field gun 80 and 20; 12-pdr 57 and
  20). A salvo costs one round per gun in action. With canister gone it fires
  roundshot at close range; with roundshot gone it can fire only inside canister
  range. Guns are not resupplied.

**Effect** (200 runs each, same seeds):

| Scenario | Neither | Ammunition | Fatigue | Both |
|---|---|---|---|---|
| Pitched battle: duration, French K/W | 15.4 min, 17% | 15.4 min, 17% | 15.8 min, 17% | 15.9 min, 17% |
| Grand battery: French win | 99% | 92% | 96% | 95% |
| Written orders: duration, Allied loss | 120 min, 39% | 76 min, 37% | 120 min, 39% | 77 min, 34% |

Both features matter little in actions that are over in a quarter of an hour, which
is itself plausible: battalions rarely emptied their pouches in one attack.
Ammunition ends the two-hour mutual bombardment noted in 12.1 (the guns fall silent
after about 75 minutes) and takes some of the edge off the grand battery.

Implausible or weak points:
- Canister is still not the limit it should be in short actions: twenty rounds a gun
  last eight minutes of continuous fire, longer than most assaults.
- No battery is ever resupplied or relieved, and no caisson can be hit.
- Fatigue has no effect on the willingness to advance, only on performance.

### 12.3 Skirmishers (`skirmishers`)

Parameters: `data/skirmish.json`, and `skirmishFraction` on each infantry type in
`data/units.json`. All rates are assumptions.

A screen is attached to its parent battalion. It is not a unit on the map, because
companies are below this simulator's resolution.

- **Strength.** A share of the battalion's men: French line 0.16 (one company in
  six), British line 0.10, French light 0.33, British rifles 0.5. A scenario may set
  a number per unit. While out, those men are counted as detached: the formed body
  is that much smaller, with a shorter front and fewer muskets.
- **Out and in.** The screen goes out when formed enemy is within 500 m. It comes in
  when formed enemy infantry is within 180 m of the battalion (the screen is driven
  in), when unblown enemy cavalry is within 350 m, when the battalion forms square,
  enters melee or routs, or when no enemy is near. The survivors rejoin the ranks.
- **Fire.** The screen works 150 m ahead of the battalion. Every 30 s each
  skirmisher fires one aimed round at the nearest formed enemy within 160 m of the
  screen: hit chance `trial curve × 0.05`, × 0.5 against gun crews, × the target's
  cover. Casualties count as frontal musketry for morale.
- **Screen against screen.** If the target battalion has its own screen out, the two
  screens engage each other man for man, at a quarter of the hit chance (men in
  extended order are hard to hit). Only the surplus skirmishers fire at the formed
  body. Equal screens cancel; the stronger one gets through in proportion.

A French battalion's 96 skirmishers, unopposed, cause roughly 4 casualties a minute.

**Effect** (200 runs each, same seeds):

| Scenario | Off | On |
|---|---|---|
| Pitched battle | Allied 100%, French K/W 17% | Allied 100%, French K/W 17% |
| Column against line | Allied 100%, French loss 12% | Allied 100%, French loss 12% |
| Grand battery | French 99%, 35 min | French 68%, 95 min |

In a quick assault the screens are out for only a few minutes and change nothing
measurable. In the slow grand-battery action they matter: the Allied screens wear
down the French infantry and gun crews in front of the ridge, and the French win far
less often and far more slowly.

Implausible or weak points:
- Skirmishers cannot be hurt by volleys or artillery, only by other skirmishers.
- A screen cannot be ridden down; it always gets in before cavalry arrives.
- The parent battalion fires through its own screen.
- Rifles are not distinguished from muskets.

### 12.4 Unit quality and experience (`quality`)

Parameters: `data/quality.json`. The steadiness values come from the prototype; the
other five columns are assumptions.

Every unit has a quality class. In the baseline the class sets only steadiness `q`
(the multiplier on morale loss) and, through it, starting morale. With the toggle on
the class also scales five other things:

| Class | Steadiness | Fire (hits) | Reload time | Drill time | Melee power | Rally rate |
|---|---|---|---|---|---|---|
| Guard | 0.65 | 1.15 | 0.90 | 0.80 | 1.20 | 1.5 |
| Elite | 0.85 | 1.10 | 0.95 | 0.85 | 1.15 | 1.3 |
| Veteran | 0.95 | 1.05 | 0.97 | 0.90 | 1.05 | 1.15 |
| Line | 1.00 | 1 | 1 | 1 | 1 | 1 |
| Conscript | 1.08 | 0.90 | 1.10 | 1.30 | 0.90 | 0.8 |
| Militia | 1.20 | 0.80 | 1.20 | 1.60 | 0.80 | 0.6 |

Fire applies to musketry and gunnery. Drill time applies to every change of
formation, and so to how early a battalion must start forming square (9.1).

**Effect** (200 runs each, same seeds): no change in who wins the pitched battle or
the column preset, whose rosters are mostly line troops with a few better and worse
battalions on each side. In a stand-up firefight between a guard and a militia
battalion the guard inflicts more than 1.4 times the casualties it takes with the
toggle on, and the two are equal with it off (test `quality.test.ts`).

Implausible or weak points:
- Quality is fixed for the battle; units do not gain or lose it.
- One scale serves infantry, cavalry and gunners alike.

### 12.5 Line of sight and elevation (`elevationLos`)

Parameters: `data/los.json`, and `sightHeight` on each terrain type.

**Line of sight.** A sight line runs from eye height above the ground at one unit's
centre to target height above the ground at the other's (1.7 m on foot, 2.5 m
mounted). It is tested every 20 m. It is blocked if the ground rises above it, or if
it passes through a wood (15 m high) or a farm (8 m) that neither unit is standing
in. A unit in a wood or farm is treated as being at its edge: it sees out and is
seen. Nothing is seen beyond 3,000 m. Each pair is re-tested every 5 s.

What needs a clear line:
- Musketry and artillery: a unit fires only at what it can see.
- Cavalry choosing a target to charge.
- A commander's initiative: he acts only on enemy that some unit of his can see.

What does not: infantry and guns still march toward the enemy and form square
against cavalry as before. The army is assumed to know roughly where the enemy is.

**Slope.** The baseline's flat 0.88 on any slope is replaced by the grade along the
line of march: speed loses 25% per 10% of uphill grade, up to 60%. Level and
downhill movement is not slowed.

**Effect** (200 runs each, same seeds):

| Scenario | Off | On |
|---|---|---|
| Pitched battle (defenders on the crest) | Allied 100%; Allied loss 8%, K/W 3% | Allied 100%; Allied loss 4%, K/W 2% |
| Reverse slope (infantry 130 m behind the crest, guns on it) | Allied 100%; Allied loss 12%, K/W 4%; 19 min | Allied 100%; Allied loss 5%, K/W 2%; 16 min |
| Grand battery | French 99% in 35 min | French 94% in 71 min |

Drawing the infantry behind the crest more than halves its losses once sight lines
are modelled, and does nothing without them. The grand battery takes twice as long
to win, because its guns must find targets they can see.

Implausible or weak points:
- Sight is from centre to centre: a long line partly behind a crest is all seen or all hidden.
- No overhead fire rule: guns fire through friendly units in front of them.
- Units still march on enemy they cannot see.
- Indirect effects of roundshot (bounding over a crest into troops behind) are not modelled.

### 12.6 Smoke (`smoke`)

Parameters: `data/smoke.json`. All assumptions.

A grid of 50 m cells holds smoke density. Density 1 in a cell is a bank that halves
the effect of fire through it.

- **Made by firing.** Each musket fired adds 0.002 and each gun 0.15, spread along
  the firing unit's front just ahead of it. A 500-musket volley adds about 1 in
  total; a six-gun salvo about 0.9.
- **Drift, thinning, spread.** Every 5 s each cell takes the density that was
  upwind of it (wind speed and direction from the scenario's `weather`), loses 0.4%
  per second (half gone in about three minutes; faster in rain, slower in fog when
  the weather feature is on), and exchanges 4% with each neighbour.
- **Effect on fire.** Musketry and artillery are multiplied by
  `1 / (1 + optical depth)`, where optical depth is density summed along the line
  from muzzle to target in units of one cell, plus half the density at the muzzle.
- **Effect on sight.** At optical depth above 4 the target cannot be seen: no fire,
  no cavalry charge, no initiative against it.

**Effect** (200 runs each, same seeds):

| Scenario | Off | On, wind 3 m/s |
|---|---|---|
| Pitched battle | Allied 100%; French K/W 17% | Allied 100%; French K/W 16% |
| Column against line: Allied loss | 2% | 3% |

Column against line with smoke on, by wind speed: Allied loss 4% in still air, 3% at
3 m/s, 2% at 8 m/s. In a ten-minute stand-up firefight at 80 m, fire in still air
does under 70% of the damage it does with no smoke, and a stiff wind restores most
of it (test `smoke-weather.test.ts`).

The effect on these short actions is small: smoke matters in prolonged firefights,
and the presets end before one develops.

Implausible or weak points:
- Smoke has no height: a battery on a hill is blinded by smoke in the valley.
- Cells are 50 m, coarser than a battalion's depth.
- The amounts and the thinning rate are guesses with no measurement behind them.

### 12.7 Weather and ground (`weatherGround`)

Parameters: `data/weather.json`. The scenario's `weather` block names the sky
(clear, rain, heavy_rain, fog), the ground (firm, soft, mud, frozen) and the wind.
The directions of these effects are well attested; every size is an assumption.

| Sky | Musketry hits | Limit of sight | Smoke thinning |
|---|---|---|---|
| Clear | 1 | 3,000 m | 1 |
| Rain | 0.6 | 1,500 m | 1.5 |
| Heavy rain | 0.25 | 600 m | 2 |
| Fog | 1 | 300 m | 0.7 |

| Ground | Infantry speed | Cavalry speed | Gun speed | Roundshot effect | Marching fatigue |
|---|---|---|---|---|---|
| Firm | 1 | 1 | 1 | 1 | 1 |
| Soft | 0.92 | 0.85 | 0.7 | 0.75 | 1.25 |
| Mud | 0.8 | 0.7 | 0.45 | 0.5 | 1.6 |
| Frozen | 1 | 0.9 | 1 | 1.15 | 1 |

Cavalry speed also applies to charges and to couriers. The roundshot factor stands
for the ball burying itself instead of bounding on; canister is unaffected. The
limit of sight applies to fire, to cavalry choosing targets and to initiative,
whether or not the elevation feature is on.

**Effect** (200 runs each, same seeds, feature on):

| Scenario | Condition | Result |
|---|---|---|
| Grand battery | firm, mud | French win 99%, 3% |
| Pitched battle | firm, soft, mud | Allied 100% throughout; 15.4, 16.2, 18.6 min |
| Column against line | clear, rain, heavy rain | French win 0%, 0%, 4%; Allied loss 2%, 5%, 10% |
| Pitched battle | fog | Allied win on the objective in 47 min; French lose 6 of 12 units one at a time; Allied casualties nil |

Mud all but cancels the grand battery, which is the Waterloo lesson. Heavy rain is
the only condition found so far in which columns ever beat lines.

Implausible or weak points:
- Rain does not make squares vulnerable to cavalry, as it did historically, because
  cavalry in this model never charges a steady square.
- In fog the attackers walk into canister one battalion at a time and their own guns
  never fire; no one waits for the fog to lift.
- Weather is constant for the whole action.
