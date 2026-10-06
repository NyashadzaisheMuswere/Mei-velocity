require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const webpush = require("web-push");
const { Pool } = require("pg");

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY;

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY;

if (
  VAPID_PUBLIC_KEY &&
  VAPID_PRIVATE_KEY
) {
  webpush.setVapidDetails(
    "mailto:support@meivelocity.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

const LOCAL_CUSTOMER_AUTH_SECRET = crypto.randomBytes(32).toString("hex");

function customerAuthSecret() {
  if (process.env.CUSTOMER_AUTH_SECRET) return process.env.CUSTOMER_AUTH_SECRET;
  if (process.env.LOCAL_OTP_MODE === "true" && process.env.NODE_ENV !== "production") return LOCAL_CUSTOMER_AUTH_SECRET;
  return null;
}

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function adminAuth(req, res, next) {
  const password = req.headers["x-admin-password"];
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ success: false, message: "ADMIN_PASSWORD is not configured." });
  }
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }
  next();
}

function authSecret() {
  return process.env.DRIVER_AUTH_SECRET || process.env.ADMIN_PASSWORD || "change-this-secret";
}

function makeDriverToken(driverId) {
  const payload = Buffer.from(JSON.stringify({ driverId, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })).toString("base64url");
  const signature = crypto.createHmac("sha256", authSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function makeCustomerToken(customerId) {
  const payload = Buffer.from(JSON.stringify({ customerId, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })).toString("base64url");
  const signature = crypto.createHmac("sha256", customerAuthSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyCustomerToken(token) {
  try {
    const [payload, signature] = String(token || "").split(".");
    if (!payload || !signature) return null;
    const secret = customerAuthSecret();
    if (!secret) return null;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.customerId && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function customerAuth(req, res, next) {
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
}

function phoneCodeHash(phone, code) {
  return crypto.createHmac("sha256", customerAuthSecret()).update(`${phone}:${code}`).digest("hex");
}

const CUSTOMER_PASSWORD_SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function deriveCustomerPassword(password, salt, keylen = CUSTOMER_PASSWORD_SCRYPT.keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, {
      N: CUSTOMER_PASSWORD_SCRYPT.N,
      r: CUSTOMER_PASSWORD_SCRYPT.r,
      p: CUSTOMER_PASSWORD_SCRYPT.p,
      maxmem: 64 * 1024 * 1024
    }, (error, key) => error ? reject(error) : resolve(key));
  });
}

async function hashCustomerPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await deriveCustomerPassword(password, salt);
  return `scrypt$${CUSTOMER_PASSWORD_SCRYPT.N}$${CUSTOMER_PASSWORD_SCRYPT.r}$${CUSTOMER_PASSWORD_SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function verifyCustomerPassword(password, encoded) {
  try {
    const [scheme, n, r, p, saltText, hashText] = String(encoded || "").split("$");
    if (scheme !== "scrypt" || Number(n) !== CUSTOMER_PASSWORD_SCRYPT.N || Number(r) !== CUSTOMER_PASSWORD_SCRYPT.r || Number(p) !== CUSTOMER_PASSWORD_SCRYPT.p || !saltText || !hashText) return false;
    const expected = Buffer.from(hashText, "base64url");
    const actual = await deriveCustomerPassword(password, Buffer.from(saltText, "base64url"), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function validCustomerPassword(value) {
  return typeof value === "string" && [...value].length >= 8 && [...value].length <= 128 && Buffer.byteLength(value, "utf8") <= 512;
}

function validCustomerPhone(phone) {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

function normalizePhoneNumber(value) {
  const raw = String(value || "").normalize("NFKC")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";

  // Keep explicit international prefixes intact; accept 00 as an alternative
  // international dialing prefix. Bare local Zimbabwe numbers remain supported.
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("263")) return `+${digits}`;
  if (digits.startsWith("0")) return `+263${digits.slice(1)}`;
  return digits;
}

function verifyDriverToken(token) {
  try {
    const [payload, signature] = String(token || "").split(".");
    if (!payload || !signature) return null;
    const expected = crypto.createHmac("sha256", authSecret()).update(payload).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.driverId || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function driverAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const data = verifyDriverToken(token);
  if (!data) return res.status(401).json({ success: false, message: "Driver login required." });
  req.driverId = data.driverId;
  next();
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    try {
      const [salt, keyHex] = String(stored).split(":");
      const storedKey = Buffer.from(keyHex, "hex");
      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) return reject(err);
        resolve(storedKey.length === derivedKey.length && crypto.timingSafeEqual(storedKey, derivedKey));
      });
    } catch {
      resolve(false);
    }
  });
}

function publicDriver(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    vehicle: row.vehicle,
    plate: row.plate,
    status: row.status,
    active: row.active,
    lat: row.lat,
    lng: row.lng,
    createdAt: row.createdAt
  };
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      "verifiedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      "passwordHash" TEXT,
      "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS "passwordHash" TEXT
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_pending_registrations (
      phone TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      "passwordHash" TEXT NOT NULL,
      "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_password_reset_codes (
      phone TEXT PRIMARY KEY,
      "codeHash" TEXT NOT NULL,
      "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "sentAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_verification_codes (
      phone TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      "codeHash" TEXT NOT NULL,
      "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "sentAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      pickup TEXT NOT NULL,
      dropoff TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      vehicle TEXT,
      distance NUMERIC DEFAULT 0,
      fare NUMERIC DEFAULT 0,
      payment TEXT DEFAULT 'Cash',
      status TEXT DEFAULT 'Pending',
      "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_messages (
      id BIGSERIAL PRIMARY KEY,
      "bookingId" TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      "senderType" TEXT NOT NULL CHECK ("senderType" IN ('customer', 'driver')),
      "senderId" TEXT NOT NULL,
      "senderName" TEXT NOT NULL,
      body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_booking_messages_booking ON booking_messages ("bookingId", id)`);
  await pool.query(`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS "customerId" TEXT REFERENCES customers(id),
    ADD COLUMN IF NOT EXISTS "promoCode" TEXT,
    ADD COLUMN IF NOT EXISTS discount NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "baseFare" NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rating INTEGER,
    ADD COLUMN IF NOT EXISTS "ratedAt" TIMESTAMP WITH TIME ZONE
  `);
  await pool.query(`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS "assignedDriverId" TEXT
  `);
  await pool.query(`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS "driverLat" NUMERIC,
    ADD COLUMN IF NOT EXISTS "driverLng" NUMERIC,
    ADD COLUMN IF NOT EXISTS "driverLocationUpdatedAt" TIMESTAMP WITH TIME ZONE
  `);
  await pool.query(`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS "assignedDriverName" TEXT
  `);
  await pool.query(`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS "assignedAt" TIMESTAMP WITH TIME ZONE
  `);
  await pool.query(`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS "driverStatus" TEXT DEFAULT 'Accepted'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_offers (
      id BIGSERIAL PRIMARY KEY,
      "bookingId" TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      "driverId" TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'Pending',
      "offeredAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "respondedAt" TIMESTAMP WITH TIME ZONE,
      UNIQUE ("bookingId", "driverId")
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_driver_offers_driver_status
    ON driver_offers ("driverId", status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_driver_offers_booking_status
    ON driver_offers ("bookingId", status)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS drivers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      vehicle TEXT NOT NULL,
      plate TEXT NOT NULL,
      "passwordHash" TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Offline',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      lat NUMERIC,
      lng NUMERIC,
      "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  console.log("MEI Velocity database ready.");
}

app.get("/", (req, res) => res.json({ message: "MEI Velocity backend is running" }));
app.get("/api/test", (req, res) => res.json({ success: true, message: "MEI Velocity API is working" }));
// DISPATCH ENGINE
async function expireOldOffers() {
  await pool.query(`
    UPDATE driver_offers
    SET status='Expired', "respondedAt"=NOW()
    WHERE status='Pending' AND "expiresAt" <= NOW()
  `);
}

async function dispatchBooking(bookingId) {
  await expireOldOffers();

  const drivers = await pool.query(`
    SELECT id
    FROM drivers
    WHERE active=true AND status='Online'
  `);

  let created = 0;

  for (const driver of drivers.rows) {
    const result = await pool.query(`
      INSERT INTO driver_offers
      ("bookingId","driverId",status,"expiresAt")
      VALUES ($1,$2,'Pending',NOW()+INTERVAL '30 minutes')
      ON CONFLICT ("bookingId","driverId")
      DO UPDATE SET
        status='Pending',
        "offeredAt"=NOW(),
        "expiresAt"=NOW()+INTERVAL '30 minutes',
        "respondedAt"=NULL
      WHERE driver_offers.status='Expired'
      RETURNING id
    `, [bookingId, driver.id]);

    if (result.rows.length) {
      created++;
    }
  }

  return created;
}

async function dispatchPendingBookings() {
  const pending = await pool.query(`
    SELECT id FROM bookings
    WHERE status='Pending' AND "assignedDriverId" IS NULL
    ORDER BY "createdAt" ASC
  `);
  let created = 0;
  for (const booking of pending.rows) created += await dispatchBooking(booking.id);
  return created;
}

// DRIVER OFFER ROUTES

app.get("/api/driver/offers", driverAuth, async (req, res) => {
  try {
    await expireOldOffers();

    const result = await pool.query(`
      SELECT
        driver_offers.id,
        driver_offers."bookingId",
        driver_offers.status,
        driver_offers."offeredAt",
        bookings.name,
        bookings.phone,
        bookings.pickup,
        bookings.dropoff,
        bookings.date,
        bookings.time,
        bookings.vehicle,
        bookings.distance,
        bookings.fare,
        bookings.payment
      FROM driver_offers
      JOIN bookings
        ON bookings.id = driver_offers."bookingId"
      WHERE driver_offers."driverId" = $1
        AND driver_offers.status = 'Pending'
        AND bookings.status = 'Pending'
      ORDER BY driver_offers."offeredAt" DESC
    `, [req.driverId]);

    res.json({
      success: true,
      offers: result.rows
    });

  } catch (error) {
    console.error("Driver offers error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load driver offers."
    });
  }
});


app.post("/api/driver/offers/:id/reject", driverAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE driver_offers
      SET status = 'Rejected'
      WHERE id = $1
        AND "driverId" = $2
        AND status = 'Pending'
      RETURNING *
    `, [req.params.id, req.driverId]);

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Offer is no longer available."
      });
    }

    res.json({
      success: true,
      message: "Ride offer rejected."
    });

  } catch (error) {
    console.error("Reject offer error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to reject offer."
    });
  }
});


