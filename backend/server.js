const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
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

// Create database table
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

// Test
app.get("/", (req, res) => {
  res.json({
    message: "MEI Velocity backend is running"
  });
});

// Test API
app.get("/api/test", (req, res) => {
  res.json({
    success: true,
    message: "MEI Velocity API is working"
  });
});

// Create booking
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

// Get all bookings
app.get("/api/bookings", async (req, res) => {
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