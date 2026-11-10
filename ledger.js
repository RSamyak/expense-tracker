// Shared-expense ledger.  Pure: no DOM, no storage, no network.
//
// Money is BigInt minor units of its own currency.  Each entry is converted to
// whole base units once and balances to the unit, so every total is exact.

export const SCHEMA_VERSION = 1;
export const CASH = "Cash";

const WEIGHT_PLACES = 6;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class LedgerError extends Error {}

function fail(message) {
  throw new LedgerError(message);
}

// ---- Amounts -------------------------------------------------------------

const places = new Map();

export function decimals(currency) {
  if (!places.has(currency)) {
    const format = new Intl.NumberFormat("en", { style: "currency", currency });
    places.set(currency, format.resolvedOptions().maximumFractionDigits);
  }
  return places.get(currency);
}

export function units(value, digits) {
  const text = String(value ?? "").trim();
  if (!text) fail("an amount is missing");
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) fail(`not an amount: ${text}`);
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > digits) fail(digits ? `at most ${digits} decimals: ${text}` : `whole numbers only: ${text}`);
  const n = BigInt(whole + fraction.padEnd(digits, "0"));
  return sign ? -n : n;
}

export function decimal(n, digits) {
  const sign = n < 0n ? "-" : "";
  const text = (n < 0n ? -n : n).toString().padStart(digits + 1, "0");
  return digits ? `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}` : sign + text;
}

const sum = (values) => values.reduce((a, b) => a + b, 0n);
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const lcm = (a, b) => (a / gcd(a, b)) * b;
const floor = (n, d) => (n < 0n && n % d ? n / d - 1n : n / d);

function halfEven(n, d) {
  const q = n / d;
  const twice = 2n * (n % d < 0n ? -(n % d) : n % d);
  if (twice < d || (twice === d && q % 2n === 0n)) return q;
  return n < 0n ? q - 1n : q + 1n;
}

// Each value times mul/div, in whole units, so the parts still add up to the
// rounded whole.  Leftover units go to the largest remainders; ties to the earlier.
export function convert(values, [mul, div]) {
  const exact = values.map((v) => v * mul);
  const parts = exact.map((x) => floor(x, div));
  let left = halfEven(sum(exact), div) - sum(parts);
  const order = exact
    .map((x, i) => [x - parts[i] * div, i])
    .sort(([a, i], [b, j]) => (a === b ? i - j : a > b ? -1 : 1));
  for (const [, i] of order) {
    if (!left) break;
    parts[i] += 1n;
    left -= 1n;
  }
  return parts;
}

// A total shared out by weight; the parts sum to it exactly.
export function apportion(total, weights) {
  const whole = sum(weights);
  if (whole <= 0n || weights.some((w) => w < 0n)) fail("shares must be non-negative and not all zero");
  return convert(weights, [total, whole]);
}

// ---- Trip ----------------------------------------------------------------

const repeats = (list) => new Set(list).size !== list.length;
const blank = (list) => list.some((item) => !String(item).trim());

// A member is `{ id, name }`.  Entries refer to the id, so a name can change freely.
const ids = (trip) => trip.members.map(({ id }) => id);

// Everything wrong with a trip's settings, in words; empty when it is ready.
export function tripProblems(trip) {
  if (trip?.schemaVersion !== SCHEMA_VERSION) return ["unsupported trip schemaVersion"];
  const known = new Set(Intl.supportedValuesOf("currency"));
  const problems = [];
  const members = trip.members ?? [];
  const categories = trip.categories ?? [];
  if (!known.has(trip.base)) problems.push(`unknown base currency: ${trip.base}`);
  if (!members.length) problems.push("add at least one member");
  if (blank(members.map(({ name }) => name))) problems.push("a member has no name");
  if (repeats(members.map(({ name }) => name))) problems.push("member names repeat");
  if (blank(members.map(({ id }) => id)) || repeats(members.map(({ id }) => id))) problems.push("member ids must be unique");
  for (const code of Object.keys(trip.currencies ?? {})) {
    if (!known.has(code)) problems.push(`unknown currency: ${code}`);
    else if (code === trip.base) problems.push(`${code} is the base currency and takes no rate`);
    else if (known.has(trip.base)) {
      try {
        rate(trip, code);
      } catch (error) {
        if (!(error instanceof LedgerError)) throw error;
        problems.push(`${code}: ${error.message}`);
      }
    }
  }
  if (blank(categories)) problems.push("a category has no name");
  if (repeats(categories)) problems.push("categories repeat");
  const instruments = trip.instruments ?? [];
  if (!instruments.includes(CASH)) problems.push(`instruments must include ${CASH}`);
  if (blank(instruments)) problems.push("an instrument has no name");
  if (repeats(instruments)) problems.push("instruments repeat");
  return problems;
}