app.post("/api/driver/offers/:id/accept", driverAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      UPDATE driver_offers
      SET status = 'Expired'
      WHERE status = 'Pending'
        AND "expiresAt" < NOW()
    `);

    const offerResult = await client.query(`
      SELECT *
      FROM driver_offers
      WHERE id = $1
        AND "driverId" = $2
      FOR UPDATE
    `, [req.params.id, req.driverId]);

    if (!offerResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Ride offer not found."
      });
    }

    const offer = offerResult.rows[0];

    if (offer.status !== "Pending") {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "This ride is no longer available."
      });
    }

    const bookingResult = await client.query(`
      SELECT *
      FROM bookings
      WHERE id = $1
      FOR UPDATE
    `, [offer.bookingId]);

    if (!bookingResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Booking not found."
      });
    }

    const booking = bookingResult.rows[0];

    if (
      booking.status !== "Pending" ||
      booking.assignedDriverId
    ) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "This ride has already been assigned."
      });
    }

    const driverResult = await client.query(`
      SELECT *
      FROM drivers
      WHERE id = $1
        AND active = true
      FOR UPDATE
    `, [req.driverId]);

    if (!driverResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Driver account not found."
      });
    }

    const driver = driverResult.rows[0];

    if (driver.status !== "Online") {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "You must be Online to accept a ride."
      });
    }

    const assignedAt = new Date();

    await client.query(`
      UPDATE bookings
      SET
        status = 'Confirmed',
        "assignedDriverId" = $1,
        "assignedDriverName" = $2,
        "assignedAt" = $3,
        "driverStatus" = 'Accepted'
      WHERE id = $4
    `, [
      driver.id,
      driver.name,
      assignedAt,
      booking.id
    ]);

    await client.query(`
      UPDATE drivers
      SET status = 'Busy'
      WHERE id = $1
    `, [driver.id]);

    await client.query(`
      UPDATE driver_offers
      SET status = 'Accepted'
      WHERE id = $1
    `, [offer.id]);

    await client.query(`
      UPDATE driver_offers
      SET status = 'Expired'
      WHERE "bookingId" = $1
        AND id <> $2
        AND status = 'Pending'
    `, [booking.id, offer.id]);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Ride accepted successfully.",
      booking: {
        ...booking,
        status: "Confirmed",
        assignedDriverId: driver.id,
        assignedDriverName: driver.name,
        assignedAt
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Accept offer error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to accept ride."
    });

  } finally {
    client.release();
  }
});
// DRIVER CURRENT RIDE
const DRIVER_RIDE_STATUSES = ["Accepted", "On the Way", "Arrived", "Picked Up", "Completed"];

app.get("/api/driver/current-ride", driverAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM bookings
      WHERE "assignedDriverId" = $1
        AND status = 'Confirmed'
        AND "driverStatus" IN ('Accepted','On the Way','Arrived','Picked Up')
      ORDER BY "assignedAt" DESC NULLS LAST, "createdAt" DESC
      LIMIT 1
    `, [req.driverId]);

    if (!result.rows.length) {
      const lastCompleted = await pool.query(`
        SELECT *
        FROM bookings
        WHERE "assignedDriverId" = $1
          AND status = 'Completed'
          AND "driverStatus" = 'Completed'
        ORDER BY "assignedAt" DESC NULLS LAST, "createdAt" DESC
        LIMIT 1
      `, [req.driverId]);
      return res.json({ success: true, ride: lastCompleted.rows[0] || null });
    }

    res.json({
      success: true,
      ride: result.rows[0] || null
    });
  } catch (error) {
    console.error("Current ride error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load current ride."
    });
  }
});

// RIDE CHAT: only the assigned driver and verified customer can access it.
const CHAT_AVAILABLE_RIDE_SQL = `((status = 'Confirmed' AND "driverStatus" IN ('Accepted','On the Way','Arrived','Picked Up')) OR (status = 'Completed' AND "driverStatus" = 'Completed'))`;

async function readRideMessages(bookingId) {
  const result = await pool.query(`
    SELECT id, "senderType", "senderId", "senderName", body, "createdAt"
    FROM (
      SELECT id, "senderType", "senderId", "senderName", body, "createdAt"
      FROM booking_messages WHERE "bookingId"=$1
      ORDER BY id DESC LIMIT 100
    ) recent ORDER BY id ASC
  `, [bookingId]);
  return result.rows;
}

async function saveRideMessage({ bookingId, senderType, senderId, senderName, body }) {
  const result = await pool.query(`
    INSERT INTO booking_messages ("bookingId", "senderType", "senderId", "senderName", body)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id, "senderType", "senderId", "senderName", body, "createdAt"
  `, [bookingId, senderType, senderId, senderName, body]);
  return result.rows[0];
}

app.get("/api/customer/bookings/:id/messages", customerAuth, async (req, res) => {
  try {
    const ride = await pool.query(`SELECT id FROM bookings WHERE id=$1 AND "customerId"=$2 AND ${CHAT_AVAILABLE_RIDE_SQL} AND "assignedDriverId" IS NOT NULL`, [req.params.id, req.customerId]);
    if (!ride.rows.length) return res.status(404).json({ success: false, message: "Chat is available after a driver accepts your ride." });
    res.json({ success: true, messages: await readRideMessages(req.params.id) });
  } catch (error) {
    console.error("Customer ride chat read error:", error);
    res.status(500).json({ success: false, message: "Unable to load ride messages." });
  }
});

app.post("/api/customer/bookings/:id/messages", customerAuth, async (req, res) => {
  const body = String(req.body.body || "").trim();
  if (!body || body.length > 1000) return res.status(400).json({ success: false, message: "Write a message up to 1,000 characters." });
  try {
    const ride = await pool.query(`SELECT id FROM bookings WHERE id=$1 AND "customerId"=$2 AND ${CHAT_AVAILABLE_RIDE_SQL} AND "assignedDriverId" IS NOT NULL`, [req.params.id, req.customerId]);
    if (!ride.rows.length) return res.status(404).json({ success: false, message: "Chat is available after a driver accepts your ride." });
    const customer = await pool.query(`SELECT username FROM customers WHERE id=$1`, [req.customerId]);
    const message = await saveRideMessage({ bookingId: req.params.id, senderType: "customer", senderId: req.customerId, senderName: customer.rows[0]?.username || "Customer", body });
    res.status(201).json({ success: true, message });
  } catch (error) {
    console.error("Customer ride chat send error:", error);
    res.status(500).json({ success: false, message: "Unable to send your message." });
  }
});

app.get("/api/driver/bookings/:id/messages", driverAuth, async (req, res) => {
  try {
    const ride = await pool.query(`SELECT id FROM bookings WHERE id=$1 AND "assignedDriverId"=$2 AND ${CHAT_AVAILABLE_RIDE_SQL}`, [req.params.id, req.driverId]);
    if (!ride.rows.length) return res.status(404).json({ success: false, message: "This ride chat is no longer available." });
    res.json({ success: true, messages: await readRideMessages(req.params.id) });
  } catch (error) {
    console.error("Driver ride chat read error:", error);
    res.status(500).json({ success: false, message: "Unable to load ride messages." });
  }
});

app.post("/api/driver/bookings/:id/messages", driverAuth, async (req, res) => {
  const body = String(req.body.body || "").trim();
  if (!body || body.length > 1000) return res.status(400).json({ success: false, message: "Write a message up to 1,000 characters." });
  try {
    const ride = await pool.query(`SELECT id FROM bookings WHERE id=$1 AND "assignedDriverId"=$2 AND ${CHAT_AVAILABLE_RIDE_SQL}`, [req.params.id, req.driverId]);
    if (!ride.rows.length) return res.status(404).json({ success: false, message: "This ride chat is no longer available." });
    const driver = await pool.query(`SELECT name FROM drivers WHERE id=$1`, [req.driverId]);
    const message = await saveRideMessage({ bookingId: req.params.id, senderType: "driver", senderId: req.driverId, senderName: driver.rows[0]?.name || "Driver", body });
    res.status(201).json({ success: true, message });
  } catch (error) {
    console.error("Driver ride chat send error:", error);
    res.status(500).json({ success: false, message: "Unable to send your message." });
  }
});
app.patch("/api/driver/current-ride/status", driverAuth, async (req, res) => {
  const { status } = req.body;

  if (!DRIVER_RIDE_STATUSES.includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid ride status."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const rideResult = await client.query(`
      SELECT *
      FROM bookings
      WHERE "assignedDriverId" = $1
        AND status = 'Confirmed'
        AND "driverStatus" IN ('Accepted','On the Way','Arrived','Picked Up')
      ORDER BY "assignedAt" DESC NULLS LAST, "createdAt" DESC
      LIMIT 1
      FOR UPDATE
    `, [req.driverId]);

    if (!rideResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "No current ride found."
      });
    }

    const ride = rideResult.rows[0];
    const currentIndex = DRIVER_RIDE_STATUSES.indexOf(ride.driverStatus);
    const nextIndex = DRIVER_RIDE_STATUSES.indexOf(status);

    if (nextIndex !== currentIndex + 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Next ride status must be "${DRIVER_RIDE_STATUSES[currentIndex + 1]}".`
      });
    }

    const completed = status === "Completed";

    const updated = await client.query(`
      UPDATE bookings
      SET
        "driverStatus" = $1,
        status = CASE WHEN $2 THEN 'Completed' ELSE status END
      WHERE id = $3
      RETURNING *
    `, [status, completed, ride.id]);

    if (completed) {
      await client.query(`
        UPDATE drivers
        SET status = 'Online'
        WHERE id = $1
      `, [req.driverId]);
    }

    await client.query("COMMIT");

    let pendingOffersCreated = 0;
    if (completed) {
      try {
        pendingOffersCreated = await dispatchPendingBookings();
      } catch (dispatchError) {
        console.error("Pending ride dispatch after completion error:", dispatchError);
      }
    }

    res.json({
      success: true,
      message: completed ? "Ride completed successfully." : "Ride status updated.",
      ride: updated.rows[0],
      pendingOffersCreated
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Current ride status error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to update ride status."
    });
  } finally {
    client.release();
  }
});


app.patch("/api/driver/location", driverAuth, async (req, res) => {
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({
      success: false,
      message: "Invalid GPS coordinates."
    });
  }

  try {
    const result = await pool.query(`
      UPDATE bookings
      SET
        "driverLat" = $1,
        "driverLng" = $2,
        "driverLocationUpdatedAt" = NOW()
      WHERE "assignedDriverId" = $3
        AND status = 'Confirmed'
        AND "driverStatus" IN ('Accepted','On the Way','Arrived','Picked Up')
      RETURNING id, "driverLat", "driverLng", "driverLocationUpdatedAt"
    `, [lat, lng, req.driverId]);

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "No active ride found."
      });
    }

    res.json({
      success: true,
      location: result.rows[0]
    });
  } catch (error) {
    console.error("Driver location error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to update driver location."
    });
  }
});

// CUSTOMER PHONE VERIFICATION AND ACCOUNT HISTORY
function isLocalCustomerOtpEnabled(req) {
  const host = String(req.hostname || "").toLowerCase();
  return process.env.LOCAL_OTP_MODE === "true"
    && process.env.NODE_ENV !== "production"
    && (host === "localhost" || host === "127.0.0.1");
}

app.post("/api/customer/register", async (req, res) => {
  const username = String(req.body.username || req.body.name || "").trim();
  const phone = normalizePhoneNumber(req.body.phone);
  const password = req.body.password;
  if (username.length < 2 || username.length > 40) {
    return res.status(400).json({ success: false, message: "Enter a name between 2 and 40 characters." });
  }
  if (!validCustomerPhone(phone)) {
    return res.status(400).json({ success: false, message: "Enter a valid phone number with its country code." });
  }
  if (!validCustomerPassword(password)) {
    return res.status(400).json({ success: false, message: "Use a password with 8 to 128 characters." });
  }
  if (!customerAuthSecret()) {
    return res.status(503).json({ success: false, message: "Customer sign-in is not configured on the server." });
  }
  try {
    const existing = await pool.query("SELECT \"passwordHash\" FROM customers WHERE phone=$1", [phone]);
    if (existing.rows[0]?.passwordHash) {
      return res.status(409).json({ success: false, message: "An account already uses this number. Sign in or choose SMS verification." });
    }
    const passwordHash = await hashCustomerPassword(password);
    await pool.query(
      "INSERT INTO customer_pending_registrations (phone, username, \"passwordHash\", \"expiresAt\", \"createdAt\") " +
      "VALUES ($1,$2,$3,NOW() + INTERVAL '15 minutes',NOW()) " +
      "ON CONFLICT (phone) DO UPDATE SET username=EXCLUDED.username, \"passwordHash\"=EXCLUDED.\"passwordHash\", " +
      "\"expiresAt\"=EXCLUDED.\"expiresAt\", \"createdAt\"=NOW()",
      [phone, username, passwordHash]
    );
    res.json({ success: true, message: "Verify your phone by SMS to finish creating your password account." });
  } catch (error) {
    console.error("Customer registration failed:", error.message);
    res.status(500).json({ success: false, message: "Unable to create this account right now." });
  }
});

app.post("/api/customer/login", async (req, res) => {
  const phone = normalizePhoneNumber(req.body.phone);
  const password = req.body.password;
  if (!validCustomerPhone(phone) || typeof password !== "string" || !password) {
    return res.status(400).json({ success: false, message: "Enter your phone number and password." });
  }
  if (!customerAuthSecret()) {
    return res.status(503).json({ success: false, message: "Customer sign-in is not configured on the server." });
  }
  try {
    const result = await pool.query(
      "SELECT id, username, phone, \"passwordHash\", \"verifiedAt\" FROM customers WHERE phone=$1",
      [phone]
    );
    const customer = result.rows[0];
    if (!customer || !customer.passwordHash) {
      return res.status(401).json({ success: false, message: "Phone number or password is incorrect. Accounts created with SMS can continue using SMS sign-in." });
    }
    if (!customer.verifiedAt) {
      return res.status(403).json({ success: false, message: "Verify your phone by SMS before signing in." });
    }
    if (!(await verifyCustomerPassword(password, customer.passwordHash))) {
      return res.status(401).json({ success: false, message: "Phone number or password is incorrect." });
    }
    const safeCustomer = { id: customer.id, username: customer.username, phone: customer.phone };
    res.json({ success: true, customer: safeCustomer, token: makeCustomerToken(customer.id) });
  } catch (error) {
    console.error("Customer password sign-in failed:", error.message);
    res.status(500).json({ success: false, message: "Unable to sign in right now." });
  }
});

app.post("/api/customer/request-code", async (req, res) => {
  const username = String(req.body.username || req.body.name || "").trim();
  const phone = normalizePhoneNumber(req.body.phone);
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  const localOtp = isLocalCustomerOtpEnabled(req);
  if ((!localOtp && (!sid || !token || (!verifyServiceSid && !from))) || !customerAuthSecret()) return res.status(503).json({ success: false, message: localOtp ? "Customer sign-in is not configured yet." : "Phone verification is not configured yet. Add the Twilio Verify Service SID in the server settings." });
  if (username.length < 2 || username.length > 40) {
    return res.status(400).json({ success: false, message: "Enter a name between 2 and 40 characters." });
  }
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    return res.status(400).json({ success: false, message: "Enter a valid phone number with its country code, such as +49… or +263…" });
  }
  try {
    const recent = await pool.query(`SELECT "sentAt" FROM customer_verification_codes WHERE phone=$1`, [phone]);
    if (recent.rows.length && Date.now() - new Date(recent.rows[0].sentAt).getTime() < 60000) {
      return res.status(429).json({ success: false, message: "Please wait one minute before requesting another code." });
    }
    const localCode = localOtp ? String(crypto.randomInt(100000, 1000000)) : null;
    let fallbackCode = null;
    if (localOtp) {
      console.log(`[LOCAL OTP] Verification code for ${phone}: ${localCode}`);
    } else {
      const authorization = Buffer.from(`${sid}:${token}`).toString("base64");
      const sent = verifyServiceSid
        ? await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(verifyServiceSid)}/Verifications`, {
            method: "POST",
            headers: { Authorization: `Basic ${authorization}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ To: phone, Channel: "sms" })
          })
        : await (async () => {
            const code = String(crypto.randomInt(100000, 1000000));
            const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
              method: "POST",
              headers: { Authorization: `Basic ${authorization}`, "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ To: phone, From: from, Body: `Your MEI Velocity verification code is ${code}. It expires in 10 minutes.` })
            });
            return { response, code };
          })();
      const response = sent.response || sent;
      fallbackCode = sent.code || null;
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        console.error("Twilio code request rejected:", detail.code, detail.message);
        return res.status(502).json({ success: false, message: detail.code ? `Twilio could not send the code (error ${detail.code}). Check the trial restrictions and verified recipient number.` : "Twilio could not send the code. Check the Twilio settings and verified recipient number." });
      }
    }
    const codeHash = localOtp
      ? phoneCodeHash(phone, localCode)
      : verifyServiceSid
        ? phoneCodeHash(phone, `verify:${crypto.randomUUID()}`)
        : phoneCodeHash(phone, fallbackCode);
    await pool.query(`
      INSERT INTO customer_verification_codes (phone, username, "codeHash", "expiresAt", "sentAt", attempts)
      VALUES ($1,$2,$3,NOW() + INTERVAL '10 minutes',NOW(),0)
      ON CONFLICT (phone) DO UPDATE SET username=EXCLUDED.username, "codeHash"=EXCLUDED."codeHash",
        "expiresAt"=EXCLUDED."expiresAt", "sentAt"=NOW(), attempts=0
    `, [phone, username, codeHash]);
    res.json({ success: true, message: localOtp ? "Local test code printed in the VS Code backend terminal. It expires in 10 minutes." : "Verification code sent. It expires in 10 minutes." });
  } catch (error) {
    console.error("Customer code request failed:", error.message);
    res.status(500).json({ success: false, message: "Unable to send a verification code right now." });
  }
});

