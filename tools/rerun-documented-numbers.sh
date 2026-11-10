#!/bin/bash
# Re-runs every batch quoted in MODEL.md and CALIBRATION.md and writes the output to out/regen/*.txt.
# Run it after any change to the engine or the data, and update the documents from what it prints.
# Takes about 40 minutes on four cores. Needs a POSIX shell (Git Bash on Windows).
cd "$(dirname "$0")/.."
mkdir -p out/regen
N="npx tsx packages/cli/src/main.ts"
O=out/regen
F='grep -v "first to break\|root cause\|^wrote\|fixed:"'
PROTO="--set data:morale.casualtyShock=1 --set data:morale.routRecoveryRate=0.86"
{
for s in pitched column squares battery counter; do echo "## $s current"; $N batch scenarios/$s.json --runs 200 | eval $F; done
for s in pitched column squares battery counter; do echo "## $s prototype-values"; $N batch scenarios/$s.json --runs 200 $PROTO | eval $F; done
echo "## pitched A-only"; $N batch scenarios/pitched.json --runs 200 --set data:morale.routRecoveryRate=0.86 | eval $F
} > $O/11-presets.txt 2>&1
{
echo "## canister pitched"; $N sweep scenarios/pitched.json --runs 200 --param 'data:weapons.guns.field_8pdr.canisterBattlefieldFactor=0.025,0.05,0.1,0.2'
echo "## musket both pitched"; $N sweep scenarios/pitched.json --runs 200 --param 'data:weapons.muskets.brown_bess.battlefieldFactor=0.02,0.04,0.08' --set data:weapons.muskets.charleville_1777.battlefieldFactor=0.04 | grep -v "^    "
echo "## musket defender column"; $N sweep scenarios/column.json --runs 200 --param 'data:weapons.muskets.brown_bess.battlefieldFactor=0.01,0.02,0.04,0.08'
echo "## casualtyShock pitched"; $N sweep scenarios/pitched.json --runs 200 --param 'data:morale.casualtyShock=1,2,3,4,6'
echo "## ripple pitched"; $N sweep scenarios/pitched.json --runs 200 --param 'data:morale.rippleFriend=0,7,14,21' | grep -v "^    "
echo "## blown pitched"; $N sweep scenarios/pitched.json --runs 200 --param 'data:melee.blownTime=60,300,900' | grep -v "^    "
echo "## french batteries pitched"; $N sweep scenarios/pitched.json --runs 200 --param 'scenario:sides.french.deploy.art=0..6..2' | grep -v "^    "
echo "## french battalions column"; $N sweep scenarios/column.json --runs 200 --param 'scenario:sides.french.deploy.inf=4..12..2' | grep -v "^    allied"
echo "## posture pitched"; $N sweep scenarios/pitched.json --runs 200 --param 'scenario:sides.french.posture=attack_line,attack_column'
} > $O/11-sweeps.txt 2>&1
{
for s in pitched column counter; do echo "## C2 $s"; $N sweep scenarios/$s.json --runs 200 --param 'scenario:features.commandControl=false,true'; done
echo "## pitched-orders"; $N batch scenarios/pitched-orders.json --runs 200 | eval $F
echo "## pitched-orders delays"; $N sweep scenarios/pitched-orders.json --runs 200 --param 'data:command.staffDelayCorps=30,240,900' --param 'data:command.courierSpeed=2,5' | grep -v "^    "
echo "## pitched-orders log seed 2"; $N run scenarios/pitched-orders.json --seed 2 --log | grep "order \|acts on" | head -14
for s in pitched battery pitched-orders; do echo "## fatigue x ammo $s"; $N sweep scenarios/$s.json --runs 200 --param 'scenario:features.fatigue=false,true' --param 'scenario:features.ammunition=false,true'; done
for s in pitched column battery; do echo "## skirmishers $s"; $N sweep scenarios/$s.json --runs 200 --param 'scenario:features.skirmishers=false,true'; done
for s in pitched column; do echo "## quality $s"; $N sweep scenarios/$s.json --runs 200 --param 'scenario:features.quality=false,true'; done
for s in pitched reverse-slope battery; do echo "## los $s"; $N sweep scenarios/$s.json --runs 200 --param 'scenario:features.elevationLos=false,true'; done
for s in pitched column; do echo "## smoke $s"; $N sweep scenarios/$s.json --runs 200 --param 'scenario:features.smoke=false,true'; done
echo "## smoke wind column"; $N sweep scenarios/column.json --runs 200 --set scenario:features.smoke=true --param 'scenario:weather.windSpeed=0,3,8' | grep -v "^    french"
echo "## ground battery"; $N sweep scenarios/battery.json --runs 200 --set scenario:features.weatherGround=true --param 'scenario:weather.ground=firm,mud'
echo "## ground pitched"; $N sweep scenarios/pitched.json --runs 200 --set scenario:features.weatherGround=true --param 'scenario:weather.ground=firm,soft,mud' | grep -v "^    "
echo "## sky column"; $N sweep scenarios/column.json --runs 200 --set scenario:features.weatherGround=true --param 'scenario:weather.sky=clear,rain,heavy_rain,fog'
echo "## fog pitched"; $N batch scenarios/pitched.json --runs 200 --set scenario:features.weatherGround=true --set scenario:weather.sky=fog | eval $F
} > $O/12-features.txt 2>&1
{
echo "## derlon massed 100"; $N batch scenarios/derlon.json --runs 100 --out out/regen/derlon | grep "wins\|end reasons"; node tools/derlon-report.mjs out/regen/derlon
echo "## derlon ordinary 100"; $N batch scenarios/derlon-ordinary-columns.json --runs 100 --out out/regen/derlon-ord | grep "wins\|end reasons"; node tools/derlon-report.mjs out/regen/derlon-ord
echo "## derlon canister sweep (both gun types), massed, 100 runs"
for f in 0.1 0.05 0.025; do echo "# factor $f"; $N batch scenarios/derlon.json --runs 100 --set data:weapons.guns.field_8pdr.canisterBattlefieldFactor=$f --set data:weapons.guns.heavy_12pdr.canisterBattlefieldFactor=$f --out out/regen/derlon-can-$f | grep "wins"; node tools/derlon-report.mjs out/regen/derlon-can-$f | grep "ridge held\|French infantry (\|Kempt\|Union Brigade  \|routs by top"; done
echo "## derlon ablation, massed, 100 runs"
for f in commandControl fatigue ammunition skirmishers quality elevationLos smoke weatherGround; do echo "# without $f"; $N batch scenarios/derlon.json --runs 100 --set scenario:features.$f=false --out out/regen/derlon-no-$f | grep "wins"; node tools/derlon-report.mjs out/regen/derlon-no-$f | grep "ridge held\|French infantry (\|Bijlandt\|Kempt\|Union Brigade  "; done
} > $O/derlon.txt 2>&1
echo ALL_DONE > $O/done.txt
