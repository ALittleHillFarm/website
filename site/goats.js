/**
 * Goat pages, rosters and herd cards — rendered from the `goats` table in D1.
 *
 * The farm edits goats in the store's admin screen (Goats tab); this file
 * turns those rows into HTML when a page is requested, so an edit is live
 * on the next page load with no build or deploy.
 *
 * The rule throughout: a section renders only when it has real data. Nothing
 * prints a placeholder. A doe with no production record simply has no
 * production section.
 *
 * Row shape (see store/schema.sql):
 *   id, sort, status ('active' | 'hidden'), template ('doe' | 'buck'),
 *   data      farm-written JSON — see normalize() for every field
 *   registry  ADGA data harvested from genetics.adga.org, or NULL
 */
import { esc } from './chrome.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

export async function loadGoats(env, { includeHidden = false } = {}) {
  const sql = 'SELECT * FROM goats' + (includeHidden ? '' : " WHERE status = 'active'") +
    ' ORDER BY sort, id';
  const rows = (await env.DB.prepare(sql).all()).results || [];
  return rows.map(normalize);
}

export async function loadGoat(env, id) {
  const row = await env.DB.prepare("SELECT * FROM goats WHERE id = ? AND status = 'active'")
    .bind(id).first();
  return row ? normalize(row) : null;
}

/** A D1 row -> one plain object with every field present. */
export function normalize(row) {
  const d = safeJSON(row.data) || {};
  const photo = (p) => (p && p.src ? { src: p.src, thumb: p.thumb || '', caption: p.caption || '', alt: p.alt || '' } : null);
  const ped = d.pedigree || {};
  return {
    id: row.id,
    sort: row.sort,
    status: row.status,
    template: row.template === 'buck' ? 'buck' : 'doe',
    name: d.name || row.id,
    registered_name: d.registered_name || '',
    dob: d.dob || '',
    reg: d.reg || '',
    alpha_s1_casein: d.alpha_s1_casein || '',
    colour: d.colour || '',
    height: d.height || '',
    dna_on_file: !!d.dna_on_file,
    badge: d.badge || '',
    badge_tone: d.badge_tone === 'rust' ? 'rust' : '',
    blurb: d.blurb || '',
    hero: photo(d.hero),
    gallery: (d.gallery || []).map(photo).filter(Boolean),
    elite: d.elite && (d.elite.year || d.elite.percentile) ? d.elite : null,
    pedigree: { sire: ped.sire || '', dam: ped.dam || '', ss: ped.ss || '', sd: ped.sd || '', ds: ped.ds || '', dd: ped.dd || '' },
    parents: (d.parents || []).filter((p) => p && (p.name || (p.photos || []).length)).map((p) => ({
      who: p.who || '', name: p.name || '', credit: p.credit || '',
      lines: (p.lines || []).filter((l) => String(l).trim()),
      photos: (p.photos || []).map(photo).filter(Boolean),
    })),
    facts: (d.facts || []).filter((f) => f && f.label && f.value),
    sections: (d.sections || []).filter((s) => s && s.title && (s.paragraphs || []).some((t) => String(t).trim())),
    registry: safeJSON(row.registry),
  };
}

function safeJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const commas = (v) => {
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) && String(n) === String(v).trim() ? n.toLocaleString('en-US') : v;
};

/** '2022-04-06' -> 'April 6, 2022'. Falls back to the registry's '4/6/2022'. */
export function dobText(g) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(g.dob || '');
  if (m) return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
  const r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((g.registry && g.registry.dob) || '');
  if (r) return `${MONTHS[+r[1] - 1]} ${+r[2]}, ${r[3]}`;
  return '';
}

function dobYearMonth(g) {
  const t = dobText(g);
  const m = /^(\w+) \d+, (\d{4})$/.exec(t);
  return m ? { month: m[1], year: m[2] } : null;
}

export function kindLine(g) {
  const ym = dobYearMonth(g);
  const kind = g.template === 'buck' ? 'Buck' : 'Doe';
  return ym ? `${kind} · Born ${ym.month} ${ym.year}` : kind;
}

/** The one-line caption under a herd card on the home page. */
export function cardLine(g) {
  if (g.elite && g.elite.year) return `ADGA Elite ${g.elite.year}`;
  const ym = dobYearMonth(g);
  return ym ? `Born ${ym.year}` : (g.template === 'buck' ? 'Herdsire' : 'Doe');
}

