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
  `);  await pool.query(`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS "assignedDriverId" TEXT
  );  await pool.query(
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS "driverLat" NUMERIC,
    ADD COLUMN IF NOT EXISTS "driverLng" NUMERIC,
    ADD COLUMN IF NOT EXISTS "driverLocationUpdatedAt" TIMESTAMP WITH TIME ZONE
  );  await pool.query(

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
}// DRIVER OFFER ROUTES

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

    res.json({
      success: true,
      message: completed ? "Ride completed successfully." : "Ride status updated.",
      ride: updated.rows[0]
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
    };await pool.query(`
  INSERT INTO bookings
  (id, name, phone, pickup, dropoff, date, time, vehicle, distance, fare, payment, status)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
`, [
  booking.id,
  booking.name,
  booking.phone,
  booking.pickup,
  booking.dropoff,
  booking.date,
  booking.time,
  booking.vehicle,
  booking.distance,
  booking.fare,
  booking.payment,
  booking.status
]);

const offeredTo = await dispatchBooking(booking.id);

res.status(201).json({
  success: true,
  message: "Ride booked successfully.",
  booking,
  offeredTo
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



