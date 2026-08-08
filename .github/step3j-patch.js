const fs = require('node:fs');

const target = 'you_score_alias_alignment.js';
let source = fs.readFileSync(target, 'utf8');

const marker = "  let nonHomeAliasRepairScheduled = false;\n";
if (!source.includes(marker)) throw new Error('nonHome schedule marker not found');
source = source.replace(marker, `${marker}  const NON_HOME_ALIAS_REPAIR_DELAY_MS = 14000;\n`);

const pattern = /  function scheduleNonHomeAliasRepair\(reason = 'background'\) \{[\s\S]*?\n  \}\n\n  function populated/;
if (!pattern.test(source)) throw new Error('scheduleNonHomeAliasRepair block not found');
source = source.replace(pattern, `  function scheduleNonHomeAliasRepair(reason = 'background') {
    if (nonHomeAliasRepairScheduled) return true;
    nonHomeAliasRepairScheduled = true;
    const run = () => {
      nonHomeAliasRepairScheduled = false;
      return repairPersistedState();
    };
    const useGateOrRun = () => {
      const gate = core.whenStorageMaintenanceQuiet;
      return typeof gate === 'function'
        ? gate(run, { reason: \`you_score_alias_alignment_\${reason}\` })
        : run();
    };
    const scheduleGate = () => {
      Promise.resolve(useGateOrRun()).catch(() => { nonHomeAliasRepairScheduled = false; });
    };

    // This repair can require a full canonical snapshot rewrite. Do not let a
    // short visit to a game page become eligible for that work merely because
    // the user paused briefly before navigating again. After the eligibility
    // delay, the shared quiet gate still re-checks interaction/navigation state.
    if (typeof global.setTimeout === 'function') {
      global.setTimeout(scheduleGate, NON_HOME_ALIAS_REPAIR_DELAY_MS);
    } else {
      scheduleGate();
    }
    return true;
  }

  function populated`);

fs.writeFileSync(target, source);

fs.writeFileSync('tests/step3j_alias_repair_delay.test.js', `const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../you_score_alias_alignment.js'), 'utf8');

test('non-Home persisted alias repair has a long eligibility delay before the quiet gate', () => {
  assert.match(source, /const NON_HOME_ALIAS_REPAIR_DELAY_MS = 14000;/);
  assert.match(source, /global\\.setTimeout\\(scheduleGate, NON_HOME_ALIAS_REPAIR_DELAY_MS\\)/);
  assert.match(source, /const gate = core\\.whenStorageMaintenanceQuiet;/);
  assert.match(source, /gate\\(run, \\{ reason: \\`you_score_alias_alignment_\\$\\{reason\\}\\` \\}\\)/);
});

test('the delayed job still performs the same persisted repair rather than removing it', () => {
  assert.match(source, /const run = \\(\\) => \\{[\\s\\S]*return repairPersistedState\\(\\);[\\s\\S]*\\};/);
  assert.match(source, /function repairPersistedState\\(options = \\{\\}\\)/);
  assert.match(source, /savePath: 'you-score-alias-alignment-repair'/);
});
`);
