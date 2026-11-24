// The breeding page's cards: dates, links and escaping (site/breeding.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  breedingCards, dueParts, pedigreeLink, scheduleYear, kiddingsLabel, loadKiddingsLabel, loadBreeding,
} from '../../site/breeding.js';
import { headerInner, footerInner } from '../../site/chrome.js';

const goats = [
  { id: 'cookie', name: 'Cookie', reg: 'D002298033', hero: { src: 'a.jpg', thumb: 'thumbs/a.jpg' } },
  { id: 'polaris', name: 'Polaris', reg: 'D002464894', hero: null },
];

test('due dates split into day and month', () => {
  assert.deepEqual(dueParts('2026-04-08'), { d: '8', m: 'April 2026' });
  assert.equal(dueParts('nonsense'), null);
});

test('pedigree link needs both numbers and ignores spaces', () => {
  assert.equal(pedigreeLink('D002464894', 'D002298033'),
    'https://genetics.adga.org/PlannedPedigreePrint.aspx?SireNum=D002464894&DamNum=D002298033');
  assert.equal(pedigreeLink('PD 2517293', 'D1').includes('PD2517293'), true);
  assert.equal(pedigreeLink('', 'D1'), '');
});

test('a linked doe shows her photo, page link and a pedigree from her herd numbers', () => {
  const html = breedingCards([{ doe_id: 'cookie', doe_name: 'Cookies & Cream', sire_id: 'polaris', sire_name: 'Polaris',
    freshening: '2F', due_on: '2026-04-08', status: 'planned' }], goats);
  assert.match(html, /href="\/goats\/cookie\.html"/);
  assert.match(html, /<img src="\/thumbs\/a\.jpg"/);
  assert.match(html, /Cookies &amp; Cream/);
  assert.match(html, /SireNum=D002464894&amp;DamNum=D002298033/);
  assert.match(html, /<span class="chip">2F<\/span>/);
});

test('names typed by hand are escaped, and an unlinked doe has no link', () => {
  const html = breedingCards([{ doe_name: '<script>x</script>', sire_name: 'Outside "Buck"', due_on: '2026-05-01', status: 'planned' }], goats);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('/goats/'));
  assert.ok(!html.includes('Pedigree'));
});

test('kidded pairings show what was born; an empty list says so', () => {
  const html = breedingCards([{ doe_name: 'A', sire_name: 'B', due_on: '2026-05-01', status: 'kidded', outcome: '2 doelings' }], goats);
  assert.match(html, /Kidded: <strong>2 doelings<\/strong>/);
  assert.match(breedingCards([], goats), /No pairings are scheduled/);
});

// ---- the menu's year follows the schedule --------------------------------------

/** A real breedings table (the production schema) behind the D1 calls the site uses. */
function breedingsDb(t, pairings = []) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  let n = 0;
  const add = (due_on, { status = 'planned', show = 1 } = {}) => {
    sqlite.prepare('INSERT INTO breedings (id, doe_name, sire_name, due_on, status, show, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('b' + n++, 'Doe', 'Buck', due_on, status, show, '2026-01-01', '2026-01-01');
  };
  for (const [due_on, extra] of pairings) add(due_on, extra);
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return statement.get(...args) || null; },
        async all() { return { results: statement.all(...args) }; },
      };
    },
  };
  return { DB, add };
}

test('the schedule year is the latest due-date year, ignoring junk', () => {
  assert.equal(scheduleYear([{ due_on: '2026-04-08' }, { due_on: '2026-05-01' }]), 2026);
  assert.equal(scheduleYear([{ due_on: '2026-12-30' }, { due_on: '2027-01-04' }]), 2027);
  assert.equal(scheduleYear([{ due_on: 'soon' }, { due_on: '' }, {}]), null);
  assert.equal(scheduleYear([]), null);
  assert.equal(scheduleYear(null), null);
});

test('the label carries the year, or none when there is no schedule', () => {
  assert.equal(kiddingsLabel(2027), '2027 Kiddings');
  assert.equal(kiddingsLabel(null), 'Kiddings');
});

test('the menu and footer both show the label they are given', () => {
  assert.match(headerInner('/', '2027 Kiddings'), /<a href="\/breeding\.html">2027 Kiddings<\/a>/);
  assert.match(footerInner('2027 Kiddings'), /<a href="\/breeding\.html">2027 Kiddings<\/a>/);
  // With nothing to go on, no year is better than last year's.
  assert.match(headerInner('/'), /<a href="\/breeding\.html">Kiddings<\/a>/);
  assert.match(footerInner(), /<a href="\/breeding\.html">Kiddings<\/a>/);
  assert.ok(!/2026/.test(headerInner('/') + footerInner()));
  // The breeding page is marked as the current page in the menu.
  assert.match(headerInner('/breeding.html', '2027 Kiddings'), /<a href="\/breeding\.html" aria-current="page">2027 Kiddings<\/a>/);
});

test('the menu year moves on when next year\u2019s pairings are added', async (t) => {
  const env = breedingsDb(t, [['2026-04-08'], ['2026-05-01']]);
  assert.equal(await loadKiddingsLabel(env), '2026 Kiddings');
  env.add('2027-04-20'); // the farm adds next spring's first pairing in the admin
  assert.equal(await loadKiddingsLabel(env), '2027 Kiddings');
});

test('hidden and skipped pairings do not set the year', async (t) => {
  const env = breedingsDb(t, [['2026-04-08'], ['2027-04-20', { show: 0 }], ['2027-05-02', { status: 'skipped' }]]);
  assert.equal(await loadKiddingsLabel(env), '2026 Kiddings');
});

test('with no pairings shown the menu has no year at all', async (t) => {
  assert.equal(await loadKiddingsLabel(breedingsDb(t, [])), 'Kiddings');
  assert.equal(await loadKiddingsLabel(breedingsDb(t, [['2026-04-08', { show: 0 }]])), 'Kiddings');
});

test('an unreadable database drops the year instead of failing the page', async () => {
  const broken = { DB: { prepare() { throw new Error('D1 is down'); } } };
  const log = console.error;
  console.error = () => {};
  try { assert.equal(await loadKiddingsLabel(broken), 'Kiddings'); } finally { console.error = log; }
});

test('the breeding page and the menu agree on which pairings count', async (t) => {
  const env = breedingsDb(t, [['2026-04-08'], ['2027-04-20'], ['2028-04-01', { show: 0 }]]);
  const page = await loadBreeding(env);
  assert.equal(kiddingsLabel(scheduleYear(page.rows)), await loadKiddingsLabel(env));
  assert.equal(await loadKiddingsLabel(env), '2027 Kiddings');
});