function checkTrip(trip) {
  const [first] = tripProblems(trip);
  if (first) fail(first);
}

function member(trip, id) {
  if (!ids(trip).includes(id)) fail(`not a member: ${id}`);
  return id;
}

function rate(trip, currency, override) {
  if (currency === trip.base) {
    if (override) fail("base currency takes no rate");
    return [1n, 1n];
  }
  const pair = override ?? trip.currencies?.[currency];
  if (!pair) fail(`no rate for ${currency}`);
  const [quote, base] = pair;
  const q = units(quote, decimals(currency));
  const b = units(base, decimals(trip.base));
  if (q <= 0n || b <= 0n) fail(`rate for ${currency} must be positive`);
  return [q, b];
}

// What a payment was made with.  It says nothing about who paid; only cash moves a wallet.
function paidWith(trip, via) {
  if (!via) fail("say what it was paid with");
  if (!trip.instruments.includes(via)) fail(`unknown instrument: ${via}`);
  return via;
}

function money(trip, map, currency) {
  const entries = Object.entries(map ?? {}).map(([name, value]) => [member(trip, name), units(value, decimals(currency))]);
  if (entries.some(([, n]) => n < 0n)) fail("amounts must not be negative");
  const total = sum(entries.map(([, n]) => n));
  if (total <= 0n) fail("total must be positive");
  return { entries, total };
}

// What a map of member amounts adds up to, or null if any amount is not one.
export function total(map, currency) {
  try {
    const digits = decimals(currency);
    return decimal(sum(Object.values(map ?? {}).map((value) => units(value, digits))), digits);
  } catch (error) {
    if (error instanceof LedgerError || error instanceof RangeError) return null;
    throw error;
  }
}

// ---- Splits --------------------------------------------------------------

// Who gets the odd unit rotates with the entry, so nobody is always favoured,
// and every device agrees because the rotation comes from the entry id.
function seat(id, size) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % size;
}

function weighted(trip, total, pairs, id) {
  const n = trip.members.length;
  const start = seat(id, n);
  const place = (id) => (ids(trip).indexOf(id) - start + n) % n;
  const ordered = [...pairs].sort(([a], [b]) => place(a) - place(b));
  const parts = apportion(total, ordered.map(([, w]) => w));
  return ordered.map(([name], i) => [name, parts[i]]);
}

