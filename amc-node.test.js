"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getNewSeats,
  isAllowedShowtime,
  panelConfirmsImax70mm,
  parseShowtimeMinutes,
  parseState,
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
