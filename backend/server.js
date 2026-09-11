const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const bookingsFile = path.join(__dirname, "bookings.json");

// Create bookings file if it doesn't exist
if (!fs.existsSync(bookingsFile)) {
  fs.writeFileSync(bookingsFile, "[]");
}

function getBookings() {
  return JSON.parse(fs.readFileSync(bookingsFile, "utf8"));
}

function saveBookings(bookings) {
  fs.writeFileSync(
    bookingsFile,
    JSON.stringify(bookings, null, 2)
  );
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
app.post("/api/bookings", (req, res) => {
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

    const bookings = getBookings();

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
      status: "Pending",
      createdAt: new Date().toISOString()
    };

    bookings.push(booking);
    saveBookings(bookings);

    res.status(201).json({
      success: true,
      message: "Ride booked successfully.",
      booking
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to create booking."
    });
  }
});

// Get all bookings
app.get("/api/bookings", (req, res) => {
  const bookings = getBookings();

  res.json({
    success: true,
    bookings
  });
});

app.listen(PORT, () => {
  console.log(`MEI Velocity backend running on http://localhost:${PORT}`);
});