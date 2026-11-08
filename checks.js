// QBO month-end exception checks. Pure functions, no DOM. Works in browser (ES module) and node.
// Input: array-of-arrays from a QuickBooks Online "Transaction Detail by Account" or
// "General Ledger" export (Excel or CSV). Grouped-by-account layout is handled.

const COL = {
  date: /^date$/i,
  type: /transaction\s*type|^type$/i,
  num: /^num$|^no\.?$|number/i,
  name: /^name$|customer|vendor|payee/i,
  memo: /memo|description/i,
  account: /^account$|account\s*name|account full name/i,
  split: /^split$/i,
  amount: /^amount$/i,
  balance: /^balance$/i,
  clr: /^clr$|cleared|reconcil/i,
};

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

export function toDate(v) {
  if (typeof v === 'number') { // excel serial → local calendar date, no TZ shift
    const u = new Date(Math.round((v - 25569) * 86400000));
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
  }
  if (v instanceof Date) return isNaN(v) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // MM/DD/YYYY (QBO US)
  if (m) return new Date(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

export function toNum(v) {
  if (typeof v === 'number') return v;
  if (isBlank(v)) return null;
  const s = String(v).replace(/[,$\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Find header row and column indexes.
export function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map((c) => String(c ?? '').trim());
    const hasDate = cells.some((c) => COL.date.test(c));
    const hasAmt = cells.some((c) => COL.amount.test(c));
    if (hasDate && hasAmt) {
      const idx = {};
      for (const [key, re] of Object.entries(COL)) {
        const j = cells.findIndex((c) => re.test(c));
        if (j >= 0 && idx[key] === undefined) idx[key] = j;
      }
      return { headerRow: i, idx };
    }
  }
  return null;
}

// Flatten grouped export into transactions.
export function parseExport(rows) {
  const h = findHeader(rows);
  if (!h) throw new Error('Could not find a header row with Date and Amount columns.');
  const { headerRow, idx } = h;
  const txns = [];
  let group = '';
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const first = String(r[0] ?? '').trim();
    const nonBlank = r.filter((c) => !isBlank(c)).length;
    if (nonBlank === 0) continue;
    const dateV = idx.date !== undefined ? r[idx.date] : undefined;
    const amtV = idx.amount !== undefined ? r[idx.amount] : undefined;
    // Group header: only first cell filled, no date.
    if (nonBlank === 1 && !toDate(dateV) && first && !/^total/i.test(first)) {
      group = first;
      continue;
    }
    if (/^total|^beginning balance|^ending balance|^net /i.test(first)) continue;
    const date = toDate(dateV);
    const amount = toNum(amtV);
    if (!date || amount === null) continue;
    const g = (k) => (idx[k] !== undefined ? String(r[idx[k]] ?? '').trim() : '');
    txns.push({
      row: i + 1,
      date,
      type: g('type'),
      num: g('num'),
      name: g('name'),
      memo: g('memo'),
      account: g('account') || group,
      split: g('split'),
      amount,
      clr: g('clr'),
    });
  }
  return { txns, hasClr: idx.clr !== undefined };
}

const BANKISH = /bank|checking|savings|cash|credit card|visa|mastercard|amex|paypal|stripe|undeposited/i;
const days = (a, b) => Math.abs(a - b) / 86400000;
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local date, no UTC shift
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2);

export function runChecks({ txns, hasClr }) {
  const findings = [];
  if (!txns.length) return findings;
  const periodEnd = new Date(Math.max(...txns.map((t) => +t.date)));
  const periodStart = new Date(Math.min(...txns.map((t) => +t.date)));
  const add = (id, title, severity, items, note) => {
    if (items.length) findings.push({ id, title, severity, items, note });
  };

  // 1. Opening Balance Equity moved.
  add('obe', 'Opening Balance Equity has activity this period', 'high',
    txns.filter((t) => /opening balance equity/i.test(t.account) || /opening balance equity/i.test(t.split))
      .map((t) => ({ ...t, why: 'Posting to OBE after setup usually means a mid-period bank connection or a direct journal entry.' })),
    'OBE should be zero and untouched after the first month of a file.');

  // 2. Negative A/R or A/P by name.
  for (const [re, label, sign, id] of [[/accounts receivable|^a\/r/i, 'A/R', 1, 'negar'], [/accounts payable|^a\/p/i, 'A/P', -1, 'negap']]) {
    const byName = new Map();
    for (const t of txns) if (re.test(t.account) && t.name) byName.set(t.name, (byName.get(t.name) || 0) + t.amount);
    const items = [...byName].filter(([, v]) => v * sign < -0.005)
      .map(([name, v]) => ({ date: periodEnd, name, account: label, amount: v, why: `${label} net for this name is ${money(v)} within the export. Payment applied before invoice/bill, or a duplicate payment.` }));
    add(id, `Negative ${label} by ${label === 'A/R' ? 'customer' : 'vendor'} (within this export)`, 'high', items,
      'Computed from movements inside the export only; confirm against the A/R or A/P aging.');
  }

  // 3. Undeposited Funds: non-zero net, or items older than 14 days.
  const uf = txns.filter((t) => /undeposited funds|payments to deposit/i.test(t.account));
  if (uf.length) {
    const net = uf.reduce((s, t) => s + t.amount, 0);
    const old = uf.filter((t) => t.amount > 0 && days(periodEnd, t.date) > 14);
    const items = [];
    if (Math.abs(net) > 0.005) items.push({ date: periodEnd, account: 'Undeposited Funds', amount: net, name: '', why: net < 0 ? 'Credit balance: deposits recorded without the matching receipt, or receipts posted straight to the bank.' : 'Receipts not yet grouped into a deposit.' });
    for (const t of old) items.push({ ...t, why: `Receipt sitting in Undeposited Funds ${Math.round(days(periodEnd, t.date))} days before period end.` });
    add('uf', 'Undeposited Funds not clearing', 'medium', items, 'ponytail: net-balance heuristic; a true open-item list needs the Deposit Detail report.');
  }

  // 4. Likely duplicates: same account, same |amount|, same name, within 3 days.
  const dup = [];
  const seen = new Set();
  const byKey = new Map();
  for (const t of txns) {
    if (!BANKISH.test(t.account) || Math.abs(t.amount) < 0.005) continue;
    const k = `${t.account}|${Math.abs(t.amount).toFixed(2)}|${t.name.toLowerCase()}`;
    const list = byKey.get(k) || [];
    for (const p of list) {
      if (days(p.date, t.date) <= 3 && Math.sign(p.amount) === Math.sign(t.amount)) {
        for (const x of [p, t]) if (!seen.has(x.row)) { seen.add(x.row); dup.push({ ...x, why: `Same ${money(x.amount)} to "${x.name || '(no name)'}" in ${x.account} within 3 days.` }); }
      }
    }
    list.push(t); byKey.set(k, list);
  }
  add('dup', 'Possible duplicate bank transactions', 'high', dup, 'Relinked or re-imported bank feeds create these. Check which one is matched to the statement.');

  // 5. Uncleared items older than 60 days (needs Clr column).
  if (hasClr) {
    const unc = txns.filter((t) => BANKISH.test(t.account) && !/^(r|c|x|✓|yes|true)$/i.test(t.clr) && days(periodEnd, t.date) > 60)
      .map((t) => ({ ...t, why: `Uncleared ${Math.round(days(periodEnd, t.date))} days. Stale checks and phantom entries end up as forced reconciliation adjustments.` }));
    add('stale', 'Uncleared bank items older than 60 days', 'medium', unc);
  } else {
    findings.push({ id: 'stale', title: 'Uncleared bank items older than 60 days', severity: 'skipped', items: [], note: 'Add the "Clr" column to the report before exporting to run this check.' });
  }

  // 6. Transfers landing in non-bank accounts.
  add('xfer', 'Transfers categorised to a non-bank account', 'medium',
    txns.filter((t) => /^transfer$/i.test(t.type) && t.split && !BANKISH.test(t.split) && !/^-?split-?$/i.test(t.split))
      .map((t) => ({ ...t, why: `Transfer with split "${t.split}". Transfers should move between balance-sheet accounts, not P&L.` })),
    'ponytail: account-name heuristic; the export has no account type.');

  // 7. Uncategorised / Ask My Accountant.
  add('uncat', 'Uncategorised or parked transactions', 'medium',
    txns.filter((t) => /uncategori[sz]ed|ask my accountant|suspense/i.test(t.account) || /uncategori[sz]ed|ask my accountant|suspense/i.test(t.split))
      .map((t) => ({ ...t, why: 'Still parked. Will distort P&L and the balance sheet until categorised.' })));

  return { findings, periodStart, periodEnd, count: txns.length };
}

export { fmt, money };
