// The breeding page's cards: dates, links and escaping (site/breeding.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { breedingCards, dueParts, pedigreeLink } from '../../site/breeding.js';

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