function shares(trip, id, total, currency, split = { mode: "equal" }) {
  const named = (map) => Object.entries(map ?? {}).map(([name, value]) => [member(trip, name), value]);
  switch (split.mode) {
    case "equal":
      return weighted(trip, total, [...new Set(split.members ?? ids(trip))].map((name) => [member(trip, name), 1n]), id);
    case "shares":
      return weighted(trip, total, named(split.shares).map(([name, w]) => [name, units(w, WEIGHT_PLACES)]), id);
    case "percent": {
      const pairs = named(split.percents).map(([name, p]) => [name, units(p, WEIGHT_PLACES)]);
      if (sum(pairs.map(([, p]) => p)) !== units(100, WEIGHT_PLACES)) fail("percentages must total 100");
      return weighted(trip, total, pairs, id);
    }
    case "exact": {
      const pairs = named(split.amounts).map(([name, a]) => [name, units(a, decimals(currency))]);
      if (sum(pairs.map(([, a]) => a)) !== total) fail("exact shares must total the amount");
      return pairs;
    }
    case "itemised": {
      const items = split.items ?? [];
      if (items.some((item) => !item.members?.length)) fail("every item needs members");
      const scale = items.reduce((l, item) => lcm(l, BigInt(item.members.length)), 1n);
      const weights = new Map();
      for (const item of items) {
        const each = (units(item.amount, WEIGHT_PLACES) * scale) / BigInt(item.members.length);
        for (const name of item.members) weights.set(member(trip, name), (weights.get(name) ?? 0n) + each);
      }
      return weighted(trip, total, [...weights], id);
    }
    default:
      fail(`unknown split mode: ${split.mode}`);
  }
}

// ---- Journal -------------------------------------------------------------

// Every version of an entry is an event; the latest `at` wins, and a void removes it.
export function current(events) {
  const latest = new Map();
  for (const event of events) {
    const seen = latest.get(event.entry);
    if (!seen || event.at > seen.at) latest.set(event.entry, event);
  }
  return [...latest.values()]
    .filter((event) => event.kind !== "void")
    .sort((a, b) => (a.date === b.date ? (a.at < b.at ? -1 : 1) : a.date < b.date ? -1 : 1));
}

// One entry's versions, oldest first.
export const versions = (events, entry) =>
  events.filter((event) => event.entry === entry).sort((a, b) => (a.at < b.at ? -1 : 1));

// The members, categories, currencies, and instruments that current entries rely on.
export function uses(events) {
  const found = { members: new Set(), categories: new Set(), currencies: new Set(), instruments: new Set() };
  const people = (map) => Object.keys(map ?? {}).forEach((id) => found.members.add(id));
  for (const entry of current(events)) {
    const { split } = entry;
    people(entry.paid);
    people(entry.from);
    people(entry.to);
    people(split?.shares);
    people(split?.percents);
    people(split?.amounts);
    split?.members?.forEach((id) => found.members.add(id));
    split?.items?.forEach((item) => item.members?.forEach((id) => found.members.add(id)));
    if (entry.member) found.members.add(entry.member);
    for (const part of [entry.gave, entry.got]) {
      people(part?.by);
      if (part?.currency) found.currencies.add(part.currency);
      if (part?.via) found.instruments.add(part.via);
    }
    if (entry.currency) found.currencies.add(entry.currency);
    if (entry.category) found.categories.add(entry.category);
    if (entry.via) found.instruments.add(entry.via);
  }
  return found;
}

// One side of an entry.  Its total is converted to base units once and then shared
// out, so both sides of an entry agree to the unit.
function postings(field, currency, [quote, base], parts, entry, category) {
  const values = convert(parts.map(([, n]) => n), [base, quote]);
  return parts.map(([name, amount], i) => ({ member: name, field, amount, currency, value: values[i], entry, category }));
}

const value = (list) => sum(list.map((p) => p.value));

function side(trip, part, name) {
  if (!part?.currency) fail(`${name} needs a currency`);
  const { entries, total } = money(trip, part.by, part.currency);
  return { entries, total, currency: part.currency, via: paidWith(trip, part.via) };
}

// One entry becomes postings (what it does to balances) and cash moves (what it does to wallets).
function post(trip, entry) {
  if (!DATE.test(entry.date ?? "")) fail("date must be YYYY-MM-DD");
  const id = entry.entry;
  const cash = (name, currency, amount) => ({ member: name, currency, amount, date: entry.date });
  switch (entry.kind) {
    case "expense": {
      const { currency } = entry;
      if (trip.categories && entry.category && !trip.categories.includes(entry.category)) fail(`unknown category: ${entry.category}`);
      const pair = rate(trip, currency, entry.rate);
      const paid = money(trip, entry.paid, currency);
      const owed = shares(trip, id, paid.total, currency, entry.split);
      const via = paidWith(trip, entry.via);
      return {
        postings: [
          ...postings("paid", currency, pair, paid.entries, id),
          ...postings("share", currency, pair, owed, id, entry.category ?? ""),
        ],
        moves: via === CASH ? paid.entries.map(([name, n]) => cash(name, currency, -n)) : [],
      };
    }
    case "transfer": {
      const { currency } = entry;
      const pair = rate(trip, currency);
      const from = money(trip, entry.from, currency);
      const to = money(trip, entry.to, currency);
      if (from.total !== to.total) fail("a transfer must send what it receives");
      const via = paidWith(trip, entry.via);
      return {
        postings: [...postings("sent", currency, pair, from.entries, id), ...postings("received", currency, pair, to.entries, id)],
        moves: via === CASH
          ? [...from.entries.map(([name, n]) => cash(name, currency, -n)), ...to.entries.map(([name, n]) => cash(name, currency, n))]
          : [],
      };
    }
    case "exchange": {
      const gave = side(trip, entry.gave, "gave");
      const got = side(trip, entry.got, "got");
      if (gave.currency === got.currency) fail("an exchange needs two currencies");
      const sent = postings("sent", gave.currency, rate(trip, gave.currency), gave.entries, id);
      const received = postings("received", got.currency, rate(trip, got.currency), got.entries, id);
      // What the exchange lost, shared equally; the odd unit rotates like a split.
      const lost = weighted(trip, value(sent) - value(received), ids(trip).map((name) => [name, 1n]), id);
      return {
        postings: [...sent, ...received, ...postings("forex", trip.base, [1n, 1n], lost, id)],
        moves: [
          ...(gave.via === CASH ? gave.entries.map(([name, n]) => cash(name, gave.currency, -n)) : []),
          ...(got.via === CASH ? got.entries.map(([name, n]) => cash(name, got.currency, n)) : []),
        ],
      };
    }
    // Someone's own money into their wallet, at the start or later.  It is not shared, so no balance moves.
    case "cash": {
      const amount = units(entry.amount, decimals(entry.currency));
      if (amount <= 0n) fail("cash must be positive");
      return { postings: [], moves: [cash(member(trip, entry.member), entry.currency, amount)] };
    }
    default:
      fail(`unknown kind: ${entry.kind}`);
  }
}

// ---- Report --------------------------------------------------------------

// Who an expense is split to.  A transfer, an exchange, and own cash are shared with nobody.
export function sharedWith(trip, entry) {
  try {
    if (entry.kind !== "expense") return [];
    const owed = shares(trip, entry.entry, money(trip, entry.paid, entry.currency).total, entry.currency, entry.split);
    return owed.filter(([, amount]) => amount).map(([id]) => id);
  } catch (error) {
    if (error instanceof LedgerError) return [];
    throw error;
  }
}

// What a draft entry would do, before it is saved: its problem, or each member's share.
export function preview(trip, entry) {
  try {
    checkTrip(trip);
    post(trip, entry);
    if (entry.kind !== "expense") return { problem: null, shares: [] };
    const owed = shares(trip, entry.entry, money(trip, entry.paid, entry.currency).total, entry.currency, entry.split);
    const digits = decimals(entry.currency);
    const order = ids(trip);
    return {
      problem: null,
      shares: owed
        .filter(([, n]) => n)
        .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
        .map(([id, n]) => ({ member: id, amount: decimal(n, digits) })),
    };
  } catch (error) {
    if (!(error instanceof LedgerError)) throw error;
    return { problem: error.message, shares: [] };
  }
}

const FIELDS = ["share", "paid", "sent", "received", "forex"];

// Payments that clear every net: the biggest debtor pays the biggest creditor, and so on.
// Ties go to the earlier member.  Nets add up to zero, so everyone ends square.
export function settle(nets) {
  const owing = nets.filter(([, n]) => n < 0n).map(([id, n]) => [id, -n]);
  const owed = nets.filter(([, n]) => n > 0n).map(([id, n]) => [id, n]);
  const biggest = (list) => list.reduce((best, item) => (item[1] > best[1] ? item : best));
  const payments = [];
  while (owing.length && owed.length) {
    const debtor = biggest(owing);
    const creditor = biggest(owed);
    const amount = debtor[1] < creditor[1] ? debtor[1] : creditor[1];
    payments.push({ from: debtor[0], to: creditor[0], amount });
    debtor[1] -= amount;
    creditor[1] -= amount;
    for (const list of [owing, owed]) list.splice(0, list.length, ...list.filter(([, n]) => n));
  }
  return payments;
}

// Figures are in `currency`, the base unless asked.  `only` keeps spending to the
// expenses made in that currency; seen in that same currency, they are its own amounts.
export function report(trip, events, { currency = trip.base, only = null } = {}) {
  checkTrip(trip);
  const problems = [];
  const postings = [];
  const moves = [];
  for (const entry of current(events)) {
    try {
      const result = post(trip, entry);
      postings.push(...result.postings.map((p) => ({ ...p, date: entry.date })));
      moves.push(...result.moves);
    } catch (error) {
      if (!(error instanceof LedgerError)) throw error;
      problems.push({ entry: entry.entry, message: error.message });
    }
  }

  const order = ids(trip);
  const totals = new Map(order.map((id) => [id, Object.fromEntries(FIELDS.map((field) => [field, 0n]))]));
  const spend = new Map();
  const native = only === currency;
  for (const p of postings) {
    totals.get(p.member)[p.field] += p.value;
    if (p.field !== "share" || (only && p.currency !== only)) continue;
    const key = [p.member, p.date, p.category].join("\u0000");
    spend.set(key, (spend.get(key) ?? 0n) + (native ? p.amount : p.value));
  }
  const net = (t) => t.paid + t.sent - t.received - t.share - t.forex;
  if (sum([...totals.values()].map(net))) problems.push({ entry: null, message: "trial balance is not zero" });

  // Converting a column keeps its total, so nets still add up to zero.
  const digits = decimals(currency);
  const pair = rate(trip, currency);
  const show = (values) => convert(values, pair).map((n) => decimal(n, digits));
  const rows = order.map((id) => totals.get(id));
  const columns = Object.fromEntries(FIELDS.map((field) => [field, show(rows.map((t) => t[field]))]));
  const nets = convert(rows.map(net), pair);
  columns.net = nets.map((n) => decimal(n, digits));
  // What each member spent on each day in each category.  Converted together, so the whole adds up.
  const cells = [...spend];
  const spent = native ? cells.map(([, v]) => v) : convert(cells.map(([, v]) => v), pair);

  return {
    currency,
    members: trip.members.map(({ id, name }, i) => ({
      member: id,
      name,
      ...Object.fromEntries(Object.entries(columns).map(([field, list]) => [field, list[i]])),
    })),
    forexLoss: show([sum(order.map((id) => totals.get(id).forex))])[0],
    settle: settle(order.map((id, i) => [id, nets[i]])).map(({ from, to, amount }) => ({ from, to, amount: decimal(amount, digits) })),
    spend: cells.map(([key], i) => {
      const [member, date, category] = key.split("\u0000");
      return { member, date, category, amount: decimal(spent[i], digits) };
    }),
    wallets: wallets(trip, moves),
    problems,
  };
}

// The cash each member should be holding, per currency, in member order.
function wallets(trip, moves) {
  const held = new Map();
  for (const { member: id, currency, amount } of moves) {
    const key = `${id}\u0000${currency}`;
    held.set(key, { member: id, currency, amount: (held.get(key)?.amount ?? 0n) + amount });
  }
  const order = ids(trip);
  return [...held.values()]
    .sort((a, b) => order.indexOf(a.member) - order.indexOf(b.member) || (a.currency < b.currency ? -1 : 1))
    .map(({ member: id, currency, amount }) => ({ member: id, currency, expected: decimal(amount, decimals(currency)) }));
}
