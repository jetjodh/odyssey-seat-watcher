#!/usr/bin/env node
"use strict";

/*
 * The Odyssey IMAX 70mm seat watcher for AMC Lincoln Square 13.
 *
 * Configured for:
 *   - one regular seat
 *   - showtimes from 11:00 AM through 8:30 PM
 *   - central seats in rows J through M
 *   - push notifications through ntfy and/or email through Gmail
 *
 * The script is designed for GitHub Actions. It stores a small deduplication
 * state object in a hidden JSON file in the fork so a seat that remains
 * available does not trigger the same alert every ten minutes.
 */

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const nodemailer = require("nodemailer");

puppeteer.use(StealthPlugin());

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

const CONFIG = Object.freeze({
  theaterUrl:
    "https://www.amctheatres.com/movie-theatres/new-york-city/amc-lincoln-square-13/showtimes",
  movieTerms: ["the odyssey"],
  minShowtimeMinutes: 11 * 60,
  maxShowtimeMinutes: 20 * 60 + 30,
  maxDates: 21,
  targetSeatsByRow: Object.freeze({
    J: range(18, 26),
    K: range(18, 26),
    L: range(18, 26),
    M: range(18, 26),
  }),
  stateFilePath: ".odyssey-watcher-state.json",
  stateBranch: (process.env.GITHUB_REF_NAME || "main").trim(),
  maxMissingScans: 3,
});

const TEST_NOTIFICATION = /^(1|true)$/i.test(
  process.env.TEST_NOTIFICATION || ""
);
const DRY_RUN = /^(1|true)$/i.test(process.env.DRY_RUN || "");

const GMAIL_USER = (process.env.GMAIL_USER || "").trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || "").trim();
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAIL || "")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);

const NTFY_TOPIC = (process.env.NTFY_TOPIC || "").trim();
const NTFY_SERVER = (process.env.NTFY_SERVER || "https://ntfy.sh")
  .trim()
  .replace(/\/+$/, "");

const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
const GITHUB_REPOSITORY = (process.env.GITHUB_REPOSITORY || "").trim();

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function parseShowtimeMinutes(value) {
  const match = String(value || "").match(
    /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)\b/i
  );
  if (!match) return null;

  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const meridiem = match[3].replace(/\./g, "").toLowerCase();

  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  return hour * 60 + minute;
}

function isAllowedShowtime(value) {
  const minutes = parseShowtimeMinutes(value);
  return (
    minutes !== null &&
    minutes >= CONFIG.minShowtimeMinutes &&
    minutes <= CONFIG.maxShowtimeMinutes
  );
}

function getNewSeats(currentSeats, previousSeats) {
  const previous = new Set(previousSeats || []);
  return (currentSeats || []).filter((seat) => !previous.has(seat));
}

function rowOrder(row) {
  const rows = Object.keys(CONFIG.targetSeatsByRow);
  const index = rows.indexOf(row);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function sortSeats(seats) {
  return [...seats].sort((left, right) => {
    const leftMatch = left.match(/^([A-Z])(\d+)$/);
    const rightMatch = right.match(/^([A-Z])(\d+)$/);
    if (!leftMatch || !rightMatch) return left.localeCompare(right);

    const rowDifference = rowOrder(leftMatch[1]) - rowOrder(rightMatch[1]);
    if (rowDifference !== 0) return rowDifference;

    return Number(leftMatch[2]) - Number(rightMatch[2]);
  });
}

function nycDateString(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function fallbackDates(count) {
  const today = nycDateString();
  const [year, month, day] = today.split("-").map(Number);
  const base = new Date(Date.UTC(year, month - 1, day, 12));

  return Array.from({ length: count }, (_, offset) => {
    const date = new Date(base.getTime() + offset * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  });
}

async function navigate(page, url) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page
        .waitForNetworkIdle({ idleTime: 750, timeout: 12_000 })
        .catch(() => undefined);
      await sleep(1_500);
      return;
    } catch (error) {
      lastError = error;
      log(`Navigation attempt ${attempt} failed for ${url}: ${error.message}`);
      if (attempt < 2) await sleep(2_000);
    }
  }

  throw lastError;
}

