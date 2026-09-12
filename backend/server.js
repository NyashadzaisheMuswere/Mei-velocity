const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

function adminAuth(req, res, next) {
  const password = req.headers["x-admin-password"];

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({
      success: false,
      message: "ADMIN_PASSWORD is not configured."
    });
  }

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized."
    });
  }

  next();
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

  console.log("MEI Velocity database ready.");
}

app.get("/", (req, res) => {
  res.json({
    message: "MEI Velocity backend is running"
  });
});

app.get("/api/test", (req, res) => {
  res.json({
    success: true,
    message: "MEI Velocity API is working"
  });
});

// CUSTOMER BOOKING
app.post("/api/bookings", async (req, res) => {
  try {
    const {
      name,
      phone,
      pickup,
      dropoff,
      date,
      time,
      vehicle,
      distance,
      fare,
      payment
    } = req.body;

    if (!name || !phone || !pickup || !dropoff || !date || !time) {
      return res.status(400).json({
        success: false,
        message: "Please provide all required booking details."
      });
    }

    const booking = {
      id: `MEI-${Date.now()}`,
      name,
      phone,
      pickup,
      dropoff,
      date,
      time,
      vehicle: vehicle || "Standard Ride",
      distance: Number(distance) || 0,
      fare: Number(fare) || 0,
      payment: payment || "Cash",
      status: "Pending"
    };

    await pool.query(
      `
      INSERT INTO bookings
      (id, name, phone, pickup, dropoff, date, time, vehicle, distance, fare, payment, status)
      VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      [
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
      ]
    );

    res.status(201).json({
      success: true,
      message: "Ride booked successfully.",
      booking
    });

  } catch (error) {
    console.error("Booking error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to create booking."
    });
  }
});

// ADMIN: GET BOOKINGS
app.get("/api/bookings", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM bookings ORDER BY "createdAt" DESC`
    );

    res.json({
      success: true,
      bookings: result.rows
    });

  } catch (error) {
    console.error("Get bookings error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to retrieve bookings."
    });
  }
});

// ADMIN: UPDATE BOOKING STATUS
app.patch("/api/bookings/:id/status", adminAuth, async (req, res) => {
  try {
    const { status } = req.body;

    const allowedStatuses = [
      "Pending",
      "Confirmed",
      "Completed",
      "Cancelled"
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking status."
      });
    }

    const result = await pool.query(
      `
      UPDATE bookings
      SET status = $1
      WHERE id = $2
      RETURNING *
      `,
      [status, req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Booking not found."
      });
    }

    res.json({
      success: true,
      booking: result.rows[0]
    });

  } catch (error) {
    console.error("Status update error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to update booking."
    });
  }
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`MEI Velocity backend running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });