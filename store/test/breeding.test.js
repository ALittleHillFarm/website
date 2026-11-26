// The breeding page's cards: dates, links and escaping (site/breeding.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  breedingCards, dueParts, pedigreeLink, scheduleYear, kiddingsLabel, loadKiddingsLabel, loadBreeding,
  currentKiddings, kiddingsDueLabel, kiddingsTiles, dueShort, withScheduleFacts,
} from '../../site/breeding.js';
import { normalize, rosterArticle, goatPageBody } from '../../site/goats.js';
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
  const add = (due_on, { status = 'planned', show = 1, doe = 'Doe', buck = 'Buck', doe_id = null, sire_id = null } = {}) => {
    sqlite.prepare('INSERT INTO breedings (id, doe_id, doe_name, sire_id, sire_name, due_on, status, show, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('b' + n++, doe_id, doe, sire_id, buck, due_on, status, show, '2026-01-01', '2026-01-01');
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

// ---- the home page's kiddings: count, year and grid ----------------------------

const herd = [
  { id: 'cookie', name: 'Cookie' },
  { id: 'calypso', name: 'Calypso' },
  { id: 'maple-sugar', name: 'Maple Sugar' },
  { id: 'royal-tea', name: 'Royal Tea' },
  { id: 'toby', name: 'Toby', registered_name: 'Amores Farm Time Will Tell' },
  { id: 'polaris', name: 'Polaris' },
];

test('the stat label carries the year, or none when there is nothing to show', () => {
  assert.equal(kiddingsDueLabel(2027), 'Kiddings due 2027');
  assert.equal(kiddingsDueLabel(null), 'Kiddings due');
});

test('due dates read as "April 8" on the home grid', () => {
  assert.equal(dueShort('2026-04-08'), 'April 8');
  assert.equal(dueShort('2027-12-30'), 'December 30');
  assert.equal(dueShort('soon'), 'soon');
  assert.equal(dueShort(''), '');
});

test('herd goats go by their short name, outside ones as typed', () => {
  const html = kiddingsTiles([
    { doe_id: 'cookie', doe_name: 'DLMG Farms JM Cookies & Cream', sire_id: 'toby', sire_name: 'Amores Farm Time Will Tell', due_on: '2026-04-08' },
    { doe_id: 'gone', doe_name: 'Sold Doe', sire_id: null, sire_name: 'Outside Buck', due_on: '2026-05-01' },
  ], herd);
  assert.match(html, /<div class="eyebrow">Due April 8<\/div>/);
  assert.match(html, />Cookie <span[^>]*>×<\/span> Toby</);
  assert.ok(!html.includes('Amores Farm'), 'a linked buck shows his short name, not his registered one');
  // A doe who has left the herd (or never was in it) is shown as typed.
  assert.match(html, />Sold Doe <span[^>]*>×<\/span> Outside Buck</);
  assert.equal((html.match(/href="\/breeding\.html"/g) || []).length, 2);
});

test('names typed in the admin are escaped on the home grid, and the herd may be missing', () => {
  const html = kiddingsTiles([{ doe_id: 'cookie', doe_name: '<b>Cookie</b> & Co', sire_name: 'X"Y', due_on: '2026-04-08' }], null);
  assert.ok(!html.includes('<b>'));
  assert.match(html, /&lt;b&gt;Cookie&lt;\/b&gt; &amp; Co/);
  assert.match(html, /X&quot;Y/);
});

test('with no pairings the home grid says so instead of listing any', () => {
  const html = kiddingsTiles([], herd);
  assert.match(html, /No pairings are scheduled right now\. Check back soon\./);
  assert.ok(!html.includes('eyebrow'));
});

test('the home page shows only the schedule year’s pairings, and ignores hidden and skipped ones', async (t) => {
  const env = breedingsDb(t, [['2026-04-08'], ['2026-05-01']]);
  let cur = currentKiddings((await loadBreeding(env)).rows);
  assert.equal(cur.year, 2026);
  assert.equal(cur.rows.length, 2);

  // Next spring's pairings go in; last spring's stay on the breeding page but not in the count.
  env.add('2027-04-20', { doe: 'Cookie', buck: 'Toby' });
  env.add('2027-05-02', { show: 0 });
  env.add('2027-05-03', { status: 'skipped' });
  const page = await loadBreeding(env);
  assert.equal(page.rows.length, 3);
  cur = currentKiddings(page.rows);
  assert.equal(cur.year, 2027);
  assert.deepEqual(cur.rows.map((r) => r.due_on), ['2027-04-20']);
  assert.equal(kiddingsDueLabel(cur.year), 'Kiddings due 2027');
});

test('kidded pairings still count towards the year they were due', async (t) => {
  const env = breedingsDb(t, [['2026-04-08', { status: 'kidded' }], ['2026-05-01', { status: 'bred' }]]);
  assert.equal(currentKiddings((await loadBreeding(env)).rows).rows.length, 2);
});

test('with nothing shown the home page has no year and a count of zero', async (t) => {
  for (const env of [breedingsDb(t, []), breedingsDb(t, [['2026-04-08', { show: 0 }], ['2026-05-01', { status: 'skipped' }]])]) {
    const cur = currentKiddings((await loadBreeding(env)).rows);
    assert.deepEqual(cur, { year: null, rows: [] });
    assert.equal(kiddingsDueLabel(cur.year), 'Kiddings due');
  }
  assert.deepEqual(currentKiddings(null), { year: null, rows: [] });
  assert.deepEqual(currentKiddings([{ due_on: 'soon' }]), { year: null, rows: [] });
});

test('the home page, the breeding page and the menu all agree on the year', async (t) => {
  const env = breedingsDb(t, [['2026-04-08'], ['2027-04-20'], ['2028-04-01', { show: 0 }]]);
  const page = await loadBreeding(env);
  assert.equal(currentKiddings(page.rows).year, scheduleYear(page.rows));
  assert.equal(kiddingsLabel(currentKiddings(page.rows).year), await loadKiddingsLabel(env));
});

test('the home page carries every marker the worker fills (it cannot be run in Node, so guard the contract)', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  for (const marker of ['data-count="kiddings-n"', 'data-count="kiddings-due"', 'data-count="kiddings-label"', 'data-breedings="home"']) {
    assert.equal(html.split(marker).length - 1, 1, `${marker} appears exactly once`);
  }
  // The fallback is self-consistent: its count is the number of its cards.
  const grid = html.split('data-breedings="home"')[1].split('</section>')[0];
  const n = +/data-count="kiddings-n">(\d+)</.exec(html)[1];
  assert.equal((grid.match(/<div class="eyebrow">Due /g) || []).length, n);
});

// ---- a buck's "Breeding to <year>" fact comes from the schedule ----------------

/** A buck as the site loads him, with the facts typed on him in the admin. */
const buckRow = (id, name, facts) => normalize({
  id, sort: 10, status: 'active', template: 'buck', registry: null,
  data: JSON.stringify({ name, registered_name: name + ' Registered', dob: '2025-04-17', facts }),
});
const handTyped = [
  { label: 'Breeding to 2026', value: 'Maple Sugar' },
  { label: 'Temperament', value: 'Friendly' },
];
const factsOf = (g) => g.facts.map((f) => [f.label, f.value]);

async function season2026(t) {
  const env = breedingsDb(t, []);
  env.add('2026-04-08', { doe_id: 'cookie', doe: 'DLMG Farms JM Cookies & Cream', sire_id: 'polaris', buck: 'TUA Farms BB Polaris' });
  env.add('2026-04-09', { doe_id: 'calypso', sire_id: 'polaris' });
  env.add('2026-04-30', { doe_id: 'maple-sugar', sire_id: 'toby' });
  env.add('2026-05-01', { doe_id: 'royal-tea', sire_id: 'polaris' });
  return env;
}

test('each buck lists the does paired to him this year, by short name, in due-date order', async (t) => {
  const rows = (await loadBreeding(await season2026(t))).rows;
  const polaris = withScheduleFacts(buckRow('polaris', 'Polaris', []), rows, herd);
  assert.deepEqual(factsOf(polaris), [['Breeding to 2026', 'Cookie · Calypso · Royal Tea']]);
  const toby = withScheduleFacts(buckRow('toby', 'Toby', []), rows, herd);
  assert.deepEqual(factsOf(toby), [['Breeding to 2026', 'Maple Sugar']]);
});

test('a typed "Breeding to" fact is replaced, and the buck’s other facts are kept', async (t) => {
  const rows = (await loadBreeding(await season2026(t))).rows;
  const toby = withScheduleFacts(buckRow('toby', 'Toby', [...handTyped, { label: '  breeding TO 2025', value: 'Old' }]), rows, herd);
  assert.deepEqual(factsOf(toby), [['Temperament', 'Friendly'], ['Breeding to 2026', 'Maple Sugar']]);
});

test('next year’s pairings move the row on; a buck with none this year has no row', async (t) => {
  const env = await season2026(t);
  env.add('2027-03-30', { doe_id: 'cookie', sire_id: 'toby' });
  const rows = (await loadBreeding(env)).rows;
  assert.deepEqual(factsOf(withScheduleFacts(buckRow('toby', 'Toby', handTyped), rows, herd)),
    [['Temperament', 'Friendly'], ['Breeding to 2027', 'Cookie']]);
  // Polaris has no 2027 pairing: no row at all, and last season's typed fact is not left behind.
  assert.deepEqual(factsOf(withScheduleFacts(buckRow('polaris', 'Polaris', handTyped), rows, herd)),
    [['Temperament', 'Friendly']]);
});

test('hidden and skipped pairings are left out, a repeat doe is named once, and an outside doe is named as typed', async (t) => {
  const env = breedingsDb(t, []);
  env.add('2026-04-08', { doe_id: 'cookie', sire_id: 'toby' });
  env.add('2026-04-20', { doe_id: 'cookie', sire_id: 'toby' });
  env.add('2026-04-21', { doe_id: 'calypso', sire_id: 'toby', show: 0 });
  env.add('2026-04-22', { doe_id: 'royal-tea', sire_id: 'toby', status: 'skipped' });
  env.add('2026-05-01', { doe: 'Doe From Away', sire_id: 'toby' });
  env.add('2026-05-02', { doe: 'Typed Buck Only', buck: 'Toby' }); // no sire_id: not matched to him
  const toby = withScheduleFacts(buckRow('toby', 'Toby', []), (await loadBreeding(env)).rows, herd);
  assert.deepEqual(factsOf(toby), [['Breeding to 2026', 'Cookie · Doe From Away']]);
});

test('does are left alone, and an unreadable schedule leaves the typed facts as they were', async (t) => {
  const rows = (await loadBreeding(await season2026(t))).rows;
  const doe = normalize({ id: 'cookie', sort: 1, status: 'active', template: 'doe', registry: null,
    data: JSON.stringify({ name: 'Cookie', facts: handTyped }) });
  assert.equal(withScheduleFacts(doe, rows, herd), doe);
  const toby = buckRow('toby', 'Toby', handTyped);
  assert.equal(withScheduleFacts(toby, null, herd), toby);
  // A schedule that was read but is empty clears the row rather than keep a stale one.
  assert.deepEqual(factsOf(withScheduleFacts(toby, [], herd)), [['Temperament', 'Friendly']]);
});

test('the Bucks roster card and the buck’s own page both show the generated row, escaped', async (t) => {
  const env = breedingsDb(t, []);
  env.add('2027-03-30', { doe_id: 'cookie', sire_id: 'toby' });
  env.add('2027-04-12', { doe: '<b>Away</b> & Co', sire_id: 'toby' });
  const toby = withScheduleFacts(buckRow('toby', 'Toby', handTyped), (await loadBreeding(env)).rows, herd);
  for (const html of [rosterArticle(toby), goatPageBody(toby)]) {
    assert.match(html, /<div class="label">Breeding to 2027<\/div><div class="v">Cookie · &lt;b&gt;Away&lt;\/b&gt; &amp; Co<\/div>/);
    assert.ok(!html.includes('2026'), 'last season’s typed fact is gone');
    assert.match(html, /Temperament/);
  }
});
