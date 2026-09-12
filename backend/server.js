const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

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

// CUSTOMER BOOKING
app.post("/api/bookings", async (req, res) => {
  try {
    const { name, phone, pickup, dropoff, date, time, vehicle, distance, fare, payment } = req.body;
    if (!name || !phone || !pickup || !dropoff || !date || !time) {
      return res.status(400).json({ success: false, message: "Please provide all required booking details." });
    }
    const booking = {
      id: `MEI-${Date.now()}`,
      name, phone, pickup, dropoff, date, time,
      vehicle: vehicle || "Standard Ride",
      distance: Number(distance) || 0,
      fare: Number(fare) || 0,
      payment: payment || "Cash",
      status: "Pending"
    };
    await pool.query(`
      INSERT INTO bookings
      (id, name, phone, pickup, dropoff, date, time, vehicle, distance, fare, payment, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [booking.id, booking.name, booking.phone, booking.pickup, booking.dropoff, booking.date, booking.time,
        booking.vehicle, booking.distance, booking.fare, booking.payment, booking.status]);
    res.status(201).json({ success: true, message: "Ride booked successfully.", booking });
  } catch (error) {
    console.error("Booking error:", error);
    res.status(500).json({ success: false, message: "Unable to create booking." });
  }
});

// ADMIN: BOOKINGS
app.get("/api/bookings", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM bookings ORDER BY "createdAt" DESC`);
    res.json({ success: true, bookings: result.rows });
  } catch (error) {
    console.error("Get bookings error:", error);
    res.status(500).json({ success: false, message: "Unable to retrieve bookings." });
  }
});

app.patch("/api/bookings/:id/status", adminAuth, async (req, res) => {
  try {
    const allowedStatuses = ["Pending", "Confirmed", "Completed", "Cancelled"];
    const { status } = req.body;
    if (!allowedStatuses.includes(status)) return res.status(400).json({ success: false, message: "Invalid booking status." });
    const result = await pool.query(`UPDATE bookings SET status=$1 WHERE id=$2 RETURNING *`, [status, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: "Booking not found." });
    res.json({ success: true, booking: result.rows[0] });
  } catch (error) {
    console.error("Status update error:", error);
    res.status(500).json({ success: false, message: "Unable to update booking." });
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
    res.json({ success: true, driver: publicDriver(result.rows[0]) });
  } catch (error) {
    console.error("Driver status error:", error);
    res.status(500).json({ success: false, message: "Unable to update driver status." });
  }
});

initializeDatabase()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log(`MEI Velocity backend running on port ${PORT}`)))
  .catch((error) => { console.error("Database initialization failed:", error); process.exit(1); });
