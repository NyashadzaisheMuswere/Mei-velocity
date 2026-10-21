"""Safely add Expo customer push tokens and driver-message push to server.js.

Run in BACKEND directory containing server.js (or project root containing
backend/server.js): python apply_driver_push_backend.py

Preserves existing web-push subscriptions, driver chat, messages, accounts,
booking, SMS password reset and the PostgreSQL schema.
"""
from pathlib import Path
import re
import sys

server = Path('server.js') if Path('server.js').is_file() else Path('backend/server.js')
if not server.is_file():
    sys.exit('No server.js / backend/server.js found. No changes made.')
src = server.read_text(encoding='utf-8-sig')
if 'MEI_EXPO_DRIVER_PUSH_V1' in src:
    sys.exit('Expo driver push already installed. No changes made.')
if 'async function initializeDatabase()' not in src or 'customerAuth' not in src or 'driverAuth' not in src:
    sys.exit('Unexpected MEI Velocity backend structure; no changes made.')
if src.count('app.post("/api/driver/bookings/:id/messages", driverAuth') != 1:
    sys.exit('Cannot locate a unique driver send-message route. No changes made.')
if 'ALTER TABLE customers ADD COLUMN IF NOT EXISTS "tokenVersion"' not in src:
    sys.exit('This backend does not include the earlier password/session update. Deploy that update first; no changes made.')

# Database auto-migration runs via the existing initializeDatabase() startup.
init_start = src.index('async function initializeDatabase()')
verification = src.find('CREATE TABLE IF NOT EXISTS customer_verification_codes', init_start)
if verification == -1:
    sys.exit('Could not find customer verification table in database initialization. No changes made.')
insert_at = src.rfind('  await pool.query(`', init_start, verification)
if insert_at == -1:
    sys.exit('Database migration insertion point not found. No changes made.')
migration = '''  // MEI_EXPO_DRIVER_PUSH_V1: native mobile Expo push tokens (separate from web-push).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_expo_push_tokens (
      token TEXT PRIMARY KEY,
      "customerId" TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      platform TEXT NOT NULL DEFAULT 'unknown',
      "tokenVersion" INTEGER NOT NULL DEFAULT 0,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS customer_expo_push_tokens_customer_idx
    ON customer_expo_push_tokens ("customerId")
  `);
'''
src = src[:insert_at] + migration + src[insert_at:]

# Authenticated routes are inserted immediately before the current driver
# message POST route; existing web-push stays untouched.
route_anchor = 'app.post("/api/driver/bookings/:id/messages", driverAuth, async (req, res) => {'
route_pos = src.index(route_anchor)
server_features = r'''/* =========================================================
   MEI_EXPO_DRIVER_PUSH_V1: native iOS/Android customer chat alerts
   The existing web-push API is deliberately preserved.
========================================================= */

const MEI_EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MEI_EXPO_TOKEN_RE = /^(?:ExponentPushToken|ExpoPushToken)\[[\w-]{10,}\]$/;

app.post("/api/customer/expo-push-token", customerAuth, async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  const platform = req.body?.platform === "ios" || req.body?.platform === "android"
    ? req.body.platform : "unknown";
  if (!MEI_EXPO_TOKEN_RE.test(token)) {
    return res.status(400).json({ success: false, message: "Invalid mobile push token." });
  }
  try {
    await pool.query(`
      INSERT INTO customer_expo_push_tokens (token,"customerId",platform,"tokenVersion")
      VALUES ($1,$2,$3,(SELECT "tokenVersion" FROM customers WHERE id=$2))
      ON CONFLICT (token) DO UPDATE SET
        "customerId"=EXCLUDED."customerId",
        platform=EXCLUDED.platform,
        "tokenVersion"=EXCLUDED."tokenVersion",
        "updatedAt"=NOW()
    `, [token, req.customerId, platform]);
    // Limit stale/old devices without impacting current active phones.
    await pool.query(`
      DELETE FROM customer_expo_push_tokens WHERE "customerId"=$1 AND token NOT IN (
        SELECT token FROM customer_expo_push_tokens WHERE "customerId"=$1
        ORDER BY "updatedAt" DESC LIMIT 8
      )
    `, [req.customerId]);
    res.json({ success: true });
  } catch (error) {
    console.error("Expo token registration failed:", error);
    res.status(500).json({ success: false, message: "Could not enable notifications." });
  }
});

app.delete("/api/customer/expo-push-token", customerAuth, async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!MEI_EXPO_TOKEN_RE.test(token)) {
    return res.status(400).json({ success: false, message: "Invalid push token." });
  }
  try {
    await pool.query(`DELETE FROM customer_expo_push_tokens
      WHERE token=$1 AND "customerId"=$2`, [token, req.customerId]);
    res.json({ success: true });
  } catch (error) {
    console.error("Expo token removal failed:", error);
    res.status(500).json({ success: false, message: "Could not disable notifications." });
  }
});

// This only runs after an AUTHENTICATED, ASSIGNED driver has stored a message.
// All errors are isolated from successful message delivery.
async function sendMeiExpoDriverChatPush(customerId, rideId, driverName, message) {
  if (!customerId) return;
  try {
    const found = await pool.query(`SELECT t.token FROM customer_expo_push_tokens t
      JOIN customers c ON c.id=t."customerId"
      WHERE t."customerId"=$1 AND t."tokenVersion"=c."tokenVersion"
      ORDER BY t."updatedAt" DESC LIMIT 8`, [customerId]);
    if (!found.rows.length) return;
    const name = String(driverName || "your driver").slice(0, 60);
    const preview = String(message?.body || "Open MEI Velocity to read it").slice(0, 140);
    const tokens = found.rows.map(row => row.token);
    const notifications = tokens.map(to => ({
      to,
      title: `Message from ${name}`,
      body: preview,
      sound: "default",
      priority: "high",
      channelId: "driver-messages",
      data: {
        type: "driver-message",
        bookingId: String(rideId),
        messageId: String(message?.id || ""),
      },
    }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(MEI_EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          ...(process.env.EXPO_ACCESS_TOKEN
            ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
        },
        body: JSON.stringify(notifications),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      console.warn("Expo push request failed:", response.status);
      return;
    }
    const result = await response.json().catch(() => null);
    const tickets = Array.isArray(result?.data) ? result.data :
      result?.data ? [result.data] : [];
    // Remove unregistered phones when Expo reports an invalid device token.
    for (let i = 0; i < tickets.length; i++) {
      if (tickets[i]?.status === "error") {
        console.warn("Expo push ticket:", tickets[i]?.details?.error || tickets[i]?.message);
        if (tickets[i]?.details?.error === "DeviceNotRegistered") {
          await pool.query("DELETE FROM customer_expo_push_tokens WHERE token=$1 AND \"customerId\"=$2",
            [tokens[i], customerId]);
        }
      }
    }
  } catch (error) {
    console.warn("Could not send driver message push:", error?.message || error);
  }
}

'''
src = src[:route_pos] + server_features + src[route_pos:]

# Modify ONLY the driver send route, not the customer send route.
route_pos = src.index(route_anchor)
end_pos = src.find('app.patch(', route_pos)
if end_pos == -1 or end_pos-route_pos > 18000:
    sys.exit('Driver message route end not found; no changes made.')
segment = src[route_pos:end_pos]
expected_query = 'SELECT id FROM bookings WHERE id=$1 AND "assignedDriverId"=$2 AND ${CHAT_AVAILABLE_RIDE_SQL}'
if segment.count(expected_query) != 1:
    sys.exit('Unexpected driver chat query; no changes made.')
segment = segment.replace(expected_query, 'SELECT id, "customerId" FROM bookings WHERE id=$1 AND "assignedDriverId"=$2 AND ${CHAT_AVAILABLE_RIDE_SQL}', 1)
send_needle = '    res.status(201).json({ success: true, message });'
if segment.count(send_needle) != 1:
    sys.exit('Driver message persistence response not found; no changes made.')
segment = segment.replace(send_needle, send_needle + '''
    // Notify the correct customer's registered native phone(s).
    // Push failure never causes the driver to resend an already saved message.
    void sendMeiExpoDriverChatPush(
      ride.rows[0].customerId,
      req.params.id,
      driver.rows[0]?.name || "your driver",
      message
    );''', 1)
src = src[:route_pos] + segment + src[end_pos:]

if src.count('MEI_EXPO_DRIVER_PUSH_V1') != 2 or src.count('void sendMeiExpoDriverChatPush(') != 1:
    sys.exit('Validation failed. No changes made.')
backup = server.with_name('server.js.before_expo_driver_push.bak')
if backup.exists():
    sys.exit('A driver-push server backup already exists. Check first; nothing changed.')
backup.write_bytes(server.read_bytes())
try:
    server.write_text(src, encoding='utf-8')
except Exception:
    server.write_bytes(backup.read_bytes())
    raise
print(f'SUCCESS: {server} now saves Expo push tokens and sends a notification on new driver messages.')
print(f'Backup: {backup}')
print('Push messages use existing driver-auth and customer-ownership checks.')
print('Run: node --check server.js and deploy backend to Render.')