// Short words that ADGA shouts but are words, not a farm's initials.
// Everything else of three letters or fewer stays capitalised ("TS", "SCC").
const WORDS = new Set(('OAK OLD FAT SIX TO GO OF THE AND IN ON AT MY BIG RED SUN SKY BAY DAY JOY ONE TWO TEN ' +
  'HOT ICE TEA PIE BOW TIE MAX ACE ART BOB DOT FOX JAM KIT LEO LOU MAE MAY MIA ROY SAM TOM ZOE BEE GEM ' +
  'OWL PAL POP RAY SHE HER HIS NOT YES BY UP OUT NEW MR MRS MS DR LIL MAC').split(' '));

/** ADGA stores names shouting. 'OAK APPLE HECTOR' -> 'Oak Apple Hector'. */
export function titlecaseName(n) {
  if (!n) return n;
  const out = n.split(/\s+/).map((w) => {
    const letters = w.replace(/[^A-Za-z]/g, '');
    const keep = /[\d*+]/.test(w) || (letters.length <= 3 && !WORDS.has(letters.toUpperCase()));
    return keep ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
  return out.replace(/\bd'(\w)/g, (_, c) => "D'" + c.toUpperCase());
}

export const adgaLink = (reg) => `https://genetics.adga.org/GoatDetail.aspx?RegNumber=${encodeURIComponent(reg)}`;
export const goatHref = (g) => `/goats/${g.id}.html`;

const src = (p) => (p.src.startsWith('/') || /^https?:/.test(p.src) ? p.src : '/' + p.src);
const small = (p) => (p.thumb ? (p.thumb.startsWith('/') ? p.thumb : '/' + p.thumb) : src(p));

/** An image shown small (cards, rosters, avatars): the thumbnail when there is one. */
function smallImg(p, alt, extra = '') {
  return `<img src="${esc(small(p))}" alt="${esc(alt)}"${extra}>`;
}

/** A small image that opens the full photo — see the lightbox in site.js. */
function zoomImg(p, alt) {
  return `<a class="zoom" href="${esc(src(p))}">${smallImg(p, alt)}</a>`;
}

function sire(g) { return g.pedigree.sire || titlecaseName((g.registry || {}).sire) || ''; }
function dam(g) { return g.pedigree.dam || titlecaseName((g.registry || {}).dam) || ''; }
function dnaOnFile(g) { return g.dna_on_file || !!(g.registry && g.registry.dna_on_file); }

// ---------------------------------------------------------------------------
// goat page sections — each returns '' when it has nothing real to show
// ---------------------------------------------------------------------------

function secHero(g) {
  const badge = g.badge
    ? `<div style="margin-bottom:22px"><span class="badge${g.badge_tone ? ' ' + g.badge_tone : ''}">${esc(g.badge)}</span></div>` : '';
  const blurb = g.blurb ? `<p class="blurb">${esc(g.blurb)}</p>` : '';
  const shot = g.hero ? `<div class="shot"><img src="${esc(src(g.hero))}" alt="${esc(g.name)}"></div>` : '';
  return `<section class="goat-hero">
  <div class="inner">
    <div class="txt">
      ${badge}
      <p class="kind">${esc(kindLine(g))}</p>
      <h1 class="serif">${esc(g.name)}</h1>
      <p class="reg">${esc(g.registered_name)}</p>
      ${blurb}
    </div>
    ${shot}
  </div>
</section>

<div class="wrap">
`;
}

function secFacts(g) {
  const pairs = [
    ['Date of birth', dobText(g)],
    ['Alpha s1 casein', g.alpha_s1_casein],
    ['ADGA number', g.reg || (g.registry || {}).reg],
    ['Colour & markings', g.colour],
    ['Height', g.height],
    ['DNA', dnaOnFile(g) ? 'On file' : ''],
    ...g.facts.map((f) => [f.label, f.value]),
  ];
  const cells = pairs.filter(([, v]) => v)
    .map(([k, v]) => `<div><div class="label">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
  return cells ? `  <section class="fact-strip">${cells}</section>\n\n` : '';
}

function secGallery(g) {
  // No loading="lazy" anywhere on these pages. The .shot/.stack wrappers give
  // images no intrinsic height until they decode, so a lazy image sits at 0px,
  // never intersects the viewport and never loads.
  if (!g.gallery.length) return '';
  const figs = g.gallery.map((p) =>
    `<figure><div class="shot">${zoomImg(p, p.caption || g.name)}</div>` +
    `<figcaption>${esc(p.caption)}</figcaption></figure>`).join('');
  return `<div>
        <h2 class="serif" style="font-size:30px;margin-bottom:24px">Gallery</h2>
        <div class="gallery">${figs}</div>
      </div>`;
}

function secProduction(g) {
  // CDCB genetic evaluation. Labelled as what it is, not as a lactation record.
  const pe = (g.registry || {}).production_eval || {};
  const lbs = (k) => (pe[k] ? `${commas(pe[k])} lbs` : null);
  const rows = [
    ['Lactations on record', pe['Lactations']],
    ['Average standardised milk', lbs('Average STD Milk')],
    ['Average standardised fat', lbs('Average STD Fat')],
    ['Average standardised protein', lbs('Average STD Protein')],
    ['Percentile rank', pe['Percentile Rank']],
    ['Fluid merit', pe['Fluid Merit $'] ? `$${pe['Fluid Merit $']}` : null],
  ].filter(([, v]) => v != null && v !== '' && v !== 'None');

  let elite = '';
  if (g.elite) {
    const e = g.elite;
    const pct = e.percentile
      ? `<div class="row"><div class="pct">${esc(e.percentile)}<span>%</span></div><p>Elite percentile,<br>${esc(e.year || '')} list</p></div>` : '';
    elite = `<div class="top"><div class="t">${esc(e.title || 'ADGA Elite Doe')}</div><div class="y">${esc(e.year || '')}</div></div>${pct}`;
  }
  if (!rows.length && !elite) return '';

  const dl = rows.length
    ? '<dl>' + rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('') + '</dl>' : '';
  const note = rows.length
    ? '<p style="font-size:12px;color:var(--muted);line-height:1.6;margin-top:14px">' +
      'Figures are CDCB genetic evaluation averages published by ADGA, ' +
      'standardised across all recorded lactations — not a single lactation record.</p>' : '';
  return `<div>
        <h2 class="serif" style="font-size:30px;margin-bottom:24px">Production</h2>
        <div class="elite">${elite}${dl}</div>
        ${note}
      </div>`;
}

function secSplit(left, right) {
  if (!left && !right) return '';
  const inner = left && right ? `<div class="split">${left}${right}</div>` : left || right;
  return `  <section class="section">\n    ${inner}\n  </section>\n\n`;
}

function secPedigree(g) {
  const reg = g.registry || {};
  const gp = reg.grandparents || {};
  const ggp = reg.great_grandparents || {};
  const pick = (mine, key) => mine || titlecaseName(gp[key]) || '';

  const c1 = [['Sire', sire(g)], ['Dam', dam(g)]];
  const c2 = [["Sire's sire", pick(g.pedigree.ss, 'SS')], ["Sire's dam", pick(g.pedigree.sd, 'SD')],
    ["Dam's sire", pick(g.pedigree.ds, 'DS')], ["Dam's dam", pick(g.pedigree.dd, 'DD')]];
  const c3 = ['SSS', 'SSD', 'SDS', 'SDD', 'DSS', 'DSD', 'DDS', 'DDD'].map((k) => titlecaseName(ggp[k]) || '');
  if (!c1.some(([, v]) => v)) return '';

  const labelled = (items) => items.filter(([, v]) => v)
    .map(([l, v]) => `<div class="cell"><div class="label">${esc(l)}</div><div class="n">${esc(v)}</div></div>`).join('');
  const plain = (items) => items.filter(Boolean).map((v) => `<div class="cell"><div class="n">${esc(v)}</div></div>`).join('');

  const regno = g.reg || reg.reg;
  const link = regno
    ? `<p style="font-size:14px;color:var(--muted);margin:-14px 0 28px">${c3.some(Boolean) ? 'Four generations. ' : ''}` +
      `<a href="${esc(adgaLink(regno))}" target="_blank" rel="noopener">View on ADGA Genetics &rarr;</a></p>` : '';
  const col3 = c3.some(Boolean) ? `<div class="col c3">${plain(c3)}</div>` : '';
  return `  <section class="section">
    <h2 class="serif">Pedigree</h2>
    ${link}
    <div class="ped">
      <div class="col c1">${labelled(c1)}</div>
      <div class="col c2">${labelled(c2)}</div>
      ${col3}
    </div>
  </section>

`;
}

function secParents(g) {
  if (!g.parents.length) return '';
  const blocks = g.parents.map((p) => {
    const lines = p.lines.map((l) => `<div>${esc(l)}</div>`).join('');
    const credit = p.credit ? `<div class="pc">${esc(p.credit)}</div>` : '';
    const photos = p.photos.map((ph) => zoomImg(ph, ph.alt || p.name)).join('');
    const stack = photos || credit ? `<div class="stack">${photos}${credit}</div>` : '';
    return `<div>
      <div class="who">${esc(p.who)}</div>
      <div class="grid">
        <div>
          <h3>${esc(p.name)}</h3>
          <div class="lines">${lines}</div>
        </div>
        ${stack}
      </div>
    </div>`;
  }).join('');
  return `  <section class="section">\n    <h2 class="serif">Sire and dam</h2>\n    <div class="parents">${blocks}</div>\n  </section>\n\n`;
}

function secExtra(g) {
  return g.sections.map((s) => {
    const paras = s.paragraphs.filter((t) => String(t).trim())
      .map((t) => `<p class="lede" style="margin-bottom:14px">${esc(t)}</p>`).join('');
    return `  <section class="section">\n    <h2 class="serif">${esc(s.title)}</h2>\n    ${paras}\n  </section>\n\n`;
  }).join('');
}

// ---------------------------------------------------------------------------
// whole pages and page fragments
// ---------------------------------------------------------------------------

export function goatPageBody(g) {
  // Bucks carry no production record of their own; the gallery stands alone.
  const right = g.template === 'doe' ? secProduction(g) : '';
  return secHero(g) + secFacts(g) + secSplit(secGallery(g), right) +
    secPedigree(g) + secParents(g) + secExtra(g) + '</div>\n';
}

export function goatDescription(g) {
  const kind = g.template === 'buck' ? 'buck' : 'doe';
  const bits = [`${g.name}${g.registered_name ? ` (${g.registered_name})` : ''}, ADGA registered Nigerian Dwarf ${kind} at A Little Hill Farm in Potlatch, Idaho.`];
  if (g.blurb) bits.push(g.blurb);
  return bits.join(' ');
}

/** A full HTML document. Chrome and <head> extras are added by site-worker.js. */
export function goatPage(g) {
  const share = g.hero || g.gallery[0];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(g.name)} — A Little Hill Farm</title>
<meta name="description" content="${esc(goatDescription(g))}">
${share ? `<meta name="share-image" content="${esc(src(share))}">\n` : ''}<meta name="nav-section" content="${g.template === 'buck' ? '/bucks.html' : '/does.html'}">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<header class="site-header" data-chrome></header>

<main id="main">
${goatPageBody(g)}</main>

<footer class="site-footer" data-chrome></footer>
<script src="/assets/site.js"></script>
</body>
</html>
`;
}

/** One goat's row on the Does or Bucks page. */
export function rosterArticle(g) {
  const href = goatHref(g);
  const badge = g.badge
    ? `<div style="margin-bottom:10px"><span class="badge${g.badge_tone ? ' ' + g.badge_tone : ''}">${esc(g.badge)}</span></div>` : '';
  const facts = [
    ['Born', dobText(g)],
    ['Sire', sire(g)],
    ['Dam', dam(g)],
    ['Alpha s1 casein', g.alpha_s1_casein],
    ['DNA', dnaOnFile(g) ? 'On file' : ''],
    ...g.facts.map((f) => [f.label, f.value]),
  ].filter(([, v]) => v)
    .map(([k, v]) => `<div><div class="label">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('\n          ');
  const reg = g.reg || (g.registry || {}).reg;
  const adga = reg
    ? `<a class="link-u" href="${esc(adgaLink(reg))}" target="_blank" rel="noopener">ADGA pedigree</a>` +
      `<span style="font-size:11px;color:var(--muted);letter-spacing:.06em">ADGA ${esc(reg)}</span>` : '';
  const shot = g.hero
    ? `<a href="${href}" class="shot-link"><div class="shot">${smallImg(g.hero, g.name)}</div></a>`
    : `<a href="${href}" class="shot-link"><div class="shot"></div></a>`;
  return `
    <article>
      ${shot}
      <div class="body">
        <div>
          ${badge}
          <h2 class="serif"><a href="${href}" style="text-decoration:none;color:inherit">${esc(g.name)}</a></h2>
          <p class="reg">${esc(g.registered_name)}</p>
        </div>
        <div class="facts">
          ${facts}
        </div>
        <div class="actions">
          <a class="btn" href="${href}">Full profile</a>
          ${adga}
        </div>
      </div>
    </article>`;
}

/** One goat's card in the home page's herd grid. */
export function herdCard(g) {
  const shot = g.hero ? smallImg(g.hero, g.name) : '';
  return `
      <a href="${goatHref(g)}">
        <div class="shot">${shot}</div>
        <div class="nm serif">${esc(g.name)}</div>
        <div class="sub">${esc(cardLine(g))}</div>
      </a>`;
}

const WORDS_FOR = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve'];
/** 5 -> 'five'; 14 -> '14'. */
export const numberWord = (n) => WORDS_FOR[n] || String(n);
export const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
