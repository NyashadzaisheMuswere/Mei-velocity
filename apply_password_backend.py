"""Apply password-change + SMS password-reset routes to existing MEI Velocity backend/server.js.

Usage from the directory containing backend/server.js:
    python apply_password_backend.py

Always validates known anchors before writing; makes a backup.
"""
from pathlib import Path
import sys

server = Path('server.js') if Path('server.js').exists() else Path('backend/server.js')
if not server.exists():
    sys.exit('ERROR: Could not find server.js or backend/server.js. No changes made.')
src = server.read_text(encoding='utf-8-sig')
if 'MEI_PASSWORD_RECOVERY_V1' in src:
    sys.exit('Already installed: password recovery backend is present. No changes made.')

old_token = '''function makeCustomerToken(customerId) {
  const payload = Buffer.from(JSON.stringify({ customerId, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })).toString("base64url");
  const signature = crypto.createHmac("sha256", customerAuthSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}'''
new_token = '''function makeCustomerToken(customerId, tokenVersion = 0) {
  const payload = Buffer.from(JSON.stringify({
    customerId, tokenVersion, exp: Date.now() + 1000 * 60 * 60 * 24 * 30
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", customerAuthSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}'''
old_middleware = '''function customerAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const data = verifyCustomerToken(token);
  if (!data) return res.status(401).json({ success: false, message: "Please verify your phone number to continue." });
  req.customerId = data.customerId;
  next();
}

function optionalCustomerAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header) return next();
  const data = verifyCustomerToken(header.startsWith("Bearer ") ? header.slice(7) : "");
  if (!data) return res.status(401).json({ success: false, message: "Customer session expired. Please sign in again." });
  req.customerId = data.customerId;
  next();
}'''
new_middleware = '''async function customerAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const data = verifyCustomerToken(token);
  if (!data) return res.status(401).json({ success: false, message: "Your session has expired. Please sign in again." });
  try {
    // Check token version so a password reset revokes previously issued sessions.
    // Legacy tokens (without tokenVersion) are accepted only before first password update.
    const result = await pool.query(`SELECT "tokenVersion" FROM customers WHERE id=$1`, [data.customerId]);
    if (!result.rows.length || Number(result.rows[0].tokenVersion) !== Number(data.tokenVersion ?? 0)) {
      return res.status(401).json({ success: false, message: "Your session has expired. Please sign in again." });
    }
    req.customerId = data.customerId;
    next();
  } catch (error) {
    console.error("Customer session check failed:", error);
    res.status(500).json({ success: false, message: "Unable to check your session right now." });
  }
}

async function optionalCustomerAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header) return next();
  return customerAuth(req, res, next);
}'''
old_init = '''  // Older passwordless users can have duplicate usernames; enforce uniqueness'''
new_init = '''  // MEI_PASSWORD_RECOVERY_V1: token revocation and expiring phone reset challenges.
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_password_resets (
      phone TEXT PRIMARY KEY REFERENCES customers(phone) ON DELETE CASCADE,
      "codeHash" TEXT NOT NULL,
      "expiresAt" TIMESTAMPTZ NOT NULL,
      "sentAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "windowStart" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "requestCount" INTEGER NOT NULL DEFAULT 1,
      attempts INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Older passwordless users can have duplicate usernames; enforce uniqueness'''
old_login_selection = '''SELECT id, username, phone, "passwordHash"
      FROM customers
      WHERE LOWER(username)=LOWER($1) AND "passwordHash" IS NOT NULL'''
new_login_selection = '''SELECT id, username, phone, "passwordHash", "tokenVersion"
      FROM customers
      WHERE LOWER(username)=LOWER($1) AND "passwordHash" IS NOT NULL'''
repls = [
    (old_token, new_token, 'token creation'),
    (old_middleware, new_middleware, 'session verification'),
    (old_init, new_init, 'database migration'),
    (old_login_selection, new_login_selection, 'customer login'),
    ('token: makeCustomerToken(customer.id)', 'token: makeCustomerToken(customer.id, customer.tokenVersion ?? 0)', 'login and SMS token return'),
]
for a,b,label in repls:
    if a not in src: sys.exit(f'ERROR: Backend changed, cannot locate {label}; no changes made.')
    src=src.replace(a,b)
# Signup, legacy upgrade and SMS legacy sign-in must receive the corresponding
# persisted version, rather than defaulting to 0.
need = [
  ('RETURNING id,username,phone', 'RETURNING id,username,phone,"tokenVersion"'),
  ('WHERE phone=$1 RETURNING id,username,phone', 'WHERE phone=$1 RETURNING id,username,phone,"tokenVersion"')
]
for a,b in need:
    if a not in src: sys.exit(f'ERROR: Missing SMS token-version anchor {a}; no changes made.')
    src=src.replace(a,b)

api = r'''
/* =========================================================
   MEI_PASSWORD_RECOVERY_V1
   Change password: current password + authenticated session.
   Forgot password: a short-lived SMS code sent to the phone on the account.
   Changing or resetting a password invalidates older access tokens.
========================================================= */

const RESET_GENERIC_REPLY = "If that phone number has a password account, a reset code will be sent. Check your SMS messages.";
function validCustomerPassword(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 128;
}
function resetCodeHash(phone, code) {
  return crypto.createHmac("sha256", customerAuthSecret())
    .update(`password-reset:${phone}:${code}`).digest("hex");
}

app.post("/api/customer/change-password", customerAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== "string" || !validCustomerPassword(newPassword)) {
    return res.status(400).json({ success: false, message: "Enter your current password and a new password of 8–128 characters." });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ success: false, message: "Choose a different password." });
  }
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query("BEGIN"); begun = true;
    const found = await client.query(
      `SELECT id, username, "passwordHash" FROM customers WHERE id=$1 FOR UPDATE`, [req.customerId]
    );
    const customer = found.rows[0];
    if (!customer || !customer.passwordHash) {
      await client.query("ROLLBACK"); begun = false;
      return res.status(403).json({ success: false, message: "This account needs a password. Contact support for help." });
    }
    if (!(await verifyPassword(currentPassword, customer.passwordHash))) {
      await client.query("ROLLBACK"); begun = false;
      return res.status(401).json({ success: false, message: "Your current password is incorrect." });
    }
    const passwordHash = await hashPassword(newPassword);
    const updated = await client.query(`
      UPDATE customers
      SET "passwordHash"=$1, "tokenVersion"="tokenVersion"+1
      WHERE id=$2 RETURNING "tokenVersion"
    `, [passwordHash, req.customerId]);
    await client.query(`DELETE FROM customer_login_attempts WHERE username=$1`, [customer.username.toLowerCase()]);
    await client.query(`DELETE FROM customer_password_resets WHERE phone=(SELECT phone FROM customers WHERE id=$1)`, [req.customerId]);
    await client.query("COMMIT"); begun = false;
    return res.json({ success: true, message: "Password changed successfully.",
      token: makeCustomerToken(req.customerId, updated.rows[0].tokenVersion) });
  } catch (error) {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    console.error("Change customer password failed:", error);
    return res.status(500).json({ success: false, message: "Unable to change your password right now." });
  } finally { client.release(); }
});

app.post("/api/customer/forgot-password/request", async (req, res) => {
  const phone = normalizePhoneNumber(req.body?.phone);
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    return res.status(400).json({ success: false, message: "Enter a valid phone number with country code." });
  }
  const localOtp = isLocalCustomerOtpEnabled(req);
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!customerAuthSecret() || (!localOtp && (!sid || !token || (!verifySid && !from)))) {
    return res.status(503).json({ success: false, message: "SMS password recovery is temporarily unavailable." });
  }
  try {
    const customers = await pool.query(
      `SELECT id FROM customers WHERE phone=$1 AND "passwordHash" IS NOT NULL LIMIT 1`, [phone]
    );
    // Do not disclose whether a phone number has an account.
    if (!customers.rows.length) return res.json({ success: true, message: RESET_GENERIC_REPLY });

    const existing = await pool.query(`SELECT "sentAt", "windowStart", "requestCount"
      FROM customer_password_resets WHERE phone=$1`, [phone]);
    const row = existing.rows[0];
    if (row && (Date.now() - new Date(row.sentAt).getTime() < 60000 ||
        (Date.now() - new Date(row.windowStart).getTime() < 3600000 && Number(row.requestCount) >= 5))) {
      return res.json({ success: true, message: RESET_GENERIC_REPLY });
    }

    let otp = null;
    let codeHash;
    if (localOtp) {
      otp = String(crypto.randomInt(100000, 1000000));
      console.info(`[LOCAL PASSWORD RESET] SMS code for ${phone}: ${otp}`);
      codeHash = resetCodeHash(phone, otp);
    } else if (verifySid) {
      const response = await fetch(
        `https://verify.twilio.com/v2/Services/${encodeURIComponent(verifySid)}/Verifications`,
        { method: "POST", headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        }, body: new URLSearchParams({ To: phone, Channel: "sms" }) }
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.warn("SMS reset request rejected:", error.code || response.status);
        return res.status(502).json({ success: false, message: "Unable to send an SMS right now. Please try later." });
      }
      codeHash = resetCodeHash(phone, `verify:${crypto.randomUUID()}`);
    } else {
      otp = String(crypto.randomInt(100000, 1000000));
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
        { method: "POST", headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        }, body: new URLSearchParams({
          To: phone, From: from,
          Body: `MEI Velocity password reset code: ${otp}. Expires in 10 minutes. Do not share this code.`
        }) }
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.warn("SMS reset request rejected:", error.code || response.status);
        return res.status(502).json({ success: false, message: "Unable to send an SMS right now. Please try later." });
      }
      codeHash = resetCodeHash(phone, otp);
    }
    await pool.query(`
      INSERT INTO customer_password_resets
        (phone,"codeHash","expiresAt","sentAt","windowStart","requestCount",attempts)
      VALUES ($1,$2,NOW()+INTERVAL '10 minutes',NOW(),NOW(),1,0)
      ON CONFLICT (phone) DO UPDATE SET
        "codeHash"=EXCLUDED."codeHash", "expiresAt"=EXCLUDED."expiresAt",
        "sentAt"=NOW(), attempts=0,
        "requestCount"=CASE
          WHEN customer_password_resets."windowStart" < NOW()-INTERVAL '1 hour' THEN 1
          ELSE customer_password_resets."requestCount"+1 END,
        "windowStart"=CASE
          WHEN customer_password_resets."windowStart" < NOW()-INTERVAL '1 hour' THEN NOW()
          ELSE customer_password_resets."windowStart" END
    `, [phone, codeHash]);
    return res.json({ success: true, message: RESET_GENERIC_REPLY });
  } catch (error) {
    console.error("Request customer password reset failed:", error);
    return res.status(500).json({ success: false, message: "Unable to request a reset right now." });
  }
});

app.post("/api/customer/forgot-password/confirm", async (req, res) => {
  const phone = normalizePhoneNumber(req.body?.phone);
  const code = String(req.body?.code || "").trim();
  const newPassword = req.body?.newPassword;
  if (!/^\+[1-9]\d{6,14}$/.test(phone) || !/^\d{6}$/.test(code) || !validCustomerPassword(newPassword)) {
    return res.status(400).json({ success: false, message: "Enter the 6-digit SMS code and a new password of 8–128 characters." });
  }
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query("BEGIN"); begun = true;
    const found = await client.query(
      `SELECT "codeHash","expiresAt",attempts FROM customer_password_resets WHERE phone=$1 FOR UPDATE`, [phone]
    );
    const challenge = found.rows[0];
    if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now() || challenge.attempts >= 5) {
      await client.query("ROLLBACK"); begun = false;
      return res.status(400).json({ success: false, message: "Code expired or unavailable. Request a new code." });
    }
    await client.query(`UPDATE customer_password_resets SET attempts=attempts+1 WHERE phone=$1`, [phone]);
    let approved = false;
    if (isLocalCustomerOtpEnabled(req) || !process.env.TWILIO_VERIFY_SERVICE_SID) {
      const expected = Buffer.from(challenge.codeHash, "hex");
      const actual = Buffer.from(resetCodeHash(phone, code), "hex");
      approved = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } else {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;
      const response = await fetch(
        `https://verify.twilio.com/v2/Services/${encodeURIComponent(verifySid)}/VerificationCheck`,
        { method: "POST", headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        }, body: new URLSearchParams({ To: phone, Code: code }) }
      );
      const result = await response.json().catch(() => ({}));
      approved = response.ok && result.status === "approved";
    }
    if (!approved) {
      // Commit failed attempt so the five-try limit cannot be bypassed.
      await client.query("COMMIT"); begun = false;
      return res.status(400).json({ success: false, message: "Incorrect verification code." });
    }
    const newHash = await hashPassword(newPassword);
    const updated = await client.query(`
      UPDATE customers SET "passwordHash"=$1, "tokenVersion"="tokenVersion"+1
      WHERE phone=$2 AND "passwordHash" IS NOT NULL RETURNING username
    `, [newHash, phone]);
    if (!updated.rows.length) {
      await client.query("ROLLBACK"); begun = false;
      return res.status(400).json({ success: false, message: "This account cannot be reset. Please contact support." });
    }
    await client.query(`DELETE FROM customer_password_resets WHERE phone=$1`, [phone]);
    await client.query(`DELETE FROM customer_login_attempts WHERE username=$1`, [updated.rows[0].username.toLowerCase()]);
    await client.query("COMMIT"); begun = false;
    return res.json({ success: true, message: "Password reset. Sign in with your new password." });
  } catch (error) {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    console.error("Confirm customer password reset failed:", error);
    return res.status(500).json({ success: false, message: "Unable to reset the password right now." });
  } finally { client.release(); }
});

'''
anchor = '/* Customer account deletion: verified session plus password recheck for password accounts. */'
if anchor not in src: sys.exit('ERROR: Existing account deletion route missing. Do not deploy a backend without deletion. No changes made.')
src=src.replace(anchor, api+anchor,1)
# Validate output and make backup only after every anchor has matched.
for needed in ['MEI_PASSWORD_RECOVERY_V1', 'app.post("/api/customer/forgot-password/request"', 'app.post("/api/customer/change-password"', '"tokenVersion"="tokenVersion"+1', 'app.delete("/api/customer/account"']:
  if needed not in src: sys.exit('ERROR: Could not generate backend patch. No changes made.')
backup = server.with_name('server.js.before_password_recovery.bak')
if backup.exists(): sys.exit(f'ERROR: Backup already exists: {backup}. No changes made.')
backup.write_bytes(server.read_bytes())
try:
    server.write_text(src, encoding='utf-8')
except Exception:
    server.write_bytes(backup.read_bytes())
    raise
print(f'SUCCESS: Updated {server} with change-password and SMS forgot-password routes.')
print(f'Backup: {backup}. Deploy the updated backend to Render BEFORE testing in Expo.')
