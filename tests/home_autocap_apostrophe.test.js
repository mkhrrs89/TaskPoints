const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const match = source.match(/function capitalizeWords\(value\) \{[\s\S]*?\n\}/);
if (!match) throw new Error('capitalizeWords helper not found in index.html');

const context = { String };
vm.runInNewContext(match[0], context, { filename: 'capitalizeWords.js' });

test('auto-capitalization keeps apostrophe suffixes lowercase', () => {
  assert.equal(context.capitalizeWords("order wyla's food"), "Order Wyla's Food");
  assert.equal(context.capitalizeWords("don't forget milk"), "Don't Forget Milk");
  assert.equal(context.capitalizeWords("player's next game"), "Player's Next Game");
  assert.equal(context.capitalizeWords("wyla’s food"), "Wyla’s Food");
});

test('auto-capitalization still capitalizes ordinary new words', () => {
  assert.equal(context.capitalizeWords('buy dog food tomorrow'), 'Buy Dog Food Tomorrow');
  assert.equal(context.capitalizeWords('clean-up kitchen'), 'Clean-Up Kitchen');
  assert.equal(context.capitalizeWords('call mom / schedule vet'), 'Call Mom / Schedule Vet');
});

test('shared helper remains attached to Task, Habit, and Vice name inputs', () => {
  assert.match(
    source,
    /\['titleInput', 'habitName', 'viceName'\]\.forEach\(\(id\) => \{\s*applyCapitalizeWordsInput\(\$\(id\)\);/
  );
});