async function getAvailableDates(page) {
  await navigate(page, CONFIG.theaterUrl);

  const dates = await page.evaluate(() => {
    const found = new Set();

    document
      .querySelectorAll('select[name="date"] option')
      .forEach((option) => found.add(option.value));

    document.querySelectorAll('a[href*="date="]').forEach((link) => {
      try {
        const value = new URL(link.href).searchParams.get("date");
        if (value) found.add(value);
      } catch {
        // Ignore malformed links.
      }
    });

    document.querySelectorAll("[data-date]").forEach((element) => {
      const value = element.getAttribute("data-date");
      if (value) found.add(value);
    });

    return [...found].filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  });

  const today = nycDateString();
  const usable = [...new Set(dates)]
    .filter((date) => date >= today)
    .sort()
    .slice(0, CONFIG.maxDates);

  if (usable.length > 0) return usable;

  log("AMC date controls were not detected; using generated date URLs as a fallback.");
  return fallbackDates(CONFIG.maxDates);
}

async function getShowtimes(page, date) {
  const url = `${CONFIG.theaterUrl}?date=${encodeURIComponent(date)}`;
  await navigate(page, url);

  const results = await page.evaluate((movieTerms) => {
    const links = document.querySelectorAll("a[href*='/showtimes/']");
    const showtimes = [];

    for (const link of links) {
      const idMatch = link.href.match(/\/showtimes\/(\d+)/);
      if (!idMatch) continue;

      const timeMatch = (link.innerText || "").match(
        /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)\b/i
      );
      if (!timeMatch) continue;

      let formatNode = link.parentElement;
      let isImax70mm = false;
      while (formatNode && formatNode.tagName !== "SECTION") {
        if (/IMAX\s*70\s*MM/i.test(formatNode.innerText || "")) {
          isImax70mm = true;
          break;
        }
        formatNode = formatNode.parentElement;
      }
      if (!isImax70mm) continue;

      const section = link.closest("section") || link.closest("article");
      const heading = section?.querySelector("h1, h2, h3");
      const movie = heading ? heading.innerText.trim() : "";
      const normalizedMovie = movie.toLowerCase();
      if (!movieTerms.some((term) => normalizedMovie.includes(term))) continue;

      showtimes.push({
        id: idMatch[1],
        movie,
        time: timeMatch[0].replace(/\s+/g, " ").trim(),
        soldOut: /sold\s*out/i.test(link.innerText || ""),
      });
    }

    return showtimes;
  }, CONFIG.movieTerms);

  const unique = new Map();
  for (const showtime of results) unique.set(showtime.id, showtime);
  return [...unique.values()];
}

function panelConfirmsImax70mm(panelText) {
  return /imax\s*70\s*mm/i.test(String(panelText || ""));
}

