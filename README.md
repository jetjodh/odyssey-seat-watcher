# The Odyssey - Lincoln Square IMAX 70mm seat watcher

This is a free GitHub Actions watcher for **AMC Lincoln Square 13**. It scans
all listed dates and checks every qualifying **The Odyssey - IMAX 70mm** seat
map, including showtimes AMC labels sold out.

## Your rules are already configured

- One ticket is enough.
- **Any showtime** for The Odyssey in IMAX 70mm counts.
- **Any open seat beyond the first 5 rows** (closest to the screen) counts.
- Wheelchair, accessible, and companion spaces are ignored.
- It checks up to 21 listed dates about every 10 minutes.
- The alert includes the exact seat, date, time, and AMC booking link.
- It remembers previous alerts, so an unchanged available seat does not spam
  you every ten minutes. If a seat disappears and later returns, it can alert
  again.

## Fastest setup: fork the original public repository

1. Sign in to GitHub and fork:
   `https://github.com/divkhare/amc-good-seats`
2. In your fork, open `amc-node.js`, click the pencil icon, replace the entire
   file with the `amc-node.js` included in this package, and commit to `main`.
3. Open `.github/workflows/check-seats.yml`, replace it with the included
   workflow file, and commit to `main`.
4. The original `package.json` and `package-lock.json` are compatible. You do
   not need to replace them when using the fork method.

Keep the fork public. Standard GitHub-hosted Action runs in public repositories
are free. Never put notification credentials directly in a source file.

## Free phone notifications with ntfy

1. Install the ntfy phone app or open the ntfy web app.
2. Subscribe to a long, random topic name. Treat the topic like a password.
3. In your GitHub fork, go to:
   `Settings -> Secrets and variables -> Actions -> New repository secret`
4. Create this secret:

   - Name: `NTFY_TOPIC`
   - Value: only your random topic name, not the full URL

The workflow posts to `https://ntfy.sh` by default. For a self-hosted ntfy
server, add an optional `NTFY_SERVER` secret containing the server base URL.

## Enable and test the workflow

1. Open the **Actions** tab in your fork and enable workflows if GitHub asks.
2. Select **Check Odyssey Seats**.
3. Choose **Run workflow**.
4. Turn on **Send a test notification only**, then run it.
5. After the test arrives, run it once more with **Scan and show matches in the
   log without notifying** enabled. Open that run to inspect the showtimes and
   seats found by the live AMC scan.
6. Run one normal scan with both switches off. The schedule then continues
   automatically.

When availability changes, the workflow creates or updates a hidden file named
`.odyssey-watcher-state.json`. It contains only showtime and seat deduplication
data. Do not delete it while the watcher is active. The workflow has narrowly
scoped `contents: write` permission solely so it can maintain this file.

## Optional email alerts through Gmail

Instead of, or in addition to, ntfy, add all three secrets below:

- `GMAIL_USER`: the Gmail account that sends the message
- `GMAIL_APP_PASSWORD`: a Gmail app password; do not use the normal password
- `NOTIFY_EMAIL`: the receiving address, or comma-separated addresses

## Change the seat or time rules

The editable settings are near the top of `amc-node.js` in `CONFIG`:

- `minShowtimeMinutes`
- `maxShowtimeMinutes`
- `maxDates`
- `targetSeatsByRow`

For example, to accept seats 17 through 27, replace `range(18, 26)` with
`range(17, 27)` for the desired rows.

## Limits

This is an unofficial personal watcher. AMC can change its pages at any time,
which may require selector updates. GitHub scheduled workflows are best effort
and can run late during periods of high load. An alert does not reserve the
seat, so open AMC immediately when one arrives.

A scheduled workflow in a public fork can be automatically disabled by GitHub
after 60 days with no repository activity. A small commit or manual workflow
run keeps the project active.

## Credit

Adapted from the public `divkhare/amc-good-seats` project and its ISC-licensed
Node/Puppeteer approach.
