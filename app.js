const RATE = 0.85;
const API_BASE = "https://mei-velocity1.onrender.com";
let suggestionTimer;
let customerRidePollTimer;
let currentCustomerBooking = null;

async function getLocationSuggestions(input, datalistId) {
  const query = input.value.trim();
  const datalist = document.getElementById(datalistId);
  if (query.length < 3) { datalist.innerHTML = ""; return; }
  clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(async () => {
    try {
      const url = "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=zw&q=" + encodeURIComponent(query);
      const response = await fetch(url);
      const locations = await response.json();
      datalist.innerHTML = "";
      locations.forEach(location => {
        const option = document.createElement("option");
        option.value = location.display_name;
        datalist.appendChild(option);
      });
    } catch (error) { console.error("Location suggestions error:", error); }
  }, 400);
}

document.getElementById("pickup").addEventListener("input", function () {
  getLocationSuggestions(this, "pickupSuggestions");
});
document.getElementById("dropoff").addEventListener("input", function () {
  getLocationSuggestions(this, "dropoffSuggestions");
});

async function geocode(place) {
  const q = place.toLowerCase().includes("harare") ? place : `${place}, Harare, Zimbabwe`;
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q);
  const response = await fetch(url);
  const data = await response.json();
  if (!data.length) throw new Error("Location not found: " + place);
  return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
}

async function calculateFare() {
  const pickup = document.getElementById("pickup").value.trim();
  const dropoff = document.getElementById("dropoff").value.trim();
  if (!pickup || !dropoff) {
    document.getElementById("status").textContent = "Enter both pickup and drop-off locations.";
    return;
  }
  document.getElementById("status").textContent = "Calculating route...";
  try {
    const p = await geocode(pickup);
    const q = await geocode(dropoff);
    const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${p.lon},${p.lat};${q.lon},${q.lat}?overview=false`);
    const data = await response.json();
    if (data.code !== "Ok") throw new Error("Route unavailable.");
    const km = data.routes[0].distance / 1000;
    const fare = km * RATE;
    document.getElementById("distance").textContent = km.toFixed(1) + " km";
    document.getElementById("total").textContent = "$" + fare.toFixed(2);
    document.getElementById("status").textContent = "Fare calculated at $0.75 per kilometre.";
    window.rideFare = { km, fare };
  } catch (error) {
    document.getElementById("status").textContent = error.message;
  }
}

document.getElementById("fareBtn").onclick = calculateFare;

/* CUSTOMER RIDE TRACKING */
function customerRideStep(booking) {
  if (!booking) return 0;
  if (booking.status === "Cancelled") return -1;
  if (booking.status === "Completed" || booking.driverStatus === "Completed") return 5;
  switch (booking.driverStatus) {
    case "Picked Up": return 4;
    case "Arrived": return 3;
    case "On the Way": return 2;
    case "Accepted": return 1;
    default: return booking.assignedDriverId ? 1 : 0;
  }
}

function customerRideTitle(booking) {
  if (!booking) return "Booking Received";
  if (booking.status === "Cancelled") return "Ride Cancelled";
  if (booking.status === "Completed" || booking.driverStatus === "Completed") return "Ride Completed";
  switch (booking.driverStatus) {
    case "Picked Up": return "Ride Started";
    case "Arrived": return "Driver Arrived";
    case "On the Way": return "Driver On the Way";
    case "Accepted": return "Driver Assigned";
    default: return "Booking Received";
  }
}

function customerRideMessage(booking) {
  if (!booking) return "We are looking for an available driver.";
  if (booking.status === "Cancelled") return "This ride has been cancelled. Please contact MEI Velocity if you need help.";
  if (booking.status === "Completed" || booking.driverStatus === "Completed") return "Thank you for riding with MEI Velocity.";
  switch (booking.driverStatus) {
    case "Picked Up": return "Your ride is now in progress.";
    case "Arrived": return "Your driver has arrived at the pickup location.";
    case "On the Way": return "Your driver is on the way to you.";
    case "Accepted": return "A driver has accepted your ride.";
    default: return "We are looking for an available driver.";
  }
}

let driverMap = null;
let driverMarker = null;

function updateDriverMap(booking) {
  const mapWrap = document.getElementById("driverMapWrap");
  const mapElement = document.getElementById("driverMap");
  const mapStatus = document.getElementById("driverMapStatus");

  if (!mapWrap || !mapElement || !mapStatus) return;

  const activeStatuses = ["Confirmed"];
  const driverStatuses = ["Accepted", "On the Way", "Arrived", "Picked Up"];

  if (
    !booking?.assignedDriverId ||
    !activeStatuses.includes(booking.status) ||
    !driverStatuses.includes(booking.driverStatus)
  ) {
    mapWrap.style.display = "none";
    return;
  }

  mapWrap.style.display = "block";

  if (!driverMap) {
    driverMap = L.map(mapElement, {
      zoomControl: true
    }).setView([-17.8252, 31.0335], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(driverMap);
  }

  const lat = Number(booking.driverLat);
  const lng = Number(booking.driverLng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    mapStatus.textContent = "Waiting for driver's live location...";
    return;
  }

  const position = [lat, lng];

  if (!driverMarker) {
    driverMarker = L.marker(position).addTo(driverMap);
    driverMarker.bindPopup("MEI VELOCITY driver");
  } else {
    driverMarker.setLatLng(position);
  }

  driverMap.setView(position, Math.max(driverMap.getZoom(), 15));

  if (booking.driverLocationUpdatedAt) {
    const updated = new Date(booking.driverLocationUpdatedAt);
    const secondsAgo = Math.max(0, Math.round((Date.now() - updated.getTime()) / 1000));

    mapStatus.textContent =
      secondsAgo < 60
        ? `Driver location updated ${secondsAgo}s ago`
        : "Driver location hasn't updated recently.";
  } else {
    mapStatus.textContent = "Driver location is updating...";
  }

  setTimeout(() => {
    if (driverMap) driverMap.invalidateSize();
  }, 100);
}
function renderCustomerRide(booking) {
  const tracker = document.getElementById("rideTracker");
  if (!tracker) return;
  tracker.style.display = "block";
  document.getElementById("rideBookingId").textContent = booking?.id || "";
  document.getElementById("rideTrackerTitle").textContent = customerRideTitle(booking);
  document.getElementById("rideTrackerMessage").textContent = customerRideMessage(booking);

  const stepIndex = customerRideStep(booking);
  document.querySelectorAll(".ride-step").forEach((step, index) => {
    step.classList.toggle("active", stepIndex >= 0 && index <= stepIndex);
    step.classList.toggle("current", stepIndex >= 0 && index === stepIndex);
  });

  const driverCard = document.getElementById("driverCard");
  if (booking?.assignedDriverId) {
    driverCard.style.display = "grid";
    document.getElementById("driverName").textContent = booking.driverName || booking.assignedDriverName || "Assigned driver";
    document.getElementById("driverVehicle").textContent = booking.driverVehicle || booking.vehicle || "Vehicle assigned";
    document.getElementById("driverPlate").textContent = booking.driverPlate || "â€”";
  } else {
    driverCard.style.display = "none";
  }

  document.getElementById("rideTrackerUpdated").textContent =
    "Last checked: " + new Date().toLocaleTimeString();
}

async function fetchCustomerRideStatus() {
  if (!currentCustomerBooking) return;
  const { id, phone } = currentCustomerBooking;
  try {
    const response = await fetch(
      `${API_BASE}/api/bookings/${encodeURIComponent(id)}/status?phone=${encodeURIComponent(phone)}`
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Unable to check ride status.");
    renderCustomerRide(data.booking);
    updateDriverMap(data.booking);
    if (data.booking && ["Completed", "Cancelled"].includes(data.booking.status)) {
      stopCustomerRidePolling();
    }
  } catch (error) {
    console.error("Customer ride status error:", error);
  }
}

function startCustomerRidePolling() {
  stopCustomerRidePolling();
  fetchCustomerRideStatus();
  customerRidePollTimer = setInterval(fetchCustomerRideStatus, 4000);
}

function stopCustomerRidePolling() {
  if (customerRidePollTimer) {
    clearInterval(customerRidePollTimer);
    customerRidePollTimer = null;
  }
}

function saveCustomerBooking(booking) {
  currentCustomerBooking = {
    id: booking.id,
    phone: document.getElementById("phone").value.trim()
  };
  try {
    localStorage.setItem("meiVelocityCustomerBooking", JSON.stringify(currentCustomerBooking));
  } catch (error) {
    console.warn("Could not save customer booking locally.", error);
  }
}

function restoreCustomerBooking() {
  try {
    const saved = JSON.parse(localStorage.getItem("meiVelocityCustomerBooking") || "null");
    if (saved?.id && saved?.phone) {
      currentCustomerBooking = saved;
      document.getElementById("rideTracker").style.display = "block";
      document.getElementById("rideBookingId").textContent = saved.id;
      startCustomerRidePolling();
    }
  } catch (error) {
    console.warn("Could not restore customer booking.", error);
  }
}

document.getElementById("bookBtn").onclick = async () => {
  if (!window.rideFare) {
    await calculateFare();
    if (!window.rideFare) return;
  }

  const name = document.getElementById("name").value.trim();
  const phone = document.getElementById("phone").value.trim();
  const pickup = document.getElementById("pickup").value.trim();
  const dropoff = document.getElementById("dropoff").value.trim();
  const date = document.getElementById("date").value;
  const time = document.getElementById("time").value;
  const vehicle = document.getElementById("vehicle").value;
  const paymentElement = document.querySelector('input[name="payment"]:checked');
  const payment = paymentElement ? paymentElement.value : "Cash";

  if (!name || !phone || !pickup || !dropoff || !date || !time) {
    document.getElementById("status").textContent = "Please complete all booking details.";
    return;
  }

  document.getElementById("status").textContent = "Sending booking...";

  try {
    const response = await fetch(`${API_BASE}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name, phone, pickup, dropoff, date, time, vehicle,
        distance: window.rideFare.km,
        fare: window.rideFare.fare,
        payment
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Booking failed.");

    document.getElementById("success").style.display = "block";
    document.getElementById("success").textContent =
      `Booking confirmed! Your booking number is ${data.booking.id}.`;
    document.getElementById("status").textContent =
      "MEI Velocity has received your ride request.";

    saveCustomerBooking(data.booking);
    renderCustomerRide(data.booking);
    updateDriverMap(data.booking);
    startCustomerRidePolling();
  } catch (error) {
    document.getElementById("status").textContent = "Booking failed: " + error.message;
  }
};

restoreCustomerBooking();



