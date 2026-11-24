/**
 * The breeding schedule page — rendered from the `breedings` table in D1.
 *
 * The farm edits pairings in the store's admin screen (Breeding tab); this
 * file turns those rows into the cards on /breeding.html when the page is
 * requested, so an edit is live on the next load. The static markup in
 * breeding.html is only a fallback for a database with no pairings at all.
 * The home page's "<year> Kiddings" block and count, the menu's label and each
 * buck's "Breeding to <year>" fact come from the same rows (currentKiddings,
 * scheduleYear and withScheduleFacts below).
 *
 * Row shape: see `breedings` in store/schema.sql.
 */
import { esc, KIDDINGS_LABEL } from './chrome.js';
import { smallImg, goatHref } from './goats.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** A pairing the page lists: not hidden, and not one that was skipped. */
export const isShown = (r) => !!r.show && r.status !== 'skipped';

export async function loadBreeding(env) {
  const all = (await env.DB.prepare('SELECT * FROM breedings ORDER BY due_on, id').all()).results || [];
  const settings = {};
  const rows = (await env.DB.prepare("SELECT key, value FROM site_settings WHERE key LIKE 'breeding_%'").all()).results || [];
  for (const r of rows) settings[r.key] = r.value;
  return {
    total: all.length,
    // Hidden rows and pairings that were skipped stay in the admin only.
    rows: all.filter(isShown),
    settings,
  };
}

/** "2026-04-08" -> { d: '8', m: 'April 2026' }, or null for anything else. */
export function dueParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  return { d: String(+m[3]), m: MONTHS[+m[2] - 1] + ' ' + m[1] };
}

const dueYear = (iso) => {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(String(iso || ''));
  return m ? +m[1] : null;
};

/**
 * The year the schedule is for: the latest due-date year among the pairings
 * shown on the page, or null when there are none. Last season's pairings can
 * stay on the page; the new season's make the year move on by themselves.
 */
export function scheduleYear(rows) {
  let year = null;
  for (const r of rows || []) {
    const y = dueYear(r.due_on);
    if (y !== null && (year === null || y > year)) year = y;
  }
  return year;
}

/**
 * What the home page shows of the schedule: the shown pairings due in the
 * schedule's year (see scheduleYear), in due-date order. Last season's
 * pairings can stay on the breeding page without muddying "2027 Kiddings".
 */
export function currentKiddings(rows) {
  const year = scheduleYear(rows);
  return { year, rows: year === null ? [] : (rows || []).filter((r) => dueYear(r.due_on) === year) };
}

/** The home page's stat label: "Kiddings due 2027", or "Kiddings due" with none to show. */
export const kiddingsDueLabel = (year) => (year ? `Kiddings due ${year}` : 'Kiddings due');

/** "2026-04-08" -> "April 8" (anything else comes back as it was typed). */
export function dueShort(iso) {
  const p = dueParts(iso);
  return p ? `${p.m.replace(/ \d{4}$/, '')} ${p.d}` : String(iso || '');
}

/**
 * The home page's grid of pairings. Goats from the herd go by their short
 * name ("Cookie × Toby"); an outside doe or buck by the name typed in the admin.
 */
export function kiddingsTiles(rows, goats) {
  if (!rows.length) {
    return '\n      <div class="lede" style="background:var(--card);padding:22px 20px">No pairings are scheduled right now. Check back soon.</div>\n    ';
  }
  const nameOf = shortNames(goats);
  return rows.map((r) => `
      <a href="/breeding.html" style="background:var(--card);padding:22px 20px;text-decoration:none;color:inherit;display:block">
        <div class="eyebrow">Due ${esc(dueShort(r.due_on))}</div>
        <div class="serif" style="font-size:19px;line-height:1.25;margin-top:10px">${esc(nameOf(r.doe_id, r.doe_name))} <span style="color:var(--muted)">×</span> ${esc(nameOf(r.sire_id, r.sire_name))}</div>
      </a>`).join('') + '\n    ';
}

/** A goat's short name from the herd by id, else the name typed in the admin. */
const shortNames = (goats) => {
  const byId = new Map((goats || []).map((g) => [g.id, g]));
  return (id, typed) => (id && byId.has(id) ? byId.get(id).name : '') || typed || '';
};

/** A hand-typed goat fact that names a season's breedings, e.g. "Breeding to 2026". */
const isBreedingFact = (f) => /^\s*breeding\s+to\b/i.test(f.label || '');

/**
 * A buck with his "Breeding to <year>" fact generated from the schedule: the
 * does paired to him (by sire_id, as picked in the admin) among the current
 * year's pairings, in due-date order. It replaces any hand-typed "Breeding to
 * …" fact, so the row can never name last season; a buck with no pairing this
 * year simply has no such row. `rows` null (the schedule could not be read)
 * leaves the goat exactly as typed. Does and the other facts are untouched.
 */
export function withScheduleFacts(g, rows, goats) {
  if (g.template !== 'buck' || !rows) return g;
  const { year, rows: current } = currentKiddings(rows);
  const nameOf = shortNames(goats);
  const does = [...new Set(current.filter((r) => r.sire_id === g.id).map((r) => nameOf(r.doe_id, r.doe_name)).filter(Boolean))];
  const facts = g.facts.filter((f) => !isBreedingFact(f));
  if (does.length) facts.push({ label: `Breeding to ${year}`, value: does.join(' · ') });
  return { ...g, facts };
}

/** The menu and footer link to this page: "2027 Kiddings", or plain "Kiddings" with no schedule. */
export const kiddingsLabel = (year) => (year ? `${year} ${KIDDINGS_LABEL}` : KIDDINGS_LABEL);

/**
 * The same label for pages that do not otherwise load the schedule (every
 * page has the menu). One small query; if the table cannot be read the menu
 * simply drops the year rather than show a wrong one.
 */
export async function loadKiddingsLabel(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT MAX(due_on) AS latest FROM breedings WHERE show != 0 AND status != 'skipped'"
    ).first();
    return kiddingsLabel(scheduleYear([{ due_on: row && row.latest }]));
  } catch (err) {
    console.error('breeding schedule unavailable for the menu label: ' + err);
    return kiddingsLabel(null);
  }
}

const regOf = (v) => String(v || '').replace(/\s+/g, '');

export function pedigreeLink(sireReg, damReg) {
  const sire = regOf(sireReg), dam = regOf(damReg);
  if (!sire || !dam) return '';
  return 'https://genetics.adga.org/PlannedPedigreePrint.aspx?SireNum=' + encodeURIComponent(sire) + '&DamNum=' + encodeURIComponent(dam);
}

export function breedingCard(row, goatsById) {
  const doe = row.doe_id ? goatsById.get(row.doe_id) : null;
  const sire = row.sire_id ? goatsById.get(row.sire_id) : null;
  const due = dueParts(row.due_on) || { d: '', m: row.due_on || '' };
  const photo = doe && doe.hero
    ? smallImg(doe.hero, doe.name)
    : '';
  const name = doe
    ? `<a href="${esc(goatHref(doe))}" style="text-decoration:none;color:inherit">${esc(row.doe_name)}</a>`
    : esc(row.doe_name);
  const buck = sire
    ? `<a href="${esc(goatHref(sire))}" style="text-decoration:none;color:inherit">${esc(row.sire_name)}</a>`
    : esc(row.sire_name);
  const pedigree = pedigreeLink(row.sire_reg || (sire && sire.reg), row.dam_reg || (doe && doe.reg));
  const kidded = row.status === 'kidded'
    ? `<div class="to">Kidded${row.outcome ? ': <strong>' + esc(row.outcome) + '</strong>' : ''}</div>`
    : '';
  return `    <article>
      <div class="date"><div class="d">${esc(due.d)}</div><div class="m">${esc(due.m)}</div></div>
      <div class="pair">
        <div class="av">${photo}</div>
        <div style="min-width:0">
          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
            <span class="nm">${name}</span>${row.freshening ? `
            <span class="chip">${esc(row.freshening)}</span>` : ''}
          </div>
          <div class="to">bred to <strong>${buck}</strong></div>
          ${kidded}
        </div>
      </div>
      <div class="go">${pedigree ? `<a class="btn ghost" href="${esc(pedigree)}" target="_blank" rel="noopener">Pedigree</a>` : ''}</div>
    </article>
`;
}

/** The inside of <div class="sched">. */
export function breedingCards(rows, goats) {
  if (!rows.length) {
    return '    <p class="lede">No pairings are scheduled right now. Check back soon.</p>\n';
  }
  const byId = new Map(goats.map((g) => [g.id, g]));
  return rows.map((r) => breedingCard(r, byId)).join('') + '  ';
}