async function getAvailableSeats(page, showtimeId) {
  const bookingUrl = `https://www.amctheatres.com/showtimes/${showtimeId}/seats`;
  await navigate(page, bookingUrl);

  // A missing seat map is treated as a scrape failure, not as zero seats.
  // That prevents a temporary AMC error page from clearing the alert state
  // and causing duplicate notifications on the next run.
  await page.waitForSelector("input[aria-label]", { timeout: 20_000 });

  // The showtimes listing page groups every format (Dolby, standard, IMAX
  // 70mm, ...) for a movie under one shared section, so a showtime link can
  // be misclassified as IMAX 70mm there. This booking page states the real
  // format for exactly this showtime, so it is the authoritative check.
  const showtimePanelText = await page.evaluate(() => {
    const bodyText = document.body.innerText || "";
    const marker = bodyText.indexOf("Showtime Information");
    return marker === -1 ? bodyText.slice(0, 600) : bodyText.slice(marker, marker + 600);
  });

  if (!panelConfirmsImax70mm(showtimePanelText)) {
    const error = new Error(
      "Booking page does not confirm IMAX 70mm for this showtime; treating as a non-match to avoid a false alert."
    );
    error.formatMismatch = true;
    throw error;
  }

  const available = await page.evaluate((targetSeatsByRow) => {
    const targets = Object.fromEntries(
      Object.entries(targetSeatsByRow).map(([row, columns]) => [
        row,
        new Set(columns),
      ])
    );
    const seats = [];

    for (const input of document.querySelectorAll("input[aria-label]")) {
      const label = input.getAttribute("aria-label") || "";
      const lowerLabel = label.toLowerCase();

      if (
        input.disabled ||
        input.getAttribute("aria-disabled") === "true" ||
        /occupied|unavailable|wheelchair|companion|accessible/.test(lowerLabel)
      ) {
        continue;
      }

      const matches = [
        ...label.toUpperCase().matchAll(/\b([A-Z])\s*(\d{1,3})\b/g),
      ];
      if (matches.length === 0) continue;

      const match = matches[matches.length - 1];
      const row = match[1];
      const column = Number.parseInt(match[2], 10);

      if (targets[row]?.has(column)) seats.push(`${row}${column}`);
    }

    return [...new Set(seats)];
  }, CONFIG.targetSeatsByRow);

  return sortSeats(available);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function notificationDetails(hit, newSeats, isTest = false) {
  const bookingUrl = hit.bookingUrl || CONFIG.theaterUrl;
  const allSeats = sortSeats(hit.seats || newSeats);
  const newlyOpened = sortSeats(newSeats);
  const leadSeat = newlyOpened[0] || allSeats[0] || "seat";
  const title = isTest
    ? "Odyssey seat watcher test"
    : `The Odyssey IMAX 70mm: ${leadSeat} open`;

  const lines = isTest
    ? [
        "Test notification succeeded.",
        "Your live watcher is configured for AMC Lincoln Square 13.",
      ]
    : [
        `${hit.date} at ${hit.time}`,
        `New qualifying seat${newlyOpened.length === 1 ? "" : "s"}: ${newlyOpened.join(", ")}`,
        `Currently open in your zone: ${allSeats.join(", ")}`,
        "Rows J-M, seats 18-26; wheelchair and companion spaces excluded.",
      ];

  return {
    title,
    text: lines.join("\n"),
    bookingUrl,
    html: `
      <h2>${escapeHtml(title)}</h2>
      ${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n")}
      <p><a href="${escapeHtml(bookingUrl)}">Open the AMC seat map</a></p>
    `,
  };
}

async function sendNtfy(details) {
  if (!NTFY_TOPIC) return false;

  const response = await fetch(
    `${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Title: details.title,
        Priority: "urgent",
        Tags: "movie_camera,ticket",
        Click: details.bookingUrl,
      },
      body: details.text,
    }
  );

  if (!response.ok) {
    throw new Error(`ntfy returned HTTP ${response.status}`);
  }

  log("ntfy push notification sent.");
  return true;
}

async function sendEmail(details) {
  const emailConfigured =
    GMAIL_USER && GMAIL_APP_PASSWORD && NOTIFY_EMAILS.length > 0;
  if (!emailConfigured) return false;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: `"Odyssey Seat Watcher" <${GMAIL_USER}>`,
    to: NOTIFY_EMAILS,
    subject: details.title,
    text: `${details.text}\n\n${details.bookingUrl}`,
    html: details.html,
  });

  log(`Email sent to ${NOTIFY_EMAILS.join(", ")}.`);
  return true;
}

async function sendNotifications(hit, newSeats, isTest = false) {
  const details = notificationDetails(hit, newSeats, isTest);
  const configuredChannels = [];
  if (NTFY_TOPIC) configuredChannels.push("ntfy");
  if (GMAIL_USER && GMAIL_APP_PASSWORD && NOTIFY_EMAILS.length > 0) {
    configuredChannels.push("email");
  }

  if (configuredChannels.length === 0) {
    log(
      "No notification channel is configured. Add NTFY_TOPIC or the three Gmail secrets."
    );
    return false;
  }

  let successes = 0;

  if (NTFY_TOPIC) {
    try {
      if (await sendNtfy(details)) successes += 1;
    } catch (error) {
      log(`ntfy notification failed: ${error.message}`);
    }
  }

  if (GMAIL_USER && GMAIL_APP_PASSWORD && NOTIFY_EMAILS.length > 0) {
    try {
      if (await sendEmail(details)) successes += 1;
    } catch (error) {
      log(`Email notification failed: ${error.message}`);
    }
  }

  return successes > 0;
}

function emptyState() {
  return { version: 1, availability: {} };
}

function parseState(content) {
  try {
    const parsed = JSON.parse(String(content || ""));
    if (!parsed || typeof parsed !== "object") return emptyState();
    if (!parsed.availability || typeof parsed.availability !== "object") {
      parsed.availability = {};
    }
    parsed.version = 1;
    return parsed;
  } catch (error) {
    if (String(content || "").trim()) {
      log(`Could not parse saved state; starting fresh: ${error.message}`);
    }
    return emptyState();
  }
}

async function githubRequest(path, options = {}) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    throw new Error("GITHUB_TOKEN or GITHUB_REPOSITORY is unavailable");
  }

  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "odyssey-seat-watcher",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && payload.message
        ? payload.message
        : String(payload || "unknown error");
    const error = new Error(`GitHub API ${response.status}: ${detail}`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

function encodedStatePath() {
  return CONFIG.stateFilePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function loadStateFile() {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    log("GitHub file state is unavailable; deduplication is disabled.");
    return { enabled: false, sha: null, state: emptyState() };
  }

  try {
    const payload = await githubRequest(
      `/repos/${GITHUB_REPOSITORY}/contents/${encodedStatePath()}?ref=${encodeURIComponent(
        CONFIG.stateBranch
      )}`
    );

    if (!payload || payload.type !== "file" || !payload.content) {
      throw new Error("The watcher state path did not return a file");
    }

    const content = Buffer.from(
      String(payload.content).replace(/\s/g, ""),
      payload.encoding || "base64"
    ).toString("utf8");

    return {
      enabled: true,
      sha: payload.sha || null,
      state: parseState(content),
    };
  } catch (error) {
    if (error.status === 404) {
      log("No previous alert state file exists yet.");
      return { enabled: true, sha: null, state: emptyState() };
    }

    log(`Could not load GitHub file state: ${error.message}`);
    return { enabled: false, sha: null, state: emptyState() };
  }
}

function normalizedAvailability(availability) {
  return Object.fromEntries(
    Object.entries(availability || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, entry]) => [
        id,
        {
          movie: entry.movie,
          date: entry.date,
          time: entry.time,
          seats: sortSeats(entry.seats || []),
          missingScans: Number(entry.missingScans || 0),
        },
      ])
  );
}

function normalizedState(state) {
  return {
    version: 1,
    availability: normalizedAvailability(state?.availability),
  };
}

async function writeStateFile(sha, nextState) {
  const body = {
    message: "chore: update Odyssey watcher state [skip ci]",
    content: Buffer.from(
      `${JSON.stringify(normalizedState(nextState), null, 2)}\n`,
      "utf8"
    ).toString("base64"),
    branch: CONFIG.stateBranch,
  };
  if (sha) body.sha = sha;

  return githubRequest(
    `/repos/${GITHUB_REPOSITORY}/contents/${encodedStatePath()}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

async function saveStateFile(stateSha, previousState, nextState) {
  const previous = JSON.stringify(normalizedState(previousState));
  const next = JSON.stringify(normalizedState(nextState));
  if (previous === next) {
    log("Alert state is unchanged.");
    return;
  }

  try {
    await writeStateFile(stateSha, nextState);
    log("Alert state saved.");
  } catch (error) {
    if (error.status === 409 || error.status === 422) {
      try {
        log("Alert state changed concurrently; retrying once.");
        const fresh = await loadStateFile();
        if (fresh.enabled) {
          await writeStateFile(fresh.sha, nextState);
          log("Alert state saved after retry.");
          return;
        }
      } catch (retryError) {
        log(`Could not save GitHub file state after retry: ${retryError.message}`);
        return;
      }
    }

    log(`Could not save GitHub file state: ${error.message}`);
  }
}

async function runScan(page) {
  log("Scanning AMC Lincoln Square 13 for The Odyssey in IMAX 70mm.");
  log("Time window: 11:00 AM through 8:30 PM.");
  log("Seat zone: regular seats J18-J26, K18-K26, L18-L26, M18-M26.");

  const stateContext = DRY_RUN
    ? { enabled: false, sha: null, state: emptyState() }
    : await loadStateFile();
  const previousState = stateContext.state;
  const nextState = {
    version: 1,
    availability: JSON.parse(
      JSON.stringify(previousState.availability || {})
    ),
  };
  const encounteredShowtimes = new Set();
  const today = nycDateString();

  const dates = await getAvailableDates(page);
  log(`Scanning ${dates.length} date(s): ${dates[0]} through ${dates.at(-1)}.`);

  let matchingShowtimes = 0;
  let seatHits = 0;
  let notificationsSent = 0;

  for (const date of dates) {
    let showtimes;
    try {
      showtimes = await getShowtimes(page, date);
    } catch (error) {
      log(`${date}: showtime page failed: ${error.message}`);
      continue;
    }

    const allowed = showtimes.filter((showtime) => isAllowedShowtime(showtime.time));
    if (allowed.length === 0) continue;

    matchingShowtimes += allowed.length;
    log(`${date}: ${allowed.length} qualifying showtime(s).`);

    for (const showtime of allowed) {
      const bookingUrl = `https://www.amctheatres.com/showtimes/${showtime.id}/seats`;
      let seats;

      try {
        seats = await getAvailableSeats(page, showtime.id);
        encounteredShowtimes.add(showtime.id);
      } catch (error) {
        if (error.formatMismatch) {
          log(`${date} ${showtime.time}: skipped, not actually IMAX 70mm (${error.message})`);
        } else {
          log(`${date} ${showtime.time}: seat map failed: ${error.message}`);
        }
        continue;
      }

      const previousEntry = previousState.availability?.[showtime.id];
      const previousSeats = previousEntry?.seats || [];

      if (seats.length === 0) {
        delete nextState.availability[showtime.id];
        log(
          `${date} ${showtime.time}: no qualifying seats${
            showtime.soldOut ? " (AMC marks the show sold out)" : ""
          }.`
        );
        continue;
      }

      seatHits += 1;
      const newSeats = getNewSeats(seats, previousSeats);
      log(
        `${date} ${showtime.time}: qualifying seats ${seats.join(", ")}${
          newSeats.length ? `; new ${newSeats.join(", ")}` : "; already alerted"
        }.`
      );

      if (DRY_RUN) continue;

      let mayRecordCurrentSeats = newSeats.length === 0;
      if (newSeats.length > 0) {
        const sent = await sendNotifications(
          {
            ...showtime,
            date,
            seats,
            bookingUrl,
          },
          newSeats
        );
        if (sent) {
          notificationsSent += 1;
          mayRecordCurrentSeats = true;
        }
      }

      if (mayRecordCurrentSeats) {
        nextState.availability[showtime.id] = {
          movie: showtime.movie,
          date,
          time: showtime.time,
          seats,
          missingScans: 0,
        };
      }

      await sleep(750 + Math.random() * 750);
    }
  }

  if (!DRY_RUN) {
    for (const [showtimeId, entry] of Object.entries(
      nextState.availability
    )) {
      if (encounteredShowtimes.has(showtimeId)) continue;

      if (entry.date < today) {
        delete nextState.availability[showtimeId];
        continue;
      }

      const missingScans = Number(entry.missingScans || 0) + 1;
      if (missingScans >= CONFIG.maxMissingScans) {
        delete nextState.availability[showtimeId];
      } else {
        nextState.availability[showtimeId] = {
          ...entry,
          missingScans,
        };
      }
    }

    if (stateContext.enabled) {
      await saveStateFile(stateContext.sha, previousState, nextState);
    }
  }

  log(
    `Scan complete: ${matchingShowtimes} qualifying showtime(s), ${seatHits} hit(s), ${notificationsSent} notification(s).`
  );
}

async function sendTestNotification() {
  const sent = await sendNotifications(
    {
      movie: "The Odyssey",
      date: "TEST",
      time: "6:00 PM",
      seats: ["J21"],
      bookingUrl: CONFIG.theaterUrl,
    },
    ["J21"],
    true
  );

  if (!sent) {
    throw new Error(
      "The test could not send. Configure NTFY_TOPIC or all three Gmail secrets."
    );
  }
}

async function main() {
  if (TEST_NOTIFICATION) {
    await sendTestNotification();
    return;
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(60_000);
  await page.setViewport({ width: 1440, height: 1200 });
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  try {
    await runScan(page);
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    log(`Fatal error: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIG,
  getNewSeats,
  isAllowedShowtime,
  loadStateFile,
  nycDateString,
  panelConfirmsImax70mm,
  parseShowtimeMinutes,
  parseState,
  saveStateFile,
  sortSeats,
};
