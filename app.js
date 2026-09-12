const RATE = 0.85;
let suggestionTimer;

async function getLocationSuggestions(input, datalistId) {
  const query = input.value.trim();
  const datalist = document.getElementById(datalistId);

  if (query.length < 3) {
    datalist.innerHTML = "";
    return;
  }

  clearTimeout(suggestionTimer);

  suggestionTimer = setTimeout(async () => {
    try {
      const url =
        "https://nominatim.openstreetmap.org/search" +
        "?format=json" +
        "&addressdetails=1" +
        "&limit=5" +
        "&countrycodes=zw" +
        "&q=" +
        encodeURIComponent(query);

      const response = await fetch(url);
      const locations = await response.json();

      datalist.innerHTML = "";

      locations.forEach(location => {
        const option = document.createElement("option");
        option.value = location.display_name;
        datalist.appendChild(option);
      });

    } catch (error) {
      console.error("Location suggestions error:", error);
    }
  }, 400);
}

document.getElementById("pickup").addEventListener("input", function () {
  getLocationSuggestions(this, "pickupSuggestions");
});

document.getElementById("dropoff").addEventListener("input", function () {
  getLocationSuggestions(this, "dropoffSuggestions");
});
async function geocode(place) {
  const q = place.toLowerCase().includes("harare")
    ? place
    : `${place}, Harare, Zimbabwe`;

  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(q);

  const response = await fetch(url);
  const data = await response.json();

  if (!data.length) {
    throw new Error("Location not found: " + place);
  }

  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon)
  };
}

async function calculateFare() {

  const pickup = document.getElementById("pickup").value.trim();
  const dropoff = document.getElementById("dropoff").value.trim();

  if (!pickup || !dropoff) {
    document.getElementById("status").textContent =
      "Enter both pickup and drop-off locations.";
    return;
  }

  document.getElementById("status").textContent =
    "Calculating route...";

  try {

    const p = await geocode(pickup);
    const q = await geocode(dropoff);

    const response = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${p.lon},${p.lat};${q.lon},${q.lat}?overview=false`
    );

    const data = await response.json();

    if (data.code !== "Ok") {
      throw new Error("Route unavailable.");
    }

    const km = data.routes[0].distance / 1000;
    const fare = km * RATE;

    document.getElementById("distance").textContent =
      km.toFixed(1) + " km";

    document.getElementById("total").textContent =
      "$" + fare.toFixed(2);

    document.getElementById("status").textContent =
      "Fare calculated at $0.75 per kilometre.";

    window.rideFare = {
      km,
      fare
    };

  } catch (error) {

    document.getElementById("status").textContent =
      error.message;
  }
}


document.getElementById("fareBtn").onclick = calculateFare;


document.getElementById("bookBtn").onclick = async () => {

  if (!window.rideFare) {
    await calculateFare();

    if (!window.rideFare) {
      return;
    }
  }

  const name = document.getElementById("name").value.trim();
  const phone = document.getElementById("phone").value.trim();
  const pickup = document.getElementById("pickup").value.trim();
  const dropoff = document.getElementById("dropoff").value.trim();
  const date = document.getElementById("date").value;
  const time = document.getElementById("time").value;
  const vehicle = document.getElementById("vehicle").value;

  const paymentElement =
    document.querySelector('input[name="payment"]:checked');

  const payment = paymentElement
    ? paymentElement.value
    : "Cash";


  if (!name || !phone || !pickup || !dropoff || !date || !time) {

    document.getElementById("status").textContent =
      "Please complete all booking details.";

    return;
  }


  document.getElementById("status").textContent =
    "Sending booking...";


  try {

    const response = await fetch(
      "https://mei-velocity.onrender.com/api/bookings",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          name,
          phone,
          pickup,
          dropoff,
          date,
          time,
          vehicle,
          distance: window.rideFare.km,
          fare: window.rideFare.fare,
          payment
        })
      }
    );


    const data = await response.json();


    if (!response.ok) {
      throw new Error(
        data.message || "Booking failed."
      );
    }


    document.getElementById("success").style.display =
      "block";

    document.getElementById("success").textContent =
      `Booking confirmed! Your booking number is ${data.booking.id}.`;

    document.getElementById("status").textContent =
      "MEI Velocity has received your ride request.";

  } catch (error) {

    document.getElementById("status").textContent =
      "Booking failed: " + error.message;

  }

};