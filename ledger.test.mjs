import test from "node:test";
import assert from "node:assert/strict";
import { apportion, convert, current, decimal, decimals, preview, report, settle, total, tripProblems, units, uses, versions } from "./ledger.js";

const trip = {
  schemaVersion: 1,
  base: "INR",
  currencies: { USD: ["1", "84.25"], VND: ["684000", "2285.41"] },
  members: [
    { id: "asha", name: "Asha" },
    { id: "bala", name: "Bala" },
    { id: "chitra", name: "Chitra" },
  ],
  categories: ["Food", "Stay"],
  instruments: ["Cash", "Online"],
};

let clock = 0;
const event = (entry, fields) => ({ entry, at: `2026-01-01T00:00:${String(clock++).padStart(2, "0")}Z`, by: "asha", date: "2026-01-01", ...fields });
const expense = (entry, fields) => event(entry, { kind: "expense", currency: "INR", category: "Food", via: "Online", ...fields });
const byMember = (result, field) => Object.fromEntries(result.members.map((m) => [m.member, m[field]]));
// What one member spent, by category.  These tests use one date, so each category has one cell.
const spentBy = (result, member) => Object.fromEntries(result.spend.filter((s) => s.member === member).map((s) => [s.category, s.amount]));

test("amounts parse and print exactly", () => {
  assert.equal(units("2285.41", 2), 228541n);
  assert.equal(units(8070, 2), 807000n);
  assert.equal(units("-0.5", 2), -50n);
  assert.throws(() => units("1.234", 2));
  assert.throws(() => units("1,000", 2));
  assert.equal(decimal(-5n, 2), "-0.05");
  assert.equal(decimal(684000n, 0), "684000");
  assert.equal(decimals("VND"), 0);
  assert.equal(decimals("USD"), 2);
});

test("apportion hands out the odd unit to the largest remainder", () => {
  assert.deepEqual(apportion(100n, [1n, 1n, 1n]), [34n, 33n, 33n]);
  assert.deepEqual(apportion(-100n, [1n, 1n, 1n]), [-33n, -33n, -34n]);
  assert.deepEqual(apportion(10n, [1n, 2n]), [3n, 7n]);
  assert.throws(() => apportion(10n, [0n, 0n]));
});

test("converting keeps the rounded whole, even across signs", () => {
  assert.deepEqual(convert([1n, 1n, 1n], [1n, 3n]), [1n, 0n, 0n]);
  assert.deepEqual(convert([5n, -2n, -3n], [1n, 3n]), [2n, -1n, -1n]);
  assert.deepEqual(convert([228000n, 228000n, 228000n], [228541n, 684000n]), [76181n, 76180n, 76180n]);
});

test("the odd unit rotates between members, entry by entry", () => {
  const lucky = new Set();
  for (const id of ["a", "b", "c", "d", "e", "f"]) {
    const shares = byMember(report(trip, [expense(id, { paid: { asha: "100" } })]), "share");
    assert.deepEqual(Object.values(shares).sort(), ["33.33", "33.33", "33.34"]);
    lucky.add(Object.keys(shares).find((name) => shares[name] === "33.34"));
  }
  assert.equal(lucky.size, 3);
});

test("every split mode", () => {
  const split = (s) => report(trip, [expense("e", { paid: { asha: "100" }, split: s })]);
  const shares = (s) => byMember(split(s), "share");
  assert.deepEqual(shares({ mode: "equal", members: ["asha", "bala"] }), { asha: "50.00", bala: "50.00", chitra: "0.00" });
  assert.deepEqual(shares({ mode: "shares", shares: { asha: 2, bala: 1, chitra: 1 } }), { asha: "50.00", bala: "25.00", chitra: "25.00" });
  assert.deepEqual(shares({ mode: "percent", percents: { asha: 50, bala: 30, chitra: 20 } }), { asha: "50.00", bala: "30.00", chitra: "20.00" });
  assert.deepEqual(shares({ mode: "exact", amounts: { asha: "10", bala: "90" } }), { asha: "10.00", bala: "90.00", chitra: "0.00" });
  const itemised = { mode: "itemised", items: [{ amount: 29, members: ["chitra"] }, { amount: 116, members: ["asha", "bala", "chitra"] }] };
  const { asha, bala, chitra } = shares(itemised);
  assert.deepEqual([asha, bala].sort(), ["26.66", "26.67"]);
  assert.equal(chitra, "46.67");
  assert.match(split({ mode: "percent", percents: { asha: 50 } }).problems[0].message, /total 100/);
  assert.match(split({ mode: "exact", amounts: { asha: "10" } }).problems[0].message, /total the amount/);
});

test("expenses balance, personal spend moves nothing, and nets sum to zero", () => {
  const result = report(trip, [
    expense("dinner", { paid: { asha: "90" } }),
    expense("hat", { paid: { bala: "40" }, split: { mode: "equal", members: ["bala"] } }),
    expense("hotel", { category: "Stay", paid: { bala: "50", chitra: "100" } }),
  ]);
  assert.deepEqual(byMember(result, "net"), { asha: "10.00", bala: "-30.00", chitra: "20.00" });
  assert.deepEqual(spentBy(result, "bala"), { Food: "70.00", Stay: "50.00" });
  assert.deepEqual(result.problems, []);
});

test("foreign currency converts once per entry, to the paisa", () => {
  const result = report(trip, [expense("pho", { currency: "VND", paid: { asha: "684000" } })]);
  assert.deepEqual(Object.values(byMember(result, "share")).sort(), ["761.80", "761.80", "761.81"]);
  assert.equal(byMember(result, "paid").asha, "2285.41");
});

test("an exchange loss is shared equally, to the paisa", () => {
  const result = report(trip, [
    event("atm", { kind: "exchange", gave: { currency: "INR", via: "Online", by: { asha: "7364.17" } }, got: { currency: "VND", via: "Cash", by: { asha: "2000000" } } }),
  ]);
  assert.equal(result.forexLoss, "681.68");
  assert.deepEqual(Object.values(byMember(result, "forex")).sort(), ["227.22", "227.23", "227.23"]);
  assert.deepEqual(result.problems, []);
});

test("many awkward conversions still leave nets in whole paise that add up to zero", () => {
  const odd = ["1", "7", "13", "99", "1001", "33333", "684001"].map((amount, i) =>
    expense(`v${i}`, { currency: "VND", paid: { [trip.members[i % 3].id]: amount } }));
  const atm = event("atm", { kind: "exchange", gave: { currency: "USD", via: "Cash", by: { bala: "10.01" } }, got: { currency: "VND", via: "Cash", by: { bala: "250001" } } });
  const result = report(trip, [...odd, atm]);
  assert.deepEqual(result.problems, []);
  const nets = Object.values(byMember(result, "net"));
  assert.equal(nets.reduce((a, n) => a + units(n, 2), 0n), 0n);
});

test("settling up clears every net with the biggest payments first", () => {
  assert.deepEqual(settle([["a", 70n], ["b", -50n], ["c", -20n]]), [{ from: "b", to: "a", amount: 50n }, { from: "c", to: "a", amount: 20n }]);
  assert.deepEqual(settle([["a", 30n], ["b", 20n], ["c", -50n]]), [{ from: "c", to: "a", amount: 30n }, { from: "c", to: "b", amount: 20n }]);
  assert.deepEqual(settle([["a", 0n], ["b", 0n]]), []);
  const nets = [["a", 5n], ["b", -9n], ["c", 7n], ["d", -3n]];
  assert.deepEqual(nets.map(([, n]) => n), [5n, -9n, 7n, -3n]);
  const left = new Map(nets);
  for (const { from, to, amount } of settle(nets)) (left.set(from, left.get(from) + amount), left.set(to, left.get(to) - amount));
  assert.deepEqual([...left.values()], [0n, 0n, 0n, 0n]);
});

test("a report lists who pays whom, in the currency shown", () => {
  const entries = [expense("dinner", { paid: { asha: "90" } }), expense("cab", { currency: "USD", paid: { bala: "3" } })];
  assert.deepEqual(report(trip, [expense("dinner", { paid: { asha: "90" } })]).settle, [
    { from: "bala", to: "asha", amount: "30.00" },
    { from: "chitra", to: "asha", amount: "30.00" },
  ]);
  assert.deepEqual(report(trip, []).settle, []);
  const inUsd = report(trip, entries, { currency: "USD" }).settle;
  assert.ok(inUsd.length && inUsd.every(({ amount }) => /^\d+\.\d{2}$/.test(amount)));
});

test("figures can be seen in another currency, and spending kept to one", () => {
  const entries = [
    expense("dinner", { paid: { asha: "900" } }),
    expense("pho", { currency: "VND", paid: { bala: "300000" } }),
  ];
  const inUsd = report(trip, entries, { currency: "USD" });
  assert.equal(inUsd.currency, "USD");
  assert.equal(Object.values(byMember(inUsd, "net")).reduce((a, n) => a + units(n, 2), 0n), 0n);
  const vndOnly = report(trip, entries, { currency: "VND", only: "VND" });
  assert.deepEqual(spentBy(vndOnly, "asha"), { Food: "100000" });
  assert.deepEqual(spentBy(report(trip, entries, { only: "VND" }), "asha"), { Food: "334.13" });
  assert.deepEqual(spentBy(report(trip, entries, { only: "INR" }), "asha"), { Food: "300.00" });
});

test("spending is kept by day, and converting the days keeps the whole", () => {
  const entries = [
    expense("a", { date: "2026-01-01", paid: { asha: "10" } }),
    expense("b", { date: "2026-01-02", currency: "VND", paid: { asha: "1000" } }),
    expense("c", { date: "2026-01-02", category: "Stay", currency: "VND", paid: { bala: "1000" } }),
    expense("d", { date: "2026-01-03", currency: "VND", paid: { chitra: "1000" } }),
  ];
  const day = (result, date) => result.spend.filter((s) => s.date === date).reduce((a, s) => a + units(s.amount, 2), 0n);
  const inInr = report(trip, entries);
  assert.deepEqual([...new Set(inInr.spend.map((s) => s.date))].sort(), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  assert.equal(day(inInr, "2026-01-01"), 1000n);
  // Three VND 1,000 expenses are ₹10.02 together (3000 × 2285.41 ÷ 684000), however the days round.
  const together = inInr.spend.reduce((a, s) => a + units(s.amount, 2), 0n);
  assert.equal(together, 1000n + 1002n);
});

test("cash wallets follow own cash and cash payments, and own cash moves no balance", () => {
  const paidInCash = (entry, fields) => event(entry, { via: "Cash", currency: "VND", ...fields });
  const spending = [
    paidInCash("cab", { kind: "expense", category: "Food", paid: { bala: "30000" } }),
    paidInCash("tip", { kind: "transfer", from: { asha: "20000" }, to: { bala: "20000" } }),
    expense("card", { currency: "VND", paid: { bala: "50000" } }),
  ];
  const result = report(trip, [
    event("own", { kind: "cash", member: "bala", currency: "VND", amount: "65000" }),
    ...spending,
    event("zero", { kind: "cash", member: "asha", currency: "VND", amount: "0" }),
  ]);
  assert.deepEqual(result.wallets, [
    { member: "asha", currency: "VND", expected: "-20000" },
    { member: "bala", currency: "VND", expected: "55000" },
  ]);
  assert.deepEqual(result.problems.map(({ entry }) => entry), ["zero"]);
  assert.deepEqual(byMember(result, "net"), byMember(report(trip, spending), "net"));
});

test("the latest version of an entry wins, and a void removes it", () => {
  const first = expense("x", { paid: { asha: "30" } });
  const edit = expense("x", { paid: { asha: "60" } });
  assert.equal(current([edit, first])[0].paid.asha, "60");
  assert.deepEqual(current([first, edit, event("x", { kind: "void" })]), []);
});

test("renaming a member leaves their entries attached", () => {
  const entries = [expense("dinner", { paid: { asha: "90" } })];
  const renamed = { ...trip, members: trip.members.map((m) => (m.id === "asha" ? { ...m, name: "Ashwini" } : m)) };
  const before = report(trip, entries);
  const after = report(renamed, entries);
  assert.equal(after.members[0].name, "Ashwini");
  assert.deepEqual(after.members.map(({ name, ...rest }) => rest), before.members.map(({ name, ...rest }) => rest));
});

test("trip settings are checked in words", () => {
  assert.deepEqual(tripProblems(trip), []);
  const broken = {
    ...trip,
    base: "INR",
    members: [{ id: "a", name: "Asha" }, { id: "a", name: "Asha" }, { id: "c", name: " " }],
    currencies: { INR: ["1", "1"], VND: ["1.5", "1"], ZZZ: ["1", "1"] },
    categories: ["Food", "Food"],
    instruments: ["Online", "Online", " "],
  };
  assert.deepEqual(tripProblems(broken), [
    "a member has no name",
    "member names repeat",
    "member ids must be unique",
    "INR is the base currency and takes no rate",
    "VND: whole numbers only: 1.5",
    "unknown currency: ZZZ",
    "categories repeat",
    "instruments must include Cash",
    "an instrument has no name",
    "instruments repeat",
  ]);
  const { instruments, ...unlabelled } = trip;
  assert.deepEqual(tripProblems(unlabelled), ["instruments must include Cash"]);
  assert.deepEqual(tripProblems({ ...trip, members: [] }), ["add at least one member"]);
  assert.throws(() => report({ ...trip, members: [] }, []), /at least one member/);
});

test("bad entries are reported, not counted", () => {
  const result = report(trip, [
    expense("good", { paid: { asha: "30" } }),
    expense("stranger", { paid: { zed: "30" } }),
    expense("nowhere", { currency: "EUR", paid: { asha: "30" } }),
    expense("odd", { category: "Spa", paid: { asha: "30" } }),
  ]);
  assert.deepEqual(result.problems.map(({ entry }) => entry), ["stranger", "nowhere", "odd"]);
  assert.equal(byMember(result, "paid").asha, "30.00");
});

test("every payment says what it was paid with, from the trip's instruments", () => {
  const result = report(trip, [
    expense("unsaid", { via: undefined, paid: { asha: "30" } }),
    expense("card", { via: "Card", paid: { asha: "30" } }),
    event("hand", { kind: "transfer", currency: "INR", from: { asha: "5" }, to: { bala: "5" } }),
    event("atm", { kind: "exchange", gave: { currency: "INR", by: { asha: "100" } }, got: { currency: "USD", via: "Cash", by: { asha: "1" } } }),
  ]);
  assert.deepEqual(result.problems, [
    { entry: "unsaid", message: "say what it was paid with" },
    { entry: "card", message: "unknown instrument: Card" },
    { entry: "hand", message: "say what it was paid with" },
    { entry: "atm", message: "say what it was paid with" },
  ]);
});

test("the instrument decides cash in hand, never who paid or what anyone owes", () => {
  const dinner = (via) => expense("dinner", { currency: "VND", via, paid: { asha: "90000" } });
  const [cash, online] = [report(trip, [dinner("Cash")]), report(trip, [dinner("Online")])];
  assert.deepEqual(cash.members, online.members);
  assert.deepEqual(cash.wallets, [{ member: "asha", currency: "VND", expected: "-90000" }]);
  assert.deepEqual(online.wallets, []);
});

test("a draft previews its shares or its problem", () => {
  const draft = { entry: "d", kind: "expense", date: "2026-01-01", currency: "INR", category: "Food", via: "Online" };
  assert.deepEqual(preview(trip, { ...draft, paid: { asha: "10" }, split: { mode: "equal", members: ["asha", "bala"] } }), {
    problem: null,
    shares: [{ member: "asha", amount: "5.00" }, { member: "bala", amount: "5.00" }],
  });
  assert.deepEqual(preview(trip, { ...draft, paid: { asha: "" } }), { problem: "an amount is missing", shares: [] });
});

test("totals, versions, and what entries use", () => {
  assert.equal(total({ asha: "10.5", bala: "2" }, "INR"), "12.50");
  assert.equal(total({ asha: "abc" }, "INR"), null);
  const first = expense("x", { paid: { asha: "30" } });
  const edit = expense("x", { paid: { bala: "30" }, split: { mode: "equal", members: ["chitra"] } });
  assert.deepEqual(versions([edit, first, expense("y", {})], "x"), [first, edit]);
  const used = uses([first, edit]);
  assert.deepEqual([...used.members].sort(), ["bala", "chitra"]);
  assert.deepEqual([...used.categories], ["Food"]);
  assert.deepEqual([...used.currencies], ["INR"]);
  assert.deepEqual([...used.instruments], ["Online"]);
  const atm = event("atm", { kind: "exchange", gave: { currency: "INR", via: "Online", by: { asha: "100" } }, got: { currency: "USD", via: "Cash", by: { asha: "1" } } });
  assert.deepEqual([...uses([atm]).instruments].sort(), ["Cash", "Online"]);
});