app.post("/api/customer/verify-code", async (req, res) => {
  const phone = normalizePhoneNumber(req.body.phone);
  const code = String(req.body.code || "").trim();
  try {
    const result = await pool.query(`SELECT * FROM customer_verification_codes WHERE phone=$1`, [phone]);
    const challenge = result.rows[0];
    if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now() || challenge.attempts >= 5) {
      return res.status(400).json({ success: false, message: "That code has expired. Request a new one." });
    }
    await pool.query(`UPDATE customer_verification_codes SET attempts=attempts+1 WHERE phone=$1`, [phone]);
    if (!/^\d{4,10}$/.test(code)) {
      return res.status(400).json({ success: false, message: "Enter the verification code from the SMS." });
    }
    if (isLocalCustomerOtpEnabled(req)) {
      const expected = Buffer.from(challenge.codeHash, "hex");
      const actual = Buffer.from(phoneCodeHash(phone, code), "hex");
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return res.status(400).json({ success: false, message: "The verification code is not correct." });
      }
    } else if (process.env.TWILIO_VERIFY_SERVICE_SID) {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const authorization = Buffer.from(`${sid}:${token}`).toString("base64");
      const checked = await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(process.env.TWILIO_VERIFY_SERVICE_SID)}/VerificationCheck`, {
        method: "POST",
        headers: { Authorization: `Basic ${authorization}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: phone, Code: code })
      });
      const verification = await checked.json().catch(() => ({}));
      if (!checked.ok || verification.status !== "approved") {
        if (!checked.ok) console.error("Twilio Verify check rejected:", verification.code, verification.message);
        return res.status(400).json({ success: false, message: verification.status === "pending" ? "That code is not correct. Check the SMS and try again." : "Twilio could not verify that code. Request a new code and try again." });
      }
    } else {
      const expected = Buffer.from(challenge.codeHash, "hex");
      const actual = Buffer.from(phoneCodeHash(phone, code), "hex");
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return res.status(400).json({ success: false, message: "The verification code is not correct." });
      }
    }
    const pendingRegistration = await pool.query(
      "SELECT \"passwordHash\" FROM customer_pending_registrations WHERE phone=$1 AND \"expiresAt\">NOW()",
      [phone]
    );
    const pendingPasswordHash = pendingRegistration.rows[0]?.passwordHash || null;
    const customerId = `CUS-${crypto.randomUUID()}`;
    const customer = await pool.query(`
      INSERT INTO customers (id, username, phone, "passwordHash") VALUES ($1,$2,$3,$4)
      ON CONFLICT (phone) DO UPDATE SET username=EXCLUDED.username, "verifiedAt"=NOW(),
        "passwordHash"=COALESCE(EXCLUDED."passwordHash", customers."passwordHash")
      RETURNING id, username, phone
    `, [customerId, challenge.username, phone, pendingPasswordHash]);
    await pool.query("DELETE FROM customer_pending_registrations WHERE phone=$1", [phone]);
    await pool.query(`DELETE FROM customer_verification_codes WHERE phone=$1`, [phone]);
    res.json({ success: true, customer: customer.rows[0], token: makeCustomerToken(customer.rows[0].id) });
  } catch (error) {
    console.error("Customer verification failed:", error.message);
    res.status(500).json({ success: false, message: "Unable to verify this phone number right now." });
  }
});

app.post("/api/customer/password/request-reset", async (req, res) => {
  const phone = normalizePhoneNumber(req.body.phone);
  if (!validCustomerPhone(phone)) {
    return res.status(400).json({ success: false, message: "Enter a valid phone number with its country code." });
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  const localOtp = isLocalCustomerOtpEnabled(req);
  if ((!localOtp && (!sid || !token || (!verifyServiceSid && !from))) || !customerAuthSecret()) {
    return res.status(503).json({ success: false, message: "Phone verification is not configured yet." });
  }
  try {
    const customerResult = await pool.query(
      "SELECT id FROM customers WHERE phone=$1 AND \"verifiedAt\" IS NOT NULL",
      [phone]
    );
    if (!customerResult.rows.length) {
      return res.json({ success: true, message: "If that number belongs to an account, a reset code will be sent." });
    }
    const recent = await pool.query(
      "SELECT \"sentAt\" FROM customer_password_reset_codes WHERE phone=$1",
      [phone]
    );
    if (recent.rows.length && Date.now() - new Date(recent.rows[0].sentAt).getTime() < 60000) {
      return res.status(429).json({ success: false, message: "Please wait one minute before requesting another code." });
    }

    const localCode = localOtp ? String(crypto.randomInt(100000, 1000000)) : null;
    let fallbackCode = null;
    if (localOtp) {
      console.log("[LOCAL OTP] Password reset code for " + phone + ": " + localCode);
    } else {
      const authorization = Buffer.from(sid + ":" + token).toString("base64");
      let sent;
      if (verifyServiceSid) {
        sent = await fetch("https://verify.twilio.com/v2/Services/" + encodeURIComponent(verifyServiceSid) + "/Verifications", {
          method: "POST",
          headers: { Authorization: "Basic " + authorization, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ To: phone, Channel: "sms" })
        });
      } else {
        fallbackCode = String(crypto.randomInt(100000, 1000000));
        sent = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + encodeURIComponent(sid) + "/Messages.json", {
          method: "POST",
          headers: { Authorization: "Basic " + authorization, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ To: phone, From: from, Body: "Your MEI Velocity password reset code is " + fallbackCode + ". It expires in 10 minutes." })
        });
      }
      if (!sent.ok) {
        const detail = await sent.json().catch(() => ({}));
        console.error("Twilio password reset request rejected:", detail.code, detail.message);
        return res.status(502).json({ success: false, message: "Could not send a reset code. Check the Twilio settings and verified recipient number." });
      }
    }

    const codeHash = localOtp
      ? phoneCodeHash(phone, localCode)
      : verifyServiceSid
        ? phoneCodeHash(phone, "reset:" + crypto.randomUUID())
        : phoneCodeHash(phone, fallbackCode);
    await pool.query(
      "INSERT INTO customer_password_reset_codes (phone, \"codeHash\", \"expiresAt\", \"sentAt\", attempts) " +
      "VALUES ($1,$2,NOW() + INTERVAL '10 minutes',NOW(),0) " +
      "ON CONFLICT (phone) DO UPDATE SET \"codeHash\"=EXCLUDED.\"codeHash\", \"expiresAt\"=EXCLUDED.\"expiresAt\", \"sentAt\"=NOW(), attempts=0",
      [phone, codeHash]
    );
    res.json({ success: true, message: "If that number belongs to an account, a reset code will be sent." });
  } catch (error) {
    console.error("Customer password reset request failed:", error.message);
    res.status(500).json({ success: false, message: "Unable to request a password reset right now." });
  }
});

app.post("/api/customer/password/reset", async (req, res) => {
  const phone = normalizePhoneNumber(req.body.phone);
  const code = String(req.body.code || "").trim();
  const password = req.body.password;
  if (!validCustomerPhone(phone) || !/^\d{4,10}$/.test(code)) {
    return res.status(400).json({ success: false, message: "Enter your phone number and the reset code." });
  }
  if (!validCustomerPassword(password)) {
    return res.status(400).json({ success: false, message: "Use a password with 8 to 128 characters." });
  }
  if (!customerAuthSecret()) {
    return res.status(503).json({ success: false, message: "Customer sign-in is not configured on the server." });
  }
  try {
    const result = await pool.query(
      "SELECT * FROM customer_password_reset_codes WHERE phone=$1",
      [phone]
    );
    const challenge = result.rows[0];
    if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now() || challenge.attempts >= 5) {
      return res.status(400).json({ success: false, message: "That reset code has expired. Request a new one." });
    }
    await pool.query(
      "UPDATE customer_password_reset_codes SET attempts=attempts+1 WHERE phone=$1",
      [phone]
    );
    const localOtp = isLocalCustomerOtpEnabled(req);
    let approved = false;
    if (localOtp || !process.env.TWILIO_VERIFY_SERVICE_SID) {
      const expected = Buffer.from(challenge.codeHash, "hex");
      const actual = Buffer.from(phoneCodeHash(phone, code), "hex");
      approved = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } else {
      const authorization = Buffer.from(process.env.TWILIO_ACCOUNT_SID + ":" + process.env.TWILIO_AUTH_TOKEN).toString("base64");
      const checked = await fetch("https://verify.twilio.com/v2/Services/" + encodeURIComponent(process.env.TWILIO_VERIFY_SERVICE_SID) + "/VerificationCheck", {
        method: "POST",
        headers: { Authorization: "Basic " + authorization, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: phone, Code: code })
      });
      const verification = await checked.json().catch(() => ({}));
      approved = checked.ok && verification.status === "approved";
      if (!checked.ok) console.error("Twilio password reset check rejected:", verification.code, verification.message);
    }
    if (!approved) {
      return res.status(400).json({ success: false, message: "That reset code is not correct. Request a new one if it has expired." });
    }
    const passwordHash = await hashCustomerPassword(password);
    const updated = await pool.query(
      "UPDATE customers SET \"passwordHash\"=$1 WHERE phone=$2 AND \"verifiedAt\" IS NOT NULL RETURNING id",
      [passwordHash, phone]
    );
    await pool.query("DELETE FROM customer_password_reset_codes WHERE phone=$1", [phone]);
    if (!updated.rows.length) {
      return res.status(400).json({ success: false, message: "That reset code is no longer valid." });
    }
    res.json({ success: true, message: "Password updated. You can sign in now." });
  } catch (error) {
    console.error("Customer password reset failed:", error.message);
    res.status(500).json({ success: false, message: "Unable to reset the password right now." });
  }
});

app.get("/api/customer/bookings", customerAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, pickup, dropoff, date, time, vehicle, distance, fare, "baseFare", discount, "promoCode", status, rating, "ratedAt", "createdAt"
      FROM bookings WHERE "customerId"=$1 ORDER BY "createdAt" DESC LIMIT 50
    `, [req.customerId]);
    res.json({ success: true, bookings: result.rows });
  } catch (error) {
    console.error("Customer history failed:", error.message);
    res.status(500).json({ success: false, message: "Unable to retrieve ride history." });
  }
});

app.patch("/api/customer/bookings/:id/rating", customerAuth, async (req, res) => {
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ success: false, message: "Choose a rating from 1 to 5." });
  }
  try {
    const result = await pool.query(`
      UPDATE bookings SET rating=$1, "ratedAt"=NOW()
      WHERE id=$2 AND "customerId"=$3 AND status='Completed'
      RETURNING id, rating, "ratedAt"
    `, [rating, req.params.id, req.customerId]);
    if (!result.rows.length) return res.status(409).json({ success: false, message: "Only completed rides in your account can be rated." });
    res.json({ success: true, rating: result.rows[0].rating, ratedAt: result.rows[0].ratedAt });
  } catch (error) {
    console.error("Ride rating save failed:", error.message);
    res.status(500).json({ success: false, message: "Unable to save your rating." });
  }
});

app.get("/api/customer/bookings/:id/status", customerAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, d.name AS "driverName", d.vehicle AS "driverVehicle", d.plate AS "driverPlate"
      FROM bookings b LEFT JOIN drivers d ON d.id=b."assignedDriverId"
      WHERE b.id=$1 AND b."customerId"=$2 LIMIT 1
    `, [req.params.id, req.customerId]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: "Ride not found in this account." });
    res.json({ success: true, booking: result.rows[0] });
  } catch (error) {
    console.error("Account ride status failed:", error.message);
    res.status(500).json({ success: false, message: "Unable to retrieve ride status." });
  }
});

app.get("/api/promotions", (req, res) => {
  res.json({ success: true, offers: [{ code: "WELCOME10", title: "Welcome ride credit", description: "Save up to $10 on one ride. One use per phone number." }] });
});

app.post("/api/promotions/validate", (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  if (code !== "WELCOME10") return res.status(404).json({ success: false, message: "Offer code not found." });
  res.json({ success: true, offer: { code, discount: 10, title: "Welcome ride credit", terms: "Up to $10 off one ride per phone number." } });
});

// CUSTOMER BOOKING
app.post("/api/bookings", customerAuth, async (req, res) => {
  try {
    const { pickup, dropoff, date, time, vehicle, distance, fare, payment } = req.body;
    const customerResult = await pool.query(`SELECT username, phone FROM customers WHERE id=$1`, [req.customerId]);
    const customer = customerResult.rows[0];
    if (!customer) return res.status(401).json({ success: false, message: "Please sign in again before booking." });
    const name = customer.username;
    const phone = customer.phone;
    const promoCode = String(req.body.promoCode || "").trim().toUpperCase();
    if (!name || !pickup || !dropoff || !date || !time || !/^\+[1-9]\d{7,14}$/.test(phone)) {
      return res.status(400).json({ success: false, message: "Please provide all booking details and a valid international phone number." });
    }
    if (promoCode && promoCode !== "WELCOME10") return res.status(400).json({ success: false, message: "Offer code not found." });
    const baseFare = Math.max(0, (Number(distance) || 0) * 0.75);
    const discount = promoCode ? Math.min(baseFare, 10) : 0;
    const referenceFare = Math.max(0, baseFare - discount);
    const offeredFare = Number(fare);
    if (!Number.isFinite(offeredFare) || offeredFare < 0 || offeredFare > baseFare * 2) {
      return res.status(400).json({ success: false, message: "Enter a valid fare offer up to twice the estimated fare." });
    }
    const booking = {
      id: `MEI-${crypto.randomUUID()}`,
      name, phone, pickup, dropoff, date, time,
      vehicle: vehicle || "Standard Ride",
      distance: Number(distance) || 0,
      baseFare,
      discount,
      promoCode: promoCode || null,
      fare: Math.min(offeredFare, referenceFare),
      payment: payment || "Cash",
      status: "Pending"
    };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (promoCode) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [String(phone).trim()]);
        const alreadyUsed = await client.query(`SELECT 1 FROM bookings WHERE phone=$1 AND "promoCode"='WELCOME10' LIMIT 1`, [phone]);
        if (alreadyUsed.rows.length) {
          await client.query("ROLLBACK");
          return res.status(409).json({ success: false, message: "This welcome credit has already been used with that phone number." });
        }
      }
      await client.query(`
        INSERT INTO bookings
        (id, "customerId", name, phone, pickup, dropoff, date, time, vehicle, distance, fare, "baseFare", discount, "promoCode", payment, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      `, [booking.id, req.customerId || null, booking.name, booking.phone, booking.pickup, booking.dropoff,
        booking.date, booking.time, booking.vehicle, booking.distance, booking.fare, booking.baseFare,
        booking.discount, booking.promoCode, booking.payment, booking.status]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

res.status(201).json({
  success: true,
  message: "Ride booked successfully.",
  booking,
  dispatching: true
});

setImmediate(() => {
  dispatchBooking(booking.id)
    .then(offeredTo => console.info(`Ride ${booking.id} offered to ${offeredTo} driver(s).`))
    .catch(dispatchError => console.error("Ride saved, but initial driver dispatch failed:", dispatchError));
});

} catch (error) {
  console.error("Booking error:", error);
  res.status(500).json({
    success: false,
    message: "Unable to create booking."
  });
}
});

// CUSTOMER: RIDE STATUS
// Requires both booking ID and the phone number used for the booking.
app.get("/api/bookings/:id/status", async (req, res) => {
  try {
    const bookingId = String(req.params.id || "").trim();
    const phone = String(req.query.phone || "").trim();

    if (!bookingId || !phone) {
      return res.status(400).json({
        success: false,
        message: "Booking number and phone number are required."
      });
    }

    const result = await pool.query(`
      SELECT
        b.*,
        d.name AS "driverName",
        d.vehicle AS "driverVehicle",
        d.plate AS "driverPlate"
      FROM bookings b
      LEFT JOIN drivers d ON d.id = b."assignedDriverId"
      WHERE b.id = $1 AND b.phone = $2
      LIMIT 1
    `, [bookingId, phone]);

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Booking not found."
      });
    }

    res.json({ success: true, booking: result.rows[0] });
  } catch (error) {
    console.error("Customer ride status error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to retrieve ride status."
    });
  }
});

// CUSTOMER: CANCEL AN UNASSIGNED RIDE REQUEST
app.post("/api/bookings/:id/cancel", async (req, res) => {
  const bookingId = String(req.params.id || "").trim();
  const phone = normalizePhoneNumber(req.body.phone);
  if (!bookingId || !/^\+[1-9]\d{7,14}$/.test(phone)) {
    return res.status(400).json({ success: false, message: "Enter the phone number used for this booking." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT * FROM bookings
      WHERE id=$1 AND phone=$2
      FOR UPDATE
    `, [bookingId, phone]);

    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Ride not found. Check the booking and phone number." });
    }

    const booking = result.rows[0];
    if (booking.status !== "Pending" || booking.assignedDriverId) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "This ride can no longer be cancelled here. Please contact MEI Velocity for help." });
    }

    const cancelled = await client.query(`
      UPDATE bookings SET status='Cancelled'
      WHERE id=$1
      RETURNING *
    `, [bookingId]);
    await client.query(`
      UPDATE driver_offers SET status='Expired', "respondedAt"=NOW()
      WHERE "bookingId"=$1 AND status='Pending'
    `, [bookingId]);
    await client.query("COMMIT");
    res.json({ success: true, message: "Ride request cancelled.", booking: cancelled.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Customer ride cancellation error:", error);
    res.status(500).json({ success: false, message: "Unable to cancel this ride right now." });
  } finally {
    client.release();
  }
});

// ADMIN: BOOKINGS
app.get("/api/bookings", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT b.*, d.name AS "driverName", d.vehicle AS "driverVehicle", d.plate AS "driverPlate" FROM bookings b LEFT JOIN drivers d ON d.id = b."assignedDriverId" ORDER BY b."createdAt" DESC`);
    res.json({ success: true, bookings: result.rows });
  } catch (error) {
    console.error("Get bookings error:", error);
    res.status(500).json({ success: false, message: "Unable to retrieve bookings." });
  }
});

app.patch("/api/bookings/:id/status", adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const allowedStatuses = ["Pending", "Confirmed", "Completed", "Cancelled"];
    const { status } = req.body;
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid booking status." });
    }
    await client.query("BEGIN");
    const current = await client.query(`SELECT id, "assignedDriverId" FROM bookings WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!current.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Booking not found." });
    }
    const finalState = ["Completed", "Cancelled"].includes(status);
    const result = await client.query(`
      UPDATE bookings
      SET status=$1,
          "driverStatus"=CASE WHEN $1='Completed' THEN 'Completed' WHEN $1='Cancelled' AND "assignedDriverId" IS NOT NULL THEN 'Cancelled' ELSE "driverStatus" END
      WHERE id=$2
      RETURNING *
    `, [status, req.params.id]);
    if (finalState) {
      await client.query(`UPDATE driver_offers SET status='Expired', "respondedAt"=NOW() WHERE "bookingId"=$1 AND status='Pending'`, [req.params.id]);
      if (current.rows[0].assignedDriverId) {
        await client.query(`UPDATE drivers SET status='Online' WHERE id=$1 AND status='Busy'`, [current.rows[0].assignedDriverId]);
      }
    }
    await client.query("COMMIT");
    if (finalState) {
      try { await dispatchPendingBookings(); }
      catch (dispatchError) { console.error("Pending ride dispatch after admin update error:", dispatchError); }
    }
    res.json({ success: true, booking: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Status update error:", error);
    res.status(500).json({ success: false, message: "Unable to update booking." });
  } finally {
    client.release();
  }
});

// ADMIN: DRIVER MANAGEMENT
app.get("/api/admin/drivers", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM drivers ORDER BY "createdAt" DESC`);
    res.json({ success: true, drivers: result.rows.map(publicDriver) });
  } catch (error) {
    console.error("Get drivers error:", error);
    res.status(500).json({ success: false, message: "Unable to retrieve drivers." });
  }
});

app.post("/api/admin/drivers", adminAuth, async (req, res) => {
  try {
    const { name, phone, vehicle, plate, password } = req.body;
    if (!name || !phone || !vehicle || !plate || !password || String(password).length < 6) {
      return res.status(400).json({ success: false, message: "Name, phone, vehicle, plate and a password of at least 6 characters are required." });
    }
    const passwordHash = await hashPassword(String(password));
    const id = `DRV-${crypto.randomUUID()}`;
    const result = await pool.query(`
      INSERT INTO drivers (id,name,phone,vehicle,plate,"passwordHash")
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [id, name.trim(), phone.trim(), vehicle.trim(), plate.trim().toUpperCase(), passwordHash]);
    res.status(201).json({ success: true, driver: publicDriver(result.rows[0]) });
  } catch (error) {
    console.error("Create driver error:", error);
    if (error.code === "23505") return res.status(409).json({ success: false, message: "A driver with that phone number already exists." });
    res.status(500).json({ success: false, message: "Unable to create driver." });
  }
});

app.patch("/api/admin/drivers/:id", adminAuth, async (req, res) => {
  try {
    const { name, phone, vehicle, plate, password, active } = req.body;
    const current = await pool.query(`SELECT * FROM drivers WHERE id=$1`, [req.params.id]);
    if (!current.rows.length) return res.status(404).json({ success: false, message: "Driver not found." });
    const d = current.rows[0];
    const passwordHash = password ? await hashPassword(String(password)) : d.passwordHash;
    const result = await pool.query(`
      UPDATE drivers SET name=$1, phone=$2, vehicle=$3, plate=$4, "passwordHash"=$5, active=$6,
      status=CASE WHEN $6=false THEN 'Offline' ELSE status END
      WHERE id=$7 RETURNING *
    `, [name ?? d.name, phone ?? d.phone, vehicle ?? d.vehicle, String(plate ?? d.plate).toUpperCase(), passwordHash,
        active === undefined ? d.active : Boolean(active), req.params.id]);
    res.json({ success: true, driver: publicDriver(result.rows[0]) });
  } catch (error) {
    console.error("Update driver error:", error);
    if (error.code === "23505") return res.status(409).json({ success: false, message: "A driver with that phone number already exists." });
    res.status(500).json({ success: false, message: "Unable to update driver." });
  }
});

app.delete("/api/admin/drivers/:id", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`UPDATE drivers SET active=false,status='Offline' WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: "Driver not found." });
    res.json({ success: true, driver: publicDriver(result.rows[0]) });
  } catch (error) {
    console.error("Deactivate driver error:", error);
    res.status(500).json({ success: false, message: "Unable to deactivate driver." });
  }
});

// DRIVER LOGIN / STATUS
app.post("/api/driver/login", async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ success: false, message: "Phone and password are required." });
    const result = await pool.query(`SELECT * FROM drivers WHERE phone=$1 AND active=true`, [String(phone).trim()]);
    if (!result.rows.length || !(await verifyPassword(String(password), result.rows[0].passwordHash))) {
      return res.status(401).json({ success: false, message: "Invalid driver login." });
    }
    const driver = result.rows[0];
    const token = makeDriverToken(driver.id);
    res.json({ success: true, token, driver: publicDriver(driver) });
  } catch (error) {
    console.error("Driver login error:", error);
    res.status(500).json({ success: false, message: "Unable to log in." });
  }
});

app.get("/api/driver/me", driverAuth, async (req, res) => {
  const result = await pool.query(`SELECT * FROM drivers WHERE id=$1 AND active=true`, [req.driverId]);
  if (!result.rows.length) return res.status(401).json({ success: false, message: "Driver account is inactive." });
  res.json({ success: true, driver: publicDriver(result.rows[0]) });
});

app.patch("/api/driver/status", driverAuth, async (req, res) => {
  try {
    const allowed = ["Online", "Offline", "Busy"];
    const { status, lat, lng } = req.body;
    if (!allowed.includes(status)) return res.status(400).json({ success: false, message: "Invalid driver status." });
    const result = await pool.query(`
      UPDATE drivers SET status=$1, lat=COALESCE($2,lat), lng=COALESCE($3,lng)
      WHERE id=$4 AND active=true RETURNING *
    `, [status, lat === undefined ? null : Number(lat), lng === undefined ? null : Number(lng), req.driverId]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: "Driver not found." });
    let pendingOffersCreated = 0;
    if (status === "Online") {
      try {
        pendingOffersCreated = await dispatchPendingBookings();
      } catch (dispatchError) {
        console.error("Pending ride dispatch error:", dispatchError);
      }
    }
    res.json({ success: true, driver: publicDriver(result.rows[0]), pendingOffersCreated });
  } catch (error) {
    console.error("Driver status error:", error);
    res.status(500).json({ success: false, message: "Unable to update driver status." });
  }
});

// CUSTOMER PUSH NOTIFICATIONS
// The public VAPID key is safe to expose to browsers; the private key must
// remain in the backend environment and must never be returned to clients.
app.get("/api/customer/push-public-key", (req, res) => {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || "").trim();
  if (!publicKey) {
    return res.status(503).json({
      success: false,
      message: "Push notifications are not configured on the server."
    });
  }
  res.json({ success: true, publicKey });
});

// Keep missing API endpoints machine-readable instead of returning Express's HTML 404 page.
app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found. Check that the website and backend are on matching versions."
  });
});

initializeDatabase()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log(`MEI Velocity backend running on port ${PORT}`)))
  .catch((error) => { console.error("Database initialization failed:", error); process.exit(1); });




