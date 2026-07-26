"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getNewSeats,
  isAllowedShowtime,
  panelConfirmsImax70mm,
  parseShowtimeMinutes,
  parseState,
  selectEligibleSeats,
  sortSeats,
} = require("./amc-node");

test("parses 12-hour showtimes", () => {
  assert.equal(parseShowtimeMinutes("12:00 AM"), 0);
  assert.equal(parseShowtimeMinutes("12:00 PM"), 720);
  assert.equal(parseShowtimeMinutes("6:15 p.m."), 1095);
  assert.equal(parseShowtimeMinutes("not a time"), null);
});

test("allows any parseable showtime (full-day window)", () => {
  assert.equal(isAllowedShowtime("12:00 AM"), true);
  assert.equal(isAllowedShowtime("11:00 AM"), true);
  assert.equal(isAllowedShowtime("8:31 PM"), true);
  assert.equal(isAllowedShowtime("11:59 PM"), true);
  assert.equal(isAllowedShowtime("not a time"), false);
});

test("finds newly opened seats", () => {
  assert.deepEqual(getNewSeats(["J21", "K22"], ["J21"]), ["K22"]);
});

test("sorts seats by configured row and number", () => {
  assert.deepEqual(sortSeats(["M22", "J23", "J19", "K21"]), [
    "J19",
    "J23",
    "K21",
    "M22",
  ]);
});


test("selects open seats beyond the first N rows, any column", () => {
  const parsed = [
    { row: "A", col: 10, available: true },
    { row: "B", col: 10, available: true },
    { row: "C", col: 10, available: true },
    { row: "D", col: 10, available: true },
    { row: "E", col: 10, available: true }, // 5th row from front → excluded
    { row: "F", col: 1, available: true }, // eligible
    { row: "F", col: 2, available: false }, // taken → skipped
    { row: "M", col: 26, available: true }, // eligible, far back
  ];
  assert.deepEqual(selectEligibleSeats(parsed, 5), ["F1", "M26"]);
});

test("front-row exclusion counts a row even when it is sold out", () => {
  const parsed = [
    { row: "A", col: 5, available: false },
    { row: "B", col: 5, available: false },
    { row: "C", col: 5, available: true },
    { row: "D", col: 5, available: true },
  ];
  assert.deepEqual(selectEligibleSeats(parsed, 2), ["C5", "D5"]);
});

test("parses persisted deduplication state", () => {
  const state = parseState(
    JSON.stringify({
      version: 1,
      availability: {
        "123": {
          movie: "The Odyssey",
          date: "2026-07-18",
          time: "7:00 PM",
          seats: ["J21"],
          missingScans: 0,
        },
      },
    })
  );

  assert.deepEqual(state.availability["123"].seats, ["J21"]);
  assert.deepEqual(parseState("not JSON"), { version: 1, availability: {} });
});

test("confirms IMAX 70mm only when the booking page states it", () => {
  assert.equal(
    panelConfirmsImax70mm(
      "Showtime Information\nThe Odyssey\nAMC LINCOLN SQUARE 13\nMONDAY, JULY 20, 2026\n6:00 PM\nIMAX 70MM\nRESERVED SEATING"
    ),
    true
  );
  assert.equal(
    panelConfirmsImax70mm(
      "Showtime Information\nThe Odyssey\nAMC LINCOLN SQUARE 13\nMONDAY, JULY 20, 2026\n11:00 AM\nDOLBY CINEMA AT AMC\nAMC SIGNATURE RECLINERS\nRESERVED SEATING"
    ),
    false
  );
  assert.equal(panelConfirmsImax70mm(""), false);
});
