const RATE = 0.75;
const API_BASE = "https://mei-velocity1.onrender.com";

function apiErrorMessage(error) {
  if (
    error instanceof TypeError &&
    /failed to fetch|networkerror/i.test(error.message || "")
  ) {
    return "Could not connect to MEI Velocity. Check your internet connection and try again.";
  }

  return error?.message || "The request could not be completed.";
}

async function readApiResponse(
  response,
  fallback = "The request could not be completed."
) {
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    const body = await response.text();

    if (
      response.status === 404 &&
      /Cannot (GET|POST|PATCH|DELETE) \/api\/customer\//i.test(body)
    ) {
      throw new Error(
        "Customer accounts are not available on the MEI Velocity server yet. The backend needs to be updated and redeployed before you can verify your account."
      );
    }

    throw new Error(
      "MEI Velocity returned an unexpected response. Please try again later."
    );
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || fallback);
  }

  return data;
}

let suggestionTimer;
let customerRidePollTimer;
let currentCustomerBooking = null;

let homeMap = null;
let homePickupMarker = null;
let homeDestinationMarker = null;
let homeRouteLine = null;

let currentPickupCoords = null;
let currentPickupAddress = "";
let currentPickupAccuracy = null;
let usingCurrentPickup = false;

let homeWhen = "now";
let appliedPromotion = null;
let customerSession = null;
let pendingBookingAfterAuth = false;


/* =========================================================
   MAP
========================================================= */

function addMeiBasemap(map) {
  const tileUrl =
    window.MEI_MAP_TILE_URL ||
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

  return L.tileLayer(tileUrl, {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
  }).addTo(map);
}

function riderLocationIcon() {
  return L.divIcon({
    className: "rider-live-marker",
    html: '<span class="rider-location-pin" aria-hidden="true"></span>',
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });
}

function driverCarIcon() {
  return L.divIcon({
    className: "driver-live-marker",
    html: '<span class="driver-car-pin" aria-hidden="true">🚘</span>',
    iconSize: [42, 42],
    iconAnchor: [21, 21]
  });
}

async function reverseGeocode(lat, lon) {
  const response = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
  );

  if (!response.ok) {
    throw new Error("Could not identify this address.");
  }

  const place = await response.json();

  return place.display_name ||
    `${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`;
}

function showHomeRiderLocation(lat, lon) {
  if (!homeMap) return;

  const point = [lat, lon];

  if (!homePickupMarker) {
    homePickupMarker = L.marker(point, {
      icon: riderLocationIcon(),
      zIndexOffset: 1000
    })
      .addTo(homeMap)
      .bindPopup("Your current location");
  } else {
    homePickupMarker.setLatLng(point);
  }

  homeMap.setView(point, 17);
}


/* =========================================================
   LOCATION SUGGESTIONS
========================================================= */

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
        "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=zw&q=" +
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


document
  .getElementById("pickup")
  .addEventListener("input", function () {
    getLocationSuggestions(this, "pickupSuggestions");
  });

document
  .getElementById("dropoff")
  .addEventListener("input", function () {
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


/* =========================================================
   FARE
========================================================= */

async function calculateFare() {
  const pickup =
    document.getElementById("pickup").value.trim();

  const dropoff =
    document.getElementById("dropoff").value.trim();

  if (!pickup || !dropoff) {
    document.getElementById("status").textContent =
      "Enter both pickup and drop-off locations.";

    return;
  }

  document.getElementById("status").textContent =
    "Calculating route...";

  try {
    const p =
      usingCurrentPickup && currentPickupCoords
        ? currentPickupCoords
        : await geocode(pickup);

    const q = await geocode(dropoff);

    const response = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${p.lon},${p.lat};${q.lon},${q.lat}?overview=full&geometries=geojson`
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
      fare,
      pickupCoords: { lat: p.lat, lon: p.lon },
      dropoffCoords: { lat: q.lat, lon: q.lon }
    };

    if (
      homeMap &&
      data.routes[0].geometry?.coordinates
    ) {
      const points =
        data.routes[0].geometry.coordinates.map(
          ([lon, lat]) => [lat, lon]
        );

      if (homeRouteLine) {
        homeRouteLine.remove();
      }

      homeRouteLine =
        L.polyline(points, {
          color: "#ff8b32",
          weight: 5,
          opacity: 0.92
        }).addTo(homeMap);

      homeMap.fitBounds(
        homeRouteLine.getBounds(),
        {
          paddingTopLeft: [38, 105],
          paddingBottomRight: [38, 315],
          maxZoom: 15
        }
      );

      if (homeDestinationMarker) {
        homeDestinationMarker.remove();
      }

      homeDestinationMarker =
        L.circleMarker(
          [q.lat, q.lon],
          {
            radius: 8,
            color: "#fff",
            weight: 3,
            fillColor: "#ff8b32",
            fillOpacity: 1
          }
        )
          .addTo(homeMap)
          .bindPopup("Destination");
    }

  } catch (error) {
    document.getElementById("status").textContent =
      error.message;
  }
}


document.getElementById("fareBtn").onclick =
  calculateFare;


/* =========================================================
   HOME MAP
========================================================= */

function initHomeMap() {
  const element =
    document.getElementById("homeMap");

  if (!element || !window.L) {
    return;
  }

  homeMap =
    L.map(element, {
      zoomControl: false,
      attributionControl: true
    }).setView(
      [-17.8252, 31.0335],
      12
    );

  addMeiBasemap(homeMap);

  setTimeout(() => {
    homeMap?.invalidateSize();
  }, 150);
}


/* =========================================================
   CURRENT LOCATION
========================================================= */

function selectCurrentLocation({ automatic = false } = {}) {
  const message =
    document.getElementById("tripMessage");

  if (!navigator.geolocation) {
    message.textContent =
      "Your browser does not support location services. Enter your pickup location instead.";
    return;
  }

  message.textContent =
    automatic
      ? "Detecting your current location…"
      : "Getting your precise location…";

  navigator.geolocation.getCurrentPosition(
    async position => {
      currentPickupCoords = {
        lat: position.coords.latitude,
        lon: position.coords.longitude
      };

      currentPickupAccuracy =
        Number.isFinite(position.coords.accuracy)
          ? Math.round(position.coords.accuracy)
          : null;

      usingCurrentPickup = true;

      showHomeRiderLocation(
        currentPickupCoords.lat,
        currentPickupCoords.lon
      );

      let address = "Current location";

      try {
        address = await reverseGeocode(
          currentPickupCoords.lat,
          currentPickupCoords.lon
        );
      } catch (error) {
        console.warn("Reverse geocoding unavailable:", error);
      }

      currentPickupAddress = address;

      const homePickup =
        document.getElementById("homePickup");

      const bookingPickup =
        document.getElementById("pickup");

      if (homePickup) {
        homePickup.value = address;
      }

      if (bookingPickup) {
        bookingPickup.value = address;
      }

      const location =
        document.getElementById("mapLocation");

      if (location?.lastElementChild) {
        location.lastElementChild.textContent =
          currentPickupAccuracy
            ? `Your location · ±${currentPickupAccuracy} m`
            : "Your current location";
      }

      message.textContent =
        currentPickupAccuracy
          ? `Current location selected (about ±${currentPickupAccuracy} m accuracy). You can still type a different pickup.`
          : "Current location selected. You can still type a different pickup.";
    },

    error => {
      usingCurrentPickup = false;
      currentPickupCoords = null;
      currentPickupAddress = "";

      message.textContent =
        error.code === 1
          ? "Location access was not allowed. Enter your pickup location manually instead."
          : "We could not detect your current location. Enter your pickup location manually instead.";
    },

    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0
    }
  );
}


/* =========================================================
   HOME SEARCH
========================================================= */

function lookupTripSuggestions(
  input,
  datalist
) {
  if (
    input.value.trim().length < 3 ||
    input.value === "Current location"
  ) {
    datalist.replaceChildren();
    return;
  }

  clearTimeout(suggestionTimer);

  suggestionTimer =
    setTimeout(async () => {
      try {
        const url =
          "https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=zw&q=" +
          encodeURIComponent(
            input.value.trim()
          );

        const response =
          await fetch(url);

        const places =
          await response.json();

        datalist.replaceChildren(
          ...places.map(place => {
            const option =
              document.createElement(
                "option"
              );

            option.value =
              place.display_name;

            return option;
          })
        );

      } catch (error) {
        console.warn(
          "Map search suggestions are unavailable.",
          error
        );
      }
    }, 450);
}


function localDateTime() {
  const now = new Date();

  return {
    date:
      `${now.getFullYear()}-${String(
        now.getMonth() + 1
      ).padStart(2, "0")}-${String(
        now.getDate()
      ).padStart(2, "0")}`,

    time:
      `${String(
        now.getHours()
      ).padStart(2, "0")}:${String(
        now.getMinutes()
      ).padStart(2, "0")}`
  };
}


/* =========================================================
   RECENT LOCATIONS
========================================================= */

function rememberRecentLocations(
  ...places
) {
  try {
    const previous =
      JSON.parse(
        localStorage.getItem(
          "meiVelocityRecentLocations"
        ) || "[]"
      );

    const recent =
      [
        ...new Set([
          ...places
            .map(place =>
              String(place || "").trim()
            )
            .filter(
              place =>
                place &&
                place !== "Current location"
            ),

          ...previous
        ])
      ].slice(0, 6);

    localStorage.setItem(
      "meiVelocityRecentLocations",
      JSON.stringify(recent)
    );

    renderRecentLocations(
      recent
    );

  } catch (error) {
    console.warn(
      "Could not save recent locations.",
      error
    );
  }
}


function renderRecentLocations(
  entries
) {
  const container =
    document.getElementById(
      "savedLocations"
    );

  if (!container) {
    return;
  }

  let locations = entries;

  if (!locations) {
    try {
      locations =
        JSON.parse(
          localStorage.getItem(
            "meiVelocityRecentLocations"
          ) || "[]"
        );

    } catch {
      locations = [];
    }
  }

  container.replaceChildren();

  if (!locations.length) {
    return;
  }

  const title =
    document.createElement(
      "small"
    );

  title.textContent =
    "Recent locations";

  container.appendChild(
    title
  );

  locations.forEach(place => {
    const button =
      document.createElement(
        "button"
      );

    button.type = "button";
    button.textContent = place;
    button.title =
      "Use as pickup";

    button.addEventListener(
      "click",
      () => {
        document.getElementById(
          "homePickup"
        ).value = place;

        document.getElementById(
          "tripMessage"
        ).textContent =
          "Recent location set as pickup.";
      }
    );

    container.appendChild(
      button
    );
  });
}


/* =========================================================
   RIDE OPTIONS
========================================================= */

function displayRideQuotes() {
  if (!window.rideFare) {
    return;
  }

  const discount =
    appliedPromotion
      ? Math.min(
          10,
          window.rideFare.fare
        )
      : 0;

  document.getElementById(
    "quoteDistance"
  ).textContent =
    `${window.rideFare.km.toFixed(
      1
    )} km route`;

  const choices = [
    {
      vehicle: "Toyota Spade",
      icon: "🚕",
      rate: RATE,
      subtitle: "Standard ride"
    },

    {
      vehicle: "Nissan Note",
      icon: "🚙",
      rate: RATE,
      subtitle: "Fuel efficient"
    }
  ];

  const cards =
    document.getElementById(
      "quoteCards"
    );

  document.getElementById(
    "rideOffer"
  ).value =
    Math.max(
      0,
      window.rideFare.fare -
        discount
    ).toFixed(2);

  cards.replaceChildren(
    ...choices.map(choice => {
      const base =
        window.rideFare.km *
        choice.rate;

      const price =
        Math.max(
          0,
          base - discount
        );

      const card =
        document.createElement(
          "button"
        );

      card.type = "button";
      card.className =
        "quote-card";

      const icon =
        document.createElement(
          "span"
        );

      icon.className =
        "vehicle-symbol";

      icon.textContent =
        choice.icon;

      const info =
        document.createElement(
          "span"
        );

      info.className =
        "quote-info";

      const vehicle =
        document.createElement(
          "strong"
        );

      vehicle.textContent =
        choice.vehicle;

      const detail =
        document.createElement(
          "small"
        );

      detail.textContent =
        appliedPromotion
          ? `${choice.subtitle} · $${discount.toFixed(
              2
            )} credit applied`
          : `${choice.subtitle} · $${choice.rate.toFixed(
              2
            )}/km`;

      info.append(
        vehicle,
        detail
      );

      const fare =
        document.createElement(
          "span"
        );

      fare.className =
        "quote-price";

      fare.textContent =
        `$${price.toFixed(2)}`;

      const label =
        document.createElement(
          "small"
        );

      label.textContent =
        "estimated fare";

      fare.appendChild(
        label
      );

      card.append(
        icon,
        info,
        fare
      );

      card.addEventListener(
        "click",
        () =>
          chooseRide(
            choice.vehicle,
            base
          )
      );

      return card;
    })
  );

  document.getElementById(
    "rideQuotes"
  ).hidden = false;

  document.getElementById(
    "promoEntry"
  ).hidden =
    !document.getElementById(
      "promoEntry"
    ).dataset.open;
}


/* =========================================================
   CHOOSE RIDE
========================================================= */

function chooseRide(
  vehicle,
  baseFare
) {
  document.getElementById(
    "pickup"
  ).value =
    document.getElementById(
      "homePickup"
    ).value.trim();

  document.getElementById(
    "dropoff"
  ).value =
    document.getElementById(
      "homeDropoff"
    ).value.trim();

  document.getElementById(
    "vehicle"
  ).value = vehicle;

  const when =
    localDateTime();

  document.getElementById(
    "date"
  ).value =
    homeWhen === "later"
      ? document.getElementById(
          "homeDate"
        ).value
      : when.date;

  document.getElementById(
    "time"
  ).value =
    homeWhen === "later"
      ? document.getElementById(
          "homeTime"
        ).value
      : when.time;

  const discount =
    appliedPromotion
      ? Math.min(
          10,
          baseFare
        )
      : 0;

  const suggestedFare =
    Math.max(
      0,
      baseFare -
        discount
    );

  document.getElementById(
    "rideOffer"
  ).value =
    suggestedFare.toFixed(2);

  window.rideFare = {
    km:
      window.rideFare.km,

    fare:
      suggestedFare,

    baseFare,

    pickupCoords:
      window.rideFare.pickupCoords,

    dropoffCoords:
      window.rideFare.dropoffCoords
  };

  document.getElementById(
    "total"
  ).textContent =
    `$${window.rideFare.fare.toFixed(
      2
    )}`;

  document.getElementById(
    "distance"
  ).textContent =
    `${window.rideFare.km.toFixed(
      1
    )} km`;

  document.getElementById(
    "status"
  ).textContent =
    appliedPromotion
      ? `WELCOME10 credit applied: $${discount.toFixed(
          2
        )} off.`
      : "Suggested fare shown. Adjust your offer before requesting if you wish.";

  const draft = {
    pickup:
      document
        .getElementById(
          "pickup"
        )
        .value.trim(),

    dropoff:
      document
        .getElementById(
          "dropoff"
        )
        .value.trim(),

    pickupLat:
      window.rideFare?.pickupCoords?.lat ?? null,

    pickupLng:
      window.rideFare?.pickupCoords?.lon ?? null,

    dropoffLat:
      window.rideFare?.dropoffCoords?.lat ?? null,

    dropoffLng:
      window.rideFare?.dropoffCoords?.lon ?? null,

    pickupSource:
      usingCurrentPickup ? "current" : "manual",

    date:
      document.getElementById(
        "date"
      ).value,

    time:
      document.getElementById(
        "time"
      ).value,

    vehicle,

    distance:
      window.rideFare.km,

    baseFare,

    fare:
      suggestedFare,

    promoCode:
      appliedPromotion?.code ||
      "",

    payment:
      "Cash"
  };

  localStorage.setItem(
    "meiVelocityBookingDraft",
    JSON.stringify(draft)
  );

  window.location.assign(
    "index.html?view=confirm"
  );
}

document
  .getElementById(
    "rideOffer"
  )
  .addEventListener(
    "input",
    event => {
      const offer =
        Number(
          event.currentTarget.value
        );

      if (
        window.rideFare &&
        Number.isFinite(offer) &&
        offer >= 0
      ) {
        window.rideFare.fare =
          Math.round(
            offer * 100
          ) / 100;

        document.getElementById(
          "total"
        ).textContent =
          `$${window.rideFare.fare.toFixed(
            2
          )}`;
      }
    }
  );


/* =========================================================
   SEARCH RIDES
========================================================= */

async function searchRides() {
  const pickup =
    document.getElementById(
      "homePickup"
    ).value.trim();

  const dropoff =
    document.getElementById(
      "homeDropoff"
    ).value.trim();

  const message =
    document.getElementById(
      "tripMessage"
    );

  if (!pickup || !dropoff) {
    message.textContent =
      "Enter a pickup and destination first.";

    return;
  }

  if (
    homeWhen === "later" &&
    (
      !document.getElementById(
        "homeDate"
      ).value ||
      !document.getElementById(
        "homeTime"
      ).value
    )
  ) {
    message.textContent =
      "Choose a date and time for your scheduled ride.";

    return;
  }

  document.getElementById(
    "pickup"
  ).value = pickup;

  document.getElementById(
    "dropoff"
  ).value = dropoff;

  window.rideFare = null;

  message.textContent =
    "Finding the route and prices…";

  await calculateFare();

  if (window.rideFare) {
    rememberRecentLocations(
      pickup,
      dropoff
    );

    message.textContent =
      "Choose a ride to continue.";

    displayRideQuotes();

  } else {
    message.textContent =
      document.getElementById(
        "status"
      ).textContent;
  }
}


/* =========================================================
   HOME EVENTS
========================================================= */

document
  .getElementById(
    "locateMe"
  )
  .addEventListener(
    "click",
    selectCurrentLocation
  );

document
  .getElementById(
    "locatePickup"
  )
  .addEventListener(
    "click",
    selectCurrentLocation
  );

document
  .getElementById(
    "homePickup"
  )
  .addEventListener(
    "input",
    function () {
      if (
        !usingCurrentPickup ||
        this.value.trim() !== currentPickupAddress
      ) {
        usingCurrentPickup = false;
        currentPickupCoords = null;
        currentPickupAddress = "";
        currentPickupAccuracy = null;
      }

      lookupTripSuggestions(
        this,
        document.getElementById(
          "homePickupSuggestions"
        )
      );
    }
  );

document
  .getElementById(
    "homeDropoff"
  )
  .addEventListener(
    "input",
    function () {
      lookupTripSuggestions(
        this,
        document.getElementById(
          "homeDropoffSuggestions"
        )
      );
    }
  );

document
  .getElementById(
    "findRides"
  )
  .addEventListener(
    "click",
    searchRides
  );

document
  .getElementById(
    "changeRoute"
  )
  .addEventListener(
    "click",
    () => {
      document.getElementById(
        "rideQuotes"
      ).hidden = true;

      document.getElementById(
        "tripSearch"
      ).hidden = false;
    }
  );


document
  .querySelectorAll(
    ".timing-choice"
  )
  .forEach(button =>
    button.addEventListener(
      "click",
      () => {
        homeWhen =
          button.dataset.when;

        document
          .querySelectorAll(
            ".timing-choice"
          )
          .forEach(item =>
            item.classList.toggle(
              "active",
              item === button
            )
          );

        const schedule =
          document.getElementById(
            "scheduleFields"
          );

        schedule.hidden =
          homeWhen !== "later";

        if (
          homeWhen ===
          "later"
        ) {
          const when =
            localDateTime();

          document.getElementById(
            "homeDate"
          ).value ||= when.date;

          document.getElementById(
            "homeTime"
          ).value ||= when.time;
        }
      }
    )
  );


document
  .querySelectorAll(
    "[data-booking-when]"
  )
  .forEach(button =>
    button.addEventListener(
      "click",
      () => {
        homeWhen =
          button.dataset.bookingWhen;

        document
          .querySelectorAll(
            "[data-booking-when]"
          )
          .forEach(item =>
            item.classList.toggle(
              "active",
              item === button
            )
          );

        const when =
          localDateTime();

        const rideDate =
          homeWhen === "later"
            ? (
                document.getElementById(
                  "homeDate"
                ).value ||
                when.date
              )
            : when.date;

        const rideTime =
          homeWhen === "later"
            ? (
                document.getElementById(
                  "homeTime"
                ).value ||
                when.time
              )
            : when.time;

        if (
          homeWhen === "later"
        ) {
          document.getElementById(
            "homeDate"
          ).value ||= rideDate;

          document.getElementById(
            "homeTime"
          ).value ||= rideTime;
        }

        document.getElementById(
          "date"
        ).value = rideDate;

        document.getElementById(
          "time"
        ).value = rideTime;
      }
    )
  );


if (
  !new URLSearchParams(
    window.location.search
  ).has("view")
) {
  initHomeMap();

  setTimeout(() => {
    const pickupInput =
      document.getElementById(
        "homePickup"
      );

    if (
      pickupInput &&
      !pickupInput.value.trim()
    ) {
      selectCurrentLocation({
        automatic: true
      });
    }
  }, 450);
}


/* =========================================================
   CUSTOMER RIDE TRACKING
========================================================= */

function customerRideStep(
  booking
) {
  if (!booking) {
    return 0;
  }

  if (
    booking.status ===
    "Cancelled"
  ) {
    return -1;
  }

  if (
    booking.status ===
      "Completed" ||
    booking.driverStatus ===
      "Completed"
  ) {
    return 5;
  }

  switch (
    booking.driverStatus
  ) {
    case "Picked Up":
      return 4;

    case "Arrived":
      return 3;

    case "On the Way":
      return 2;

    case "Accepted":
      return 1;

    default:
      return booking.assignedDriverId
        ? 1
        : 0;
  }
}


function customerRideTitle(
  booking
) {
  if (!booking) {
    return "Booking Received";
  }

  if (
    booking.status ===
    "Cancelled"
  ) {
    return "Ride Cancelled";
  }

  if (
    booking.status ===
      "Completed" ||
    booking.driverStatus ===
      "Completed"
  ) {
    return "Ride Completed";
  }

  switch (
    booking.driverStatus
  ) {
    case "Picked Up":
      return "Ride Started";

    case "Arrived":
      return "Driver Arrived";

    case "On the Way":
      return "Driver On the Way";

    case "Accepted":
      return "Driver Assigned";

    default:
      return "Booking Received";
  }
}


function customerRideMessage(
  booking
) {
  if (!booking) {
    return "We are looking for an available driver.";
  }

  if (
    booking.status ===
    "Cancelled"
  ) {
    return "This ride has been cancelled. Please contact MEI Velocity if you need help.";
  }

  if (
    booking.status ===
      "Completed" ||
    booking.driverStatus ===
      "Completed"
  ) {
    return "Thank you for riding with MEI Velocity.";
  }

  switch (
    booking.driverStatus
  ) {
    case "Picked Up":
      return "Your ride is now in progress.";

    case "Arrived":
      return "Your driver has arrived at the pickup location.";

    case "On the Way":
      return "Your driver is on the way to you.";

    case "Accepted":
      return "A driver has accepted your ride.";

    default:
      return "We are looking for an available driver.";
  }
}


let driverMap = null;
let driverMarker = null;


function updateDriverMap(
  booking
) {
  const mapWrap =
    document.getElementById(
      "driverMapWrap"
    );

  const mapElement =
    document.getElementById(
      "driverMap"
    );

  const mapStatus =
    document.getElementById(
      "driverMapStatus"
    );

  if (
    !mapWrap ||
    !mapElement ||
    !mapStatus
  ) {
    return;
  }

  const activeStatuses = [
    "Confirmed"
  ];

  const driverStatuses = [
    "Accepted",
    "On the Way",
    "Arrived",
    "Picked Up"
  ];

  if (
    !booking?.assignedDriverId ||
    !activeStatuses.includes(
      booking.status
    ) ||
    !driverStatuses.includes(
      booking.driverStatus
    )
  ) {
    mapWrap.style.display =
      "none";

    return;
  }

  mapWrap.style.display =
    "block";

  if (!driverMap) {
    driverMap =
      L.map(
        mapElement,
        {
          zoomControl: true
        }
      ).setView(
        [-17.8252, 31.0335],
        13
      );

    addMeiBasemap(
      driverMap
    );
  }

  const lat =
    Number(
      booking.driverLat
    );

  const lng =
    Number(
      booking.driverLng
    );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    if (driverMarker) {
      driverMarker.remove();
      driverMarker = null;
    }

    driverMap.setView(
      [-17.8252, 31.0335],
      12
    );

    mapStatus.textContent =
      "Waiting for driver's live location...";

    return;
  }

  const position = [
    lat,
    lng
  ];

  if (!driverMarker) {
    driverMarker =
      L.marker(position)
        .addTo(driverMap);

    driverMarker.bindPopup(
      "MEI VELOCITY driver"
    );

  } else {
    driverMarker.setLatLng(
      position
    );
  }

  driverMap.setView(
    position,
    Math.max(
      driverMap.getZoom(),
      15
    )
  );

  if (
    booking.driverLocationUpdatedAt
  ) {
    const updated =
      new Date(
        booking.driverLocationUpdatedAt
      );

    const secondsAgo =
      Math.max(
        0,
        Math.round(
          (
            Date.now() -
            updated.getTime()
          ) / 1000
        )
      );

    mapStatus.textContent =
      secondsAgo < 60
        ? `Driver location updated ${secondsAgo}s ago`
        : "Driver location hasn't updated recently.";

  } else {
    mapStatus.textContent =
      "Driver location is updating...";
  }

  setTimeout(() => {
    if (driverMap) {
      driverMap.invalidateSize();
    }
  }, 100);
}

/* =========================================================
   RENDER CUSTOMER RIDE
========================================================= */

function renderCustomerRide(
  booking
) {
  const tracker =
    document.getElementById(
      "rideTracker"
    );

  if (!tracker) {
    return;
  }

  tracker.style.display =
    "block";

  document.getElementById(
    "rideBookingId"
  ).textContent =
    booking?.id || "";

  document.getElementById(
    "rideTrackerTitle"
  ).textContent =
    customerRideTitle(
      booking
    );

  document.getElementById(
    "rideTrackerMessage"
  ).textContent =
    customerRideMessage(
      booking
    );

  const rideState =
    `${booking?.status || ""}:${booking?.driverStatus || ""}`;

  if (
    currentCustomerBooking?.id ===
      booking?.id &&
    currentCustomerBooking.lastStatus &&
    currentCustomerBooking.lastStatus !==
      rideState &&
    localStorage.getItem(
      "meiVelocityRideNotifications"
    ) === "true" &&
    "Notification" in window &&
    Notification.permission ===
      "granted"
  ) {
    new Notification(
      "MEI Velocity ride update",
      {
        body:
          customerRideMessage(
            booking
          )
      }
    );
  }

  if (
    currentCustomerBooking?.id ===
    booking?.id
  ) {
    currentCustomerBooking.lastStatus =
      rideState;

    localStorage.setItem(
      "meiVelocityCustomerBooking",
      JSON.stringify(
        currentCustomerBooking
      )
    );
  }

  const terminalRide =
    [
      "Completed",
      "Cancelled"
    ].includes(
      booking?.status
    ) ||
    booking?.driverStatus ===
      "Completed";

  document.getElementById(
    "cancelRideButton"
  ).hidden =
    !(
      booking?.status ===
        "Pending" &&
      !booking?.assignedDriverId
    );

  document.getElementById(
    "bookAnotherRideButton"
  ).hidden =
    !terminalRide;

  const ratingPanel =
    document.getElementById(
      "rideRating"
    );

  const completedRide =
    booking?.status ===
      "Completed" ||
    booking?.driverStatus ===
      "Completed";

  ratingPanel.hidden =
    !completedRide;

  document.getElementById(
    "rideRatingMessage"
  ).textContent =
    booking?.rating
      ? `Thanks for rating this ride ${booking.rating}/5.`
      : "Your feedback helps us improve.";

  document.getElementById(
    "rideRatingValue"
  ).hidden =
    Boolean(
      booking?.rating
    );

  document.getElementById(
    "submitRideRating"
  ).hidden =
    Boolean(
      booking?.rating
    );

  const stepIndex =
    customerRideStep(
      booking
    );

  document
    .querySelectorAll(
      ".ride-step"
    )
    .forEach(
      (step, index) => {
        step.classList.toggle(
          "active",
          stepIndex >= 0 &&
            index <= stepIndex
        );

        step.classList.toggle(
          "current",
          stepIndex >= 0 &&
            index === stepIndex
        );
      }
    );

  const driverCard =
    document.getElementById(
      "driverCard"
    );

  if (
    booking?.assignedDriverId
  ) {
    driverCard.style.display =
      "grid";

    document.getElementById(
      "driverName"
    ).textContent =
      booking.driverName ||
      booking.assignedDriverName ||
      "Assigned driver";

    document.getElementById(
      "driverVehicle"
    ).textContent =
      booking.driverVehicle ||
      booking.vehicle ||
      "Vehicle assigned";

    document.getElementById(
      "driverPlate"
    ).textContent =
      booking.driverPlate ||
      "—";

  } else {
    driverCard.style.display =
      "none";
  }

  document.getElementById(
    "rideTrackerUpdated"
  ).textContent =
    "Last checked: " +
    new Date().toLocaleTimeString();

  try {
    const history =
      JSON.parse(
        localStorage.getItem(
          "meiVelocityRideHistory"
        ) || "[]"
      );

    const saved =
      history.find(
        item =>
          item.id ===
          booking?.id
      );

    if (saved) {
      saved.status =
        booking.status ||
        booking.driverStatus ||
        saved.status;

      if (
        booking.rating
      ) {
        saved.rating =
          booking.rating;
      }

      localStorage.setItem(
        "meiVelocityRideHistory",
        JSON.stringify(
          history
        )
      );

      renderRideHistory();
    }

  } catch (error) {
    console.warn(
      "Could not update local ride history.",
      error
    );
  }
}


/* =========================================================
   CUSTOMER RIDE STATUS
========================================================= */

async function fetchCustomerRideStatus() {
  if (!currentCustomerBooking) {
    return;
  }

  const {
    id,
    phone
  } =
    currentCustomerBooking;

  try {
    const response =
      await fetch(
        `${API_BASE}/api/bookings/${encodeURIComponent(
          id
        )}/status?phone=${encodeURIComponent(
          phone
        )}`
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.message ||
          "Unable to check ride status."
      );
    }

    renderCustomerRide(
      data.booking
    );

    updateDriverMap(
      data.booking
    );

    if (
      data.booking &&
      [
        "Completed",
        "Cancelled"
      ].includes(
        data.booking.status
      )
    ) {
      stopCustomerRidePolling();
    }

  } catch (error) {
    console.error(
      "Customer ride status error:",
      error
    );
  }
}


function startCustomerRidePolling() {
  stopCustomerRidePolling();

  fetchCustomerRideStatus();

  customerRidePollTimer =
    setInterval(
      fetchCustomerRideStatus,
      4000
    );
}


function stopCustomerRidePolling() {
  if (customerRidePollTimer) {
    clearInterval(
      customerRidePollTimer
    );

    customerRidePollTimer =
      null;
  }
}


/* =========================================================
   SAVE BOOKING
========================================================= */

function saveCustomerBooking(
  booking
) {
  currentCustomerBooking = {
    id:
      booking.id,

    phone:
      booking.phone ||
      customerSession?.customer?.phone ||
      ""
  };

  try {
    localStorage.setItem(
      "meiVelocityCustomerBooking",
      JSON.stringify(
        currentCustomerBooking
      )
    );

    const history =
      JSON.parse(
        localStorage.getItem(
          "meiVelocityRideHistory"
        ) || "[]"
      );

    history.unshift({
      id:
        booking.id,

      phone:
        currentCustomerBooking.phone,

      pickup:
        booking.pickup,

      dropoff:
        booking.dropoff,

      date:
        booking.date,

      time:
        booking.time,

      vehicle:
        booking.vehicle,

      fare:
        booking.fare,

      distance:
        booking.distance,

      discount:
        booking.discount ||
        0,

      status:
        booking.status ||
        "Pending"
    });

    localStorage.setItem(
      "meiVelocityRideHistory",
      JSON.stringify(
        history.slice(
          0,
          50
        )
      )
    );

    renderRideHistory();

  } catch (error) {
    console.warn(
      "Could not save customer booking locally.",
      error
    );
  }
}


/* =========================================================
   RESTORE ACCOUNT / BOOKING
========================================================= */

function restoreCustomerBooking() {
  document.getElementById(
    "tripSearch"
  ).hidden = false;

  document.getElementById(
    "rideQuotes"
  ).hidden = true;

  document.getElementById(
    "scheduleFields"
  ).hidden = true;

  document.getElementById(
    "homeSheet"
  ).classList.add(
    "route-mode"
  );

  document.getElementById(
    "book"
  ).classList.remove(
    "booking-open"
  );

  homeWhen = "now";

  document
    .querySelectorAll(
      ".timing-choice"
    )
    .forEach(button =>
      button.classList.toggle(
        "active",
        button.dataset.when ===
          "now"
      )
    );

  try {
    const saved =
      JSON.parse(
        localStorage.getItem(
          "meiVelocityCustomerBooking"
        ) || "null"
      );

    if (
      saved?.id &&
      saved?.phone
    ) {
      currentCustomerBooking =
        saved;

      document.getElementById(
        "rideTracker"
      ).style.display =
        "block";

      document.getElementById(
        "rideBookingId"
      ).textContent =
        saved.id;

      startCustomerRidePolling();
    }

  } catch (error) {
    console.warn(
      "Could not restore customer booking.",
      error
    );
  }

  try {
    customerSession =
      JSON.parse(
        localStorage.getItem(
          "meiVelocityCustomerSession"
        ) || "null"
      );

    if (
      customerSession?.token &&
      customerSession?.customer
    ) {
      document.getElementById(
        "accountButton"
      ).textContent =
        customerSession.customer.username
          .slice(
            0,
            2
          )
          .toUpperCase();

      const profileUsername =
        document.getElementById(
          "profileUsername"
        );

      const profilePhone =
        document.getElementById(
          "profilePhone"
        );

      if (profileUsername) {
        profileUsername.textContent =
          customerSession.customer.username;
      }

      if (profilePhone) {
        profilePhone.textContent =
          customerSession.customer.phone;
      }

      document.getElementById(
        "rideNotifications"
      ).checked =
        localStorage.getItem(
          "meiVelocityRideNotifications"
        ) === "true";
    }

  } catch (error) {
    console.warn(
      "Could not restore customer account.",
      error
    );
  }

  renderRideHistory();

  if (
    customerSession?.token
  ) {
    loadAccountRideHistory();
  }
}


/* =========================================================
   BOOK RIDE
========================================================= */

document.getElementById(
  "bookBtn"
).onclick =
  async () => {
    if (!window.rideFare) {
      await calculateFare();

      if (!window.rideFare) {
        return;
      }
    }

    const pickup =
      document.getElementById(
        "pickup"
      ).value.trim();

    const dropoff =
      document.getElementById(
        "dropoff"
      ).value.trim();

    const date =
      document.getElementById(
        "date"
      ).value;

    const time =
      document.getElementById(
        "time"
      ).value;

    const vehicle =
      document.getElementById(
        "vehicle"
      ).value;

    const fare =
      Number(
        document.getElementById(
          "rideOffer"
        ).value ||
          window.rideFare.fare
      );

    if (
      !pickup ||
      !dropoff ||
      !date ||
      !time ||
      !vehicle
    ) {
      document.getElementById(
        "status"
      ).textContent =
        "Please complete the ride details first.";

      return;
    }

    if (
      !Number.isFinite(fare) ||
      fare < 0
    ) {
      document.getElementById(
        "status"
      ).textContent =
        "Enter a valid fare offer.";

      return;
    }

    localStorage.setItem(
      "meiVelocityBookingDraft",
      JSON.stringify({
        pickup,
        dropoff,

        pickupLat:
          window.rideFare?.pickupCoords?.lat ?? null,

        pickupLng:
          window.rideFare?.pickupCoords?.lon ?? null,

        dropoffLat:
          window.rideFare?.dropoffCoords?.lat ?? null,

        dropoffLng:
          window.rideFare?.dropoffCoords?.lon ?? null,

        pickupSource:
          usingCurrentPickup ? "current" : "manual",

        date,
        time,
        vehicle,

        distance:
          Number(
            window.rideFare.km
          ),

        baseFare:
          Number(
            window.rideFare.baseFare ||
              window.rideFare.fare
          ),

        fare:
          Math.round(
            fare * 100
          ) / 100,

        promoCode:
          appliedPromotion?.code ||
          "",

        payment:
          document.querySelector(
            'input[name="payment"]:checked'
          )?.value ||
          "Cash"
      })
    );

    window.location.assign(
      "index.html?view=confirm"
    );
  };


/* =========================================================
   CANCEL RIDE
========================================================= */

document
  .getElementById(
    "cancelRideButton"
  )
  .addEventListener(
    "click",
    async event => {
      const button =
        event.currentTarget;

      if (
        !currentCustomerBooking ||
        button.disabled
      ) {
        return;
      }

      button.disabled = true;
      button.textContent =
        "Cancelling…";

      try {
        const response =
          await fetch(
            `${API_BASE}/api/bookings/${encodeURIComponent(
              currentCustomerBooking.id
            )}/cancel`,
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  phone:
                    currentCustomerBooking.phone
                })
            }
          );

        const data =
          await response.json();

        if (!response.ok) {
          throw new Error(
            data.message ||
              "Unable to cancel this ride."
          );
        }

        renderCustomerRide(
          data.booking
        );

        updateDriverMap(
          data.booking
        );

        stopCustomerRidePolling();

      } catch (error) {
        document.getElementById(
          "rideTrackerMessage"
        ).textContent =
          error.message;

      } finally {
        button.disabled =
          false;

        button.textContent =
          "Cancel ride request";
      }
    }
  );


/* =========================================================
   RATING
========================================================= */

document
  .getElementById(
    "submitRideRating"
  )
  .addEventListener(
    "click",
    async event => {
      const button =
        event.currentTarget;

      if (
        !currentCustomerBooking?.id
      ) {
        return;
      }

      if (
        !customerSession?.token
      ) {
        pendingBookingAfterAuth =
          false;

        document.getElementById(
          "accountMessage"
        ).textContent =
          "Sign in to save your ride rating.";

        accountDialog.showModal();

        return;
      }

      button.disabled =
        true;

      try {
        const response =
          await fetch(
            `${API_BASE}/api/customer/bookings/${encodeURIComponent(
              currentCustomerBooking.id
            )}/rating`,
            {
              method:
                "PATCH",

              headers: {
                "Content-Type":
                  "application/json",

                Authorization:
                  `Bearer ${customerSession.token}`
              },

              body:
                JSON.stringify({
                  rating:
                    Number(
                      document.getElementById(
                        "rideRatingValue"
                      ).value
                    )
                })
            }
          );

        const data =
          await response.json();

        if (!response.ok) {
          throw new Error(
            data.message ||
              "Unable to save your rating."
          );
        }

        renderCustomerRide({
          id:
            currentCustomerBooking.id,

          status:
            "Completed",

          driverStatus:
            "Completed",

          rating:
            data.rating
        });

        renderRideHistory();

        loadAccountRideHistory();

      } catch (error) {
        document.getElementById(
          "rideRatingMessage"
        ).textContent =
          error.message;

      } finally {
        button.disabled =
          false;
      }
    }
  );


/* =========================================================
   BOOK ANOTHER
========================================================= */

document
  .getElementById(
    "bookAnotherRideButton"
  )
  .addEventListener(
    "click",
    () => {
      stopCustomerRidePolling();

      currentCustomerBooking =
        null;

      localStorage.removeItem(
        "meiVelocityCustomerBooking"
      );

      window.rideFare =
        null;

      appliedPromotion =
        null;

      document.getElementById(
        "homePickup"
      ).value = "";

      document.getElementById(
        "homeDropoff"
      ).value = "";

      currentPickupCoords = null;
      currentPickupAddress = "";
      currentPickupAccuracy = null;
      usingCurrentPickup = false;

      document.querySelector(
        "#mapLocation span:last-child"
      ).textContent =
        "Harare, Zimbabwe";

      document.getElementById(
        "pickup"
      ).value = "";

      document.getElementById(
        "dropoff"
      ).value = "";

      document.getElementById(
        "rideTracker"
      ).style.display =
        "none";

      document.getElementById(
        "success"
      ).style.display =
        "none";

      document.getElementById(
        "status"
      ).textContent =
        "Choose your route and ride option.";

      document.getElementById(
        "tripMessage"
      ).textContent =
        "";

      document.getElementById(
        "rideQuotes"
      ).hidden =
        true;

      document.getElementById(
        "quoteCards"
      ).replaceChildren();

      document.getElementById(
        "promoEntry"
      ).hidden =
        true;

      document.getElementById(
        "promoEntry"
      ).dataset.open =
        "";

      document.getElementById(
        "promoCode"
      ).value =
        "";

      document.getElementById(
        "promoMessage"
      ).textContent =
        "";

      document.getElementById(
        "scheduleFields"
      ).hidden =
        true;

      document.getElementById(
        "homeDate"
      ).value =
        "";

      document.getElementById(
        "homeTime"
      ).value =
        "";

      homeWhen =
        "now";

      document
        .querySelectorAll(
          ".timing-choice"
        )
        .forEach(item =>
          item.classList.toggle(
            "active",
            item.dataset.when ===
              "now"
          )
        );

      document.getElementById(
        "book"
      ).classList.remove(
        "booking-open"
      );

      document.getElementById(
        "tripSearch"
      ).hidden =
        false;

      document.getElementById(
        "homeSheet"
      ).classList.add(
        "route-mode"
      );

      if (
        homePickupMarker
      ) {
        homePickupMarker.remove();
        homePickupMarker =
          null;
      }

      if (
        homeDestinationMarker
      ) {
        homeDestinationMarker.remove();
        homeDestinationMarker =
          null;
      }

      if (
        homeRouteLine
      ) {
        homeRouteLine.remove();
        homeRouteLine =
          null;
      }

      if (homeMap) {
        homeMap.setView(
          [-17.8252, 31.0335],
          12
        );

        homeMap.invalidateSize();
      }

      document
        .getElementById(
          "home"
        )
        .scrollIntoView({
          behavior:
            "smooth",

          block:
            "start"
        });
    }
  );

  /* =========================================================
   ROUTE SEARCH
========================================================= */

function openRouteSearch(
  mode = "now"
) {
  const sheet =
    document.getElementById(
      "homeSheet"
    );

  document.getElementById(
    "book"
  ).classList.remove(
    "booking-open"
  );

  sheet.classList.add(
    "route-mode"
  );

  document.getElementById(
    "tripSearch"
  ).hidden =
    false;

  document.getElementById(
    "rideQuotes"
  ).hidden =
    !document.getElementById(
      "promoEntry"
    ).dataset.open;

  homeWhen =
    mode;

  document
    .querySelectorAll(
      ".timing-choice"
    )
    .forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset.when ===
          mode
      );
    });

  document.getElementById(
    "scheduleFields"
  ).hidden =
    mode !== "later";

  if (
    mode ===
    "later"
  ) {
    const when =
      localDateTime();

    document.getElementById(
      "homeDate"
    ).value ||= when.date;

    document.getElementById(
      "homeTime"
    ).value ||= when.time;
  }

  setTimeout(() => {
    homeMap?.invalidateSize();
  }, 120);

  if (
    !document.getElementById(
      "homePickup"
    ).value
  ) {
    document
      .getElementById(
        "homeDropoff"
      )
      .focus({
        preventScroll:
          true
      });
  }
}


function openBookingForm() {
  const booking =
    document.getElementById(
      "book"
    );

  booking.classList.add(
    "booking-open"
  );

  document
    .querySelectorAll(
      ".tabs button"
    )
    .forEach(
      (tab, index) =>
        tab.classList.toggle(
          "active",
          index ===
            (
              homeWhen ===
              "later"
                ? 1
                : 0
            )
        )
    );

  booking.scrollIntoView({
    behavior:
      "smooth",

    block:
      "start"
  });

  document
    .getElementById(
      "pickup"
    )
    .focus({
      preventScroll:
        true
    });
}


/* =========================================================
   NAVIGATION
========================================================= */

document
  .querySelectorAll(
    '[data-booking-mode="taxi"]'
  )
  .forEach(button => {
    button.addEventListener(
      "click",
      () =>
        openRouteSearch(
          "now"
        )
    );
  });


document
  .querySelectorAll(
    '[data-booking-mode="delivery"]'
  )
  .forEach(button => {
    button.addEventListener(
      "click",
      () =>
        window.location.assign(
          "services.html#package-delivery"
        )
    );
  });


document
  .querySelector(
    '[data-action="schedule"]'
  )
  .addEventListener(
    "click",
    event => {
      event.preventDefault();

      openRouteSearch(
        "later"
      );
    }
  );


document
  .querySelector(
    '[data-action="deliveries"]'
  )
  .addEventListener(
    "click",
    event => {
      event.preventDefault();

      window.location.assign(
        "services.html#package-delivery"
      );
    }
  );


document
  .querySelector(
    '[data-action="shop"]'
  )
  .addEventListener(
    "click",
    event => {
      event.preventDefault();

      window.location.assign(
        "services.html#shopping-errands"
      );
    }
  );


document
  .querySelector(
    '[data-action="pros"]'
  )
  .addEventListener(
    "click",
    event => {
      event.preventDefault();

      window.location.assign(
        "services.html#corporate-private"
      );
    }
  );


/* =========================================================
   PROMO
========================================================= */

document
  .querySelector(
    ".promo-row"
  )
  .addEventListener(
    "click",
    () => {
      document.getElementById(
        "promoEntry"
      ).dataset.open =
        "true";

      document.getElementById(
        "promoEntry"
      ).hidden =
        false;

      openRouteSearch(
        homeWhen
      );

      document.getElementById(
        "rideQuotes"
      ).hidden =
        false;

      document.getElementById(
        "promoCode"
      ).value ||=
        "WELCOME10";

      document
        .getElementById(
          "promoCode"
        )
        .focus({
          preventScroll:
            true
        });
    }
  );


document
  .getElementById(
    "applyPromo"
  )
  .addEventListener(
    "click",
    async () => {
      const code =
        document
          .getElementById(
            "promoCode"
          )
          .value
          .trim()
          .toUpperCase();

      const message =
        document.getElementById(
          "promoMessage"
        );

      message.textContent =
        "Checking offer…";

      try {
        const response =
          await fetch(
            `${API_BASE}/api/promotions/validate`,
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  code
                })
            }
          );

        const data =
          await response.json();

        if (!response.ok) {
          throw new Error(
            data.message ||
              "This code is not available."
          );
        }

        appliedPromotion =
          data.offer;

        message.textContent =
          `${data.offer.title}: up to $${Number(
            data.offer.discount
          ).toFixed(
            2
          )} off one ride.`;

        if (
          window.rideFare
        ) {
          displayRideQuotes();
        }

      } catch (error) {
        appliedPromotion =
          null;

        message.textContent =
          error.message;
      }
    }
  );


/* =========================================================
   HISTORY
========================================================= */

function renderRideHistory(
  entries
) {
  const list =
    document.getElementById(
      "rideHistoryList"
    );

  if (!list) {
    return;
  }

  let rides =
    entries;

  if (!rides) {
    try {
      rides =
        JSON.parse(
          localStorage.getItem(
            "meiVelocityRideHistory"
          ) || "[]"
        );

    } catch {
      rides = [];
    }
  }

  list.replaceChildren();

  if (!rides.length) {
    const empty =
      document.createElement(
        "p"
      );

    empty.textContent =
      "No saved rides yet.";

    list.appendChild(
      empty
    );

    return;
  }

  rides.forEach(ride => {
    const card =
      document.createElement(
        "article"
      );

    card.className =
      "history-card";

    const title =
      document.createElement(
        "strong"
      );

    title.textContent =
      `${ride.pickup} → ${ride.dropoff}`;

    const detail =
      document.createElement(
        "small"
      );

    detail.textContent =
      `${ride.date} at ${ride.time} · ${ride.vehicle || "Ride"} · ${ride.status || "Pending"}${ride.rating ? ` · Rated ${ride.rating}/5` : ""}`;

    const fare =
      document.createElement(
        "span"
      );

    fare.className =
      "history-fare";

    fare.textContent =
      `$${Number(
        ride.fare || 0
      ).toFixed(2)}`;

    card.append(
      title,
      detail,
      fare
    );

    if (
      ride.id &&
      (
        ride.phone ||
        customerSession?.token
      )
    ) {
      const view =
        document.createElement(
          "button"
        );

      view.type =
        "button";

      view.textContent =
        "Track ride";

      view.addEventListener(
        "click",
        () => {
          currentCustomerBooking = {
            id:
              ride.id,

            phone:
              ride.phone ||
              customerSession?.customer?.phone ||
              ""
          };

          localStorage.setItem(
            "meiVelocityCustomerBooking",
            JSON.stringify(
              currentCustomerBooking
            )
          );

          window.location.assign(
            `index.html?view=ride&bookingId=${encodeURIComponent(
              ride.id
            )}`
          );
        }
      );

      card.appendChild(
        view
      );
    }

    list.appendChild(
      card
    );
  });

  const clear =
    document.createElement(
      "button"
    );

  clear.className =
    "history-clear";

  clear.textContent =
    "Clear saved history on this device";

  clear.addEventListener(
    "click",
    () => {
      localStorage.removeItem(
        "meiVelocityRideHistory"
      );

      renderRideHistory(
        []
      );
    }
  );

  list.appendChild(
    clear
  );
}


async function loadAccountRideHistory() {
  try {
    const response =
      await fetch(
        `${API_BASE}/api/customer/bookings`,
        {
          headers: {
            Authorization:
              `Bearer ${customerSession.token}`
          }
        }
      );

    const data =
      await response.json();

    if (response.ok) {
      let local = [];

      try {
        local =
          JSON.parse(
            localStorage.getItem(
              "meiVelocityRideHistory"
            ) || "[]"
          );

      } catch {}

      const rides =
        new Map(
          local.map(
            ride => [
              ride.id,
              ride
            ]
          )
        );

      data.bookings.forEach(
        ride =>
          rides.set(
            ride.id,
            {
              ...rides.get(
                ride.id
              ),
              ...ride
            }
          )
      );

      renderRideHistory(
        [
          ...rides.values()
        ].sort(
          (a, b) =>
            String(
              b.createdAt ||
                b.date
            ).localeCompare(
              String(
                a.createdAt ||
                  a.date
              )
            )
        )
      );
    }

  } catch (error) {
    console.warn(
      "Account ride history is unavailable.",
      error
    );
  }
}

/* =========================================================
   ACCOUNT AUTH
========================================================= */

const accountDialog =
  document.getElementById(
    "accountDialog"
  );


function passwordAuthMissingMessage(
  action = "Password sign-in"
) {
  return `${action} is ready in the website, but the password-authentication route still needs to be added to the MEI Velocity backend. You can use SMS verification for now.`;
}


async function readPasswordAuthResponse(
  response,
  fallback,
  action
) {
  if (
    response.status ===
    404
  ) {
    throw new Error(
      passwordAuthMissingMessage(
        action
      )
    );
  }

  return readApiResponse(
    response,
    fallback
  );
}


function storeCustomerSession(
  data
) {
  customerSession = {
    token:
      data.token,

    customer:
      data.customer
  };

  localStorage.setItem(
    "meiVelocityCustomerSession",
    JSON.stringify(
      customerSession
    )
  );

  const accountButton =
    document.getElementById(
      "accountButton"
    );

  if (
    accountButton &&
    data.customer?.username
  ) {
    accountButton.textContent =
      data.customer.username
        .slice(
          0,
          2
        )
        .toUpperCase();
  }
}


function setAccountMode(
  mode = "signin"
) {
  const panels = {
    signin:
      document.getElementById(
        "accountSignInPanel"
      ),

    create:
      document.getElementById(
        "accountCreatePanel"
      ),

    sms:
      document.getElementById(
        "accountSmsPanel"
      ),

    forgot:
      document.getElementById(
        "accountForgotPanel"
      )
  };

  Object.entries(
    panels
  ).forEach(
    ([name, panel]) => {
      if (panel) {
        panel.hidden =
          name !== mode;
      }
    }
  );

  document.getElementById(
    "accountSignInTab"
  )?.classList.toggle(
    "active",
    mode === "signin"
  );

  document.getElementById(
    "accountCreateTab"
  )?.classList.toggle(
    "active",
    mode === "create"
  );

  const message =
    document.getElementById(
      "accountMessage"
    );

  if (message) {
    message.textContent =
      "";
  }
}


function showAccountProfile() {
  document.getElementById(
    "accountGuestView"
  ).hidden =
    true;

  document.getElementById(
    "accountProfileView"
  ).hidden =
    false;

  document.getElementById(
    "profileUsername"
  ).textContent =
    customerSession?.customer?.username ||
    "Your account";

  document.getElementById(
    "profilePhone"
  ).textContent =
    customerSession?.customer?.phone ||
    "";

  document.getElementById(
    "rideNotifications"
  ).checked =
    localStorage.getItem(
      "meiVelocityRideNotifications"
    ) === "true";
}


function showAccountGuest(
  mode = "signin"
) {
  document.getElementById(
    "accountGuestView"
  ).hidden =
    false;

  document.getElementById(
    "accountProfileView"
  ).hidden =
    true;

  setAccountMode(
    mode
  );
}


function openAccountAuth(
  mode = "signin"
) {
  showAccountGuest(
    mode
  );

  if (
    !accountDialog.open
  ) {
    accountDialog.showModal();
  }
}


function finishAccountSignIn(
  data,
  messageText =
    "Signed in successfully."
) {
  storeCustomerSession(
    data
  );

  const message =
    document.getElementById(
      "accountMessage"
    );

  if (message) {
    message.textContent =
      messageText;
  }

  loadAccountRideHistory();

  setTimeout(
    () => {
      if (
        accountDialog.open
      ) {
        accountDialog.close();
      }

      if (
        pendingBookingAfterAuth
      ) {
        pendingBookingAfterAuth =
          false;

        document.getElementById(
          "bookBtn"
        )?.click();
      }
    },
    450
  );
}


accountDialog?.addEventListener(
  "close",
  () => {
    const message =
      document.getElementById(
        "accountMessage"
      );

    if (message) {
      message.textContent =
        "";
    }
  }
);


/* =========================================================
   PASSWORD VISIBILITY
========================================================= */

document
  .querySelectorAll(
    "[data-password-toggle]"
  )
  .forEach(button => {
    button.addEventListener(
      "click",
      () => {
        const input =
          document.getElementById(
            button.dataset.passwordToggle
          );

        if (!input) {
          return;
        }

        input.type =
          input.type ===
          "password"
            ? "text"
            : "password";

        button.setAttribute(
          "aria-label",
          input.type ===
          "password"
            ? "Show password"
            : "Hide password"
        );
      }
    );
  });


/* =========================================================
   OPEN ACCOUNT
========================================================= */

document
  .getElementById(
    "accountButton"
  )
  .addEventListener(
    "click",
    () => {
      if (
        customerSession?.token
      ) {
        showAccountProfile();

      } else {
        showAccountGuest(
          "signin"
        );
      }

      accountDialog.showModal();
    }
  );


document
  .getElementById(
    "accountSignInTab"
  )
  .addEventListener(
    "click",
    () =>
      setAccountMode(
        "signin"
      )
  );


document
  .getElementById(
    "accountCreateTab"
  )
  .addEventListener(
    "click",
    () =>
      setAccountMode(
        "create"
      )
  );


document
  .getElementById(
    "openSmsLogin"
  )
  .addEventListener(
    "click",
    () => {
      document.getElementById(
        "smsPhone"
      ).value =
        document.getElementById(
          "loginPhone"
        ).value.trim();

      setAccountMode(
        "sms"
      );
    }
  );


document
  .getElementById(
    "createUseSms"
  )
  .addEventListener(
    "click",
    () => {
      document.getElementById(
        "smsUsername"
      ).value =
        document.getElementById(
          "accountUsername"
        ).value.trim();

      document.getElementById(
        "smsPhone"
      ).value =
        document.getElementById(
          "accountPhone"
        ).value.trim();

      setAccountMode(
        "sms"
      );
    }
  );


document
  .getElementById(
    "backToPasswordSignIn"
  )
  .addEventListener(
    "click",
    () =>
      setAccountMode(
        "signin"
      )
  );


document
  .getElementById(
    "forgotPasswordButton"
  )
  .addEventListener(
    "click",
    () => {
      document.getElementById(
        "forgotPhone"
      ).value =
        document.getElementById(
          "loginPhone"
        ).value.trim();

      setAccountMode(
        "forgot"
      );
    }
  );


document
  .getElementById(
    "forgotBackToSignIn"
  )
  .addEventListener(
    "click",
    () =>
      setAccountMode(
        "signin"
      )
  );


/* =========================================================
   PHONE + PASSWORD LOGIN
========================================================= */

document
  .getElementById(
    "passwordLoginButton"
  )
  .addEventListener(
    "click",
    async () => {
      const phone =
        document.getElementById(
          "loginPhone"
        ).value.trim();

      const password =
        document.getElementById(
          "loginPassword"
        ).value;

      const message =
        document.getElementById(
          "accountMessage"
        );

      if (
        !phone ||
        !password
      ) {
        message.textContent =
          "Enter your phone number and password.";

        return;
      }

      message.textContent =
        "Signing in…";

      try {
        const response =
          await fetch(
            `${API_BASE}/api/customer/login`,
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  phone,
                  password
                })
            }
          );

        const data =
          await readPasswordAuthResponse(
            response,
            "Could not sign in.",
            "Phone + password sign-in"
          );

        finishAccountSignIn(
          data
        );

      } catch (error) {
        message.textContent =
          apiErrorMessage(
            error
          );
      }
    }
  );


/* =========================================================
   CREATE ACCOUNT
========================================================= */

document
  .getElementById(
    "createAccountButton"
  )
  .addEventListener(
    "click",
    async () => {
      const username =
        document.getElementById(
          "accountUsername"
        ).value.trim();

      const phone =
        document.getElementById(
          "accountPhone"
        ).value.trim();

      const password =
        document.getElementById(
          "accountPassword"
        ).value;

      const confirmPassword =
        document.getElementById(
          "accountPasswordConfirm"
        ).value;

      const message =
        document.getElementById(
          "accountMessage"
        );

      if (
        !username ||
        !phone ||
        !password
      ) {
        message.textContent =
          "Enter your name, phone number and password.";

        return;
      }

      if (
        password.length < 8
      ) {
        message.textContent =
          "Use a password with at least 8 characters.";

        return;
      }

      if (
        password !==
        confirmPassword
      ) {
        message.textContent =
          "The passwords do not match.";

        return;
      }

      message.textContent =
        "Creating your account…";

      try {
        const response =
          await fetch(
            `${API_BASE}/api/customer/register`,
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  username,
                  phone,
                  password
                })
            }
          );

        const data =
          await readPasswordAuthResponse(
            response,
            "Could not create the account.",
            "Password account creation"
          );

        if (
          data.token &&
          data.customer
        ) {
          finishAccountSignIn(
            data,
            "Account created successfully."
          );

          return;
        }

        document.getElementById(
          "smsUsername"
        ).value =
          username;

        document.getElementById(
          "smsPhone"
        ).value =
          phone;

        setAccountMode(
          "sms"
        );

        message.textContent =
          data.message ||
          "Enter the SMS verification code sent to your phone.";

      } catch (error) {
        message.textContent =
          apiErrorMessage(
            error
          );
      }
    }
  );


/* =========================================================
   EXISTING SMS LOGIN
========================================================= */

document
  .getElementById(
    "sendCode"
  )
  .addEventListener(
    "click",
    async () => {
      const username =
        document.getElementById(
          "smsUsername"
        ).value.trim();

      const phone =
        document.getElementById(
          "smsPhone"
        ).value.trim();

      const message =
        document.getElementById(
          "accountMessage"
        );

      if (
        !username ||
        !phone
      ) {
        message.textContent =
          "Enter your name and phone number.";

        return;
      }

      message.textContent =
        "Sending verification code…";

      try {
        const response =
          await fetch(
            `${API_BASE}/api/customer/request-code`,
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  username,
                  phone
                })
            }
          );

        const data =
          await readApiResponse(
            response,
            "Could not send code."
          );

        document.getElementById(
          "codeField"
        ).hidden =
          false;

        document.getElementById(
          "verifyCode"
        ).hidden =
          false;

        message.textContent =
          data.message;

      } catch (error) {
        message.textContent =
          apiErrorMessage(
            error
          );
      }
    }
  );


document
  .getElementById(
    "verifyCode"
  )
  .addEventListener(
    "click",
    async () => {
      const message =
        document.getElementById(
          "accountMessage"
        );

      const phone =
        document.getElementById(
          "smsPhone"
        ).value.trim();

      const code =
        document.getElementById(
          "accountCode"
        ).value.trim();

      if (
        !phone ||
        !code
      ) {
        message.textContent =
          "Enter the verification code.";

        return;
      }

      message.textContent =
        "Verifying…";

      try {
        const response =
          await fetch(
            `${API_BASE}/api/customer/verify-code`,
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  phone,
                  code
                })
            }
          );

        const data =
          await readApiResponse(
            response,
            "Could not verify code."
          );

        finishAccountSignIn(
          data,
          "Phone verified. Your account is ready."
        );

      } catch (error) {
        message.textContent =
          apiErrorMessage(
            error
          );
      }
    }
  );


  /* =========================================================
   FORGOT PASSWORD
========================================================= */

document
  .getElementById(
    "requestPasswordReset"
  )
  .addEventListener(
    "click",
    async () => {
      const phone =
        document.getElementById(
          "forgotPhone"
        ).value.trim();

      const message =
        document.getElementById(
          "accountMessage"
        );

      if (!phone) {
        message.textContent =
          "Enter your phone number.";

        return;
      }

      message.textContent =
        "Sending reset code…";

      try {
        const response =
          await fetch(
            `${API_BASE}/api/customer/password/request-reset`,
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  phone
                })
            }
          );

        const data =
          await readPasswordAuthResponse(
            response,
            "Could not send a reset code.",
            "Password reset"
          );

        document.getElementById(
          "resetPasswordFields"
        ).hidden =
          false;

        message.textContent =
          data.message ||
          "Enter the code sent to your phone and choose a new password.";

      } catch (error) {
        message.textContent =
          apiErrorMessage(
            error
          );
      }
    }
  );


document
  .getElementById(
    "resetPasswordButton"
  )
  .addEventListener(
    "click",
    async () => {
      const phone =
        document.getElementById(
          "forgotPhone"
        ).value.trim();

      const code =
        document.getElementById(
          "resetCode"
        ).value.trim();

      const password =
        document.getElementById(
          "newPassword"
        ).value;

      const confirmPassword =
        document.getElementById(
          "newPasswordConfirm"
        ).value;

      const message =
        document.getElementById(
          "accountMessage"
        );

      if (
        !code ||
        !password
      ) {
        message.textContent =
          "Enter the code and your new password.";

        return;
      }

      if (
        password.length < 8
      ) {
        message.textContent =
          "Use a password with at least 8 characters.";

        return;
      }

      if (
        password !==
        confirmPassword
      ) {
        message.textContent =
          "The passwords do not match.";

        return;
      }

      message.textContent =
        "Updating your password…";

      try {
        const response =
          await fetch(
            `${API_BASE}/api/customer/password/reset`,
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  phone,
                  code,
                  password
                })
            }
          );

        const data =
          await readPasswordAuthResponse(
            response,
            "Could not reset the password.",
            "Password reset"
          );

        document.getElementById(
          "loginPhone"
        ).value =
          phone;

        setAccountMode(
          "signin"
        );

        message.textContent =
          data.message ||
          "Password updated. You can sign in now.";

      } catch (error) {
        message.textContent =
          apiErrorMessage(
            error
          );
      }
    }
  );


/* =========================================================
   SIGN OUT
========================================================= */

document
  .getElementById(
    "signOutButton"
  )
  .addEventListener(
    "click",
    () => {
      customerSession =
        null;

      localStorage.removeItem(
        "meiVelocityCustomerSession"
      );

      document.getElementById(
        "accountButton"
      ).textContent =
        "◉";

      showAccountGuest(
        "signin"
      );

      accountDialog.close();
    }
  );


/* =========================================================
   NOTIFICATIONS
========================================================= */

document
  .getElementById(
    "rideNotifications"
  )
  .addEventListener(
    "change",
    async event => {
      const profileMessage =
        document.getElementById(
          "profileMessage"
        );

      if (
        !event.currentTarget.checked
      ) {
        localStorage.setItem(
          "meiVelocityRideNotifications",
          "false"
        );

        if (
          profileMessage
        ) {
          profileMessage.textContent =
            "Ride notifications are off.";
        }

        return;
      }

      if (
        !(
          "Notification" in
          window
        )
      ) {
        event.currentTarget.checked =
          false;

        if (
          profileMessage
        ) {
          profileMessage.textContent =
            "This browser does not support ride notifications.";
        }

        return;
      }

      const permission =
        Notification.permission ===
        "default"
          ? await Notification.requestPermission()
          : Notification.permission;

      const enabled =
        permission ===
        "granted";

      event.currentTarget.checked =
        enabled;

      localStorage.setItem(
        "meiVelocityRideNotifications",
        String(enabled)
      );

      if (
        profileMessage
      ) {
        profileMessage.textContent =
          enabled
            ? "Ride status notifications are on."
            : "Allow notifications in your browser settings to receive ride updates.";
      }
    }
  );


document
  .getElementById(
    "pickup"
  )
  .addEventListener(
    "input",
    () => {
      window.rideFare =
        null;
    }
  );


document
  .getElementById(
    "dropoff"
  )
  .addEventListener(
    "input",
    () => {
      window.rideFare =
        null;
    }
  );


if (
  !new URLSearchParams(
    window.location.search
  ).has("view")
) {
  restoreCustomerBooking();
  renderRecentLocations();
}


/* =========================================================
   CONFIRM / LIVE RIDE WORKFLOW
========================================================= */

(function setupRideWorkflow() {

  const view =
    new URLSearchParams(
      window.location.search
    ).get("view");

  if (
    view !== "confirm" &&
    view !== "ride"
  ) {
    return;
  }

  try {
    customerSession =
      JSON.parse(
        localStorage.getItem(
          "meiVelocityCustomerSession"
        ) || "null"
      );

  } catch {
    customerSession =
      null;
  }

  const money =
    value =>
      `$${Number(
        value || 0
      ).toFixed(2)}`;

  const text =
    (id, value) => {
      const node =
        document.getElementById(
          id
        );

      if (node) {
        node.textContent =
          value || "—";
      }
    };


  /* =======================================================
     CONFIRM PAGE
  ======================================================= */

  if (
    view === "confirm"
  ) {
    const page =
      document.getElementById(
        "confirmPage"
      );

    page.hidden =
      false;

    let draft;

    try {
      draft =
        JSON.parse(
          localStorage.getItem(
            "meiVelocityBookingDraft"
          ) || "null"
        );

    } catch {
      draft =
        null;
    }

    if (
      !draft?.pickup ||
      !draft?.dropoff ||
      !draft?.vehicle
    ) {
      text(
        "confirmMessage",
        "Your ride details are missing. Please choose a route again."
      );

      document.getElementById(
        "confirmRequest"
      ).disabled =
        true;

      return;
    }

    text(
      "confirmPickup",
      draft.pickup
    );

    text(
      "confirmDropoff",
      draft.dropoff
    );

    text(
      "confirmVehicle",
      draft.vehicle
    );

    text(
      "confirmDistance",
      `${Number(
        draft.distance
      ).toFixed(1)} km`
    );

    text(
      "confirmSchedule",
      `${draft.date} · ${draft.time}`
    );

    text(
      "confirmSuggestedFare",
      money(
        draft.fare
      )
    );

    document.getElementById(
      "confirmFare"
    ).value =
      Number(
        draft.fare
      ).toFixed(2);

    document.getElementById(
      "confirmPromo"
    ).hidden =
      !draft.promoCode;

    const dialog =
      document.getElementById(
        "confirmAccountDialog"
      );

    let queuedRequest =
      false;


    function accountLabel() {
      const label =
        document.getElementById(
          "confirmAccountLabel"
        );

      const button =
        document.getElementById(
          "confirmAccountButton"
        );

      if (
        customerSession?.token &&
        customerSession.customer
      ) {
        label.textContent =
          `Signed in as ${customerSession.customer.username}`;

        button.textContent =
          "Sign out";

      } else {
        label.textContent =
          "Sign in or create an account before requesting";

        button.textContent =
          "Sign in";
      }
    }


    function setConfirmAuthMode(
      mode = "signin"
    ) {
      document.getElementById(
        "confirmSignInPanel"
      ).hidden =
        mode !== "signin";

      document.getElementById(
        "confirmCreatePanel"
      ).hidden =
        mode !== "create";

      document.getElementById(
        "confirmSmsPanel"
      ).hidden =
        mode !== "sms";

      document.getElementById(
        "confirmSignInTab"
      ).classList.toggle(
        "active",
        mode === "signin"
      );

      document.getElementById(
        "confirmCreateTab"
      ).classList.toggle(
        "active",
        mode === "create"
      );

      document.getElementById(
        "confirmAuthMessage"
      ).textContent =
        "";
    }


    function finishConfirmAuth(
      data,
      messageText =
        "Signed in successfully."
    ) {
      storeCustomerSession(
        data
      );

      accountLabel();

      document.getElementById(
        "confirmAuthMessage"
      ).textContent =
        messageText;

      setTimeout(
        () => {
          dialog.close();

          if (
            queuedRequest
          ) {
            submitRide();
          }
        },
        350
      );
    }


    accountLabel();


    document
      .getElementById(
        "confirmSignInTab"
      )
      .addEventListener(
        "click",
        () =>
          setConfirmAuthMode(
            "signin"
          )
      );


    document
      .getElementById(
        "confirmCreateTab"
      )
      .addEventListener(
        "click",
        () =>
          setConfirmAuthMode(
            "create"
          )
      );


    document
      .getElementById(
        "confirmOpenSms"
      )
      .addEventListener(
        "click",
        () => {
          document.getElementById(
            "confirmSmsPhone"
          ).value =
            document.getElementById(
              "confirmLoginPhone"
            ).value.trim();

          setConfirmAuthMode(
            "sms"
          );
        }
      );


    document
      .getElementById(
        "confirmBackToSignIn"
      )
      .addEventListener(
        "click",
        () =>
          setConfirmAuthMode(
            "signin"
          )
      );


    document
      .getElementById(
        "confirmForgotPassword"
      )
      .addEventListener(
        "click",
        () => {
          const phone =
            document.getElementById(
              "confirmLoginPhone"
            ).value.trim();

          dialog.close();

          document.getElementById(
            "forgotPhone"
          ).value =
            phone;

          openAccountAuth(
            "forgot"
          );
        }
      );


    document
      .getElementById(
        "confirmAccountButton"
      )
      .addEventListener(
        "click",
        () => {
          if (
            customerSession?.token
          ) {
            customerSession =
              null;

            localStorage.removeItem(
              "meiVelocityCustomerSession"
            );

            accountLabel();

          } else {
            setConfirmAuthMode(
              "signin"
            );

            dialog.showModal();
          }
        }
      );


    /* PASSWORD LOGIN ON CONFIRM PAGE */

    document
      .getElementById(
        "confirmPasswordLogin"
      )
      .addEventListener(
        "click",
        async () => {
          const phone =
            document.getElementById(
              "confirmLoginPhone"
            ).value.trim();

          const password =
            document.getElementById(
              "confirmLoginPassword"
            ).value;

          const message =
            document.getElementById(
              "confirmAuthMessage"
            );

          if (
            !phone ||
            !password
          ) {
            message.textContent =
              "Enter your phone number and password.";

            return;
          }

          message.textContent =
            "Signing in…";

          try {
            const response =
              await fetch(
                `${API_BASE}/api/customer/login`,
                {
                  method:
                    "POST",

                  headers: {
                    "Content-Type":
                      "application/json"
                  },

                  body:
                    JSON.stringify({
                      phone,
                      password
                    })
                }
              );

            const data =
              await readPasswordAuthResponse(
                response,
                "Could not sign in.",
                "Phone + password sign-in"
              );

            finishConfirmAuth(
              data
            );

          } catch (error) {
            message.textContent =
              apiErrorMessage(
                error
              );
          }
        }
      );


    /* CREATE ACCOUNT ON CONFIRM PAGE */

    document
      .getElementById(
        "confirmCreateAccount"
      )
      .addEventListener(
        "click",
        async () => {
          const username =
            document.getElementById(
              "confirmUsername"
            ).value.trim();

          const phone =
            document.getElementById(
              "confirmPhone"
            ).value.trim();

          const password =
            document.getElementById(
              "confirmPassword"
            ).value;

          const passwordAgain =
            document.getElementById(
              "confirmPasswordAgain"
            ).value;

          const message =
            document.getElementById(
              "confirmAuthMessage"
            );

          if (
            !username ||
            !phone ||
            !password
          ) {
            message.textContent =
              "Enter your name, phone number and password.";

            return;
          }

          if (
            password.length < 8
          ) {
            message.textContent =
              "Use a password with at least 8 characters.";

            return;
          }

          if (
            password !==
            passwordAgain
          ) {
            message.textContent =
              "The passwords do not match.";

            return;
          }

          message.textContent =
            "Creating your account…";

          try {
            const response =
              await fetch(
                `${API_BASE}/api/customer/register`,
                {
                  method:
                    "POST",

                  headers: {
                    "Content-Type":
                      "application/json"
                  },

                  body:
                    JSON.stringify({
                      username,
                      phone,
                      password
                    })
                }
              );

            const data =
              await readPasswordAuthResponse(
                response,
                "Could not create the account.",
                "Password account creation"
              );

            if (
              data.token &&
              data.customer
            ) {
              finishConfirmAuth(
                data,
                "Account created successfully."
              );

              return;
            }

            document.getElementById(
              "confirmSmsUsername"
            ).value =
              username;

            document.getElementById(
              "confirmSmsPhone"
            ).value =
              phone;

            setConfirmAuthMode(
              "sms"
            );

            message.textContent =
              data.message ||
              "Enter the SMS verification code sent to your phone.";

          } catch (error) {
            message.textContent =
              apiErrorMessage(
                error
              );
          }
        }
      );


    /* SMS CODE ON CONFIRM PAGE */

    document
      .getElementById(
        "confirmSendCode"
      )
      .addEventListener(
        "click",
        async () => {
          const username =
            document.getElementById(
              "confirmSmsUsername"
            ).value.trim();

          const phone =
            document.getElementById(
              "confirmSmsPhone"
            ).value.trim();

          const message =
            document.getElementById(
              "confirmAuthMessage"
            );

          if (
            !username ||
            !phone
          ) {
            message.textContent =
              "Enter your name and phone number.";

            return;
          }

          message.textContent =
            "Sending verification code…";

          try {
            const response =
              await fetch(
                `${API_BASE}/api/customer/request-code`,
                {
                  method:
                    "POST",

                  headers: {
                    "Content-Type":
                      "application/json"
                  },

                  body:
                    JSON.stringify({
                      username,
                      phone
                    })
                }
              );

            const data =
              await readApiResponse(
                response,
                "Could not send code."
              );

            document.getElementById(
              "confirmCodeRow"
            ).hidden =
              false;

            document.getElementById(
              "confirmVerify"
            ).hidden =
              false;

            message.textContent =
              data.message;

          } catch (error) {
            message.textContent =
              apiErrorMessage(
                error
              );
          }
        }
      );


    document
      .getElementById(
        "confirmVerify"
      )
      .addEventListener(
        "click",
        async () => {
          const message =
            document.getElementById(
              "confirmAuthMessage"
            );

          const phone =
            document.getElementById(
              "confirmSmsPhone"
            ).value.trim();

          const code =
            document.getElementById(
              "confirmCode"
            ).value.trim();

          if (
            !phone ||
            !code
          ) {
            message.textContent =
              "Enter the verification code.";

            return;
          }

          message.textContent =
            "Verifying…";

          try {
            const response =
              await fetch(
                `${API_BASE}/api/customer/verify-code`,
                {
                  method:
                    "POST",

                  headers: {
                    "Content-Type":
                      "application/json"
                  },

                  body:
                    JSON.stringify({
                      phone,
                      code
                    })
                }
              );

            const data =
              await readApiResponse(
                response,
                "Could not verify code."
              );

            finishConfirmAuth(
              data,
              "Phone verified. Your account is ready."
            );

          } catch (error) {
            message.textContent =
              apiErrorMessage(
                error
              );
          }
        }
      );


    /* REQUEST RIDE */

    document
      .getElementById(
        "confirmRequest"
      )
      .addEventListener(
        "click",
        () => {
          if (
            !customerSession?.token
          ) {
            queuedRequest =
              true;

            dialog.showModal();

            document.getElementById(
              "confirmAuthMessage"
            ).textContent =
              "Sign in or create an account to continue.";

            return;
          }

          submitRide();
        }
      );


    async function submitRide() {
      const button =
        document.getElementById(
          "confirmRequest"
        );

      const message =
        document.getElementById(
          "confirmMessage"
        );

      const fare =
        Number(
          document.getElementById(
            "confirmFare"
          ).value
        );

      if (
        !Number.isFinite(fare) ||
        fare < 0
      ) {
        message.textContent =
          "Enter a valid fare offer.";

        return;
      }

      button.disabled =
        true;

      button.textContent =
        "Requesting your ride…";

      message.textContent =
        "Sending your request to available drivers…";

      try {
        const response =
          await fetch(
            `${API_BASE}/api/bookings`,
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json",

                Authorization:
                  `Bearer ${customerSession.token}`
              },

              body:
                JSON.stringify({
                  name:
                    customerSession.customer.username,

                  phone:
                    customerSession.customer.phone,

                  pickup:
                    draft.pickup,

                  dropoff:
                    draft.dropoff,

                  date:
                    draft.date,

                  time:
                    draft.time,

                  vehicle:
                    draft.vehicle,

                  distance:
                    draft.distance,

                  fare:
                    Math.round(
                      fare * 100
                    ) / 100,

                  baseFare:
                    draft.baseFare,

                  payment:
                    draft.payment ||
                    "Cash",

                  promoCode:
                    draft.promoCode ||
                    ""
                })
            }
          );

        const data =
          await response.json();

        if (!response.ok) {
          throw new Error(
            data.message ||
              "Ride request failed."
          );
        }

        const booking =
          data.booking;

        const phone =
          booking.phone ||
          customerSession.customer.phone;

        const localBooking = {
          id: booking.id,
          phone,
          pickup: booking.pickup || draft.pickup,
          dropoff: booking.dropoff || draft.dropoff,
          pickupLat: booking.pickupLat != null && Number.isFinite(Number(booking.pickupLat))
            ? Number(booking.pickupLat)
            : draft.pickupLat,
          pickupLng: booking.pickupLng != null && Number.isFinite(Number(booking.pickupLng))
            ? Number(booking.pickupLng)
            : draft.pickupLng,
          dropoffLat: booking.dropoffLat != null && Number.isFinite(Number(booking.dropoffLat))
            ? Number(booking.dropoffLat)
            : draft.dropoffLat,
          dropoffLng: booking.dropoffLng != null && Number.isFinite(Number(booking.dropoffLng))
            ? Number(booking.dropoffLng)
            : draft.dropoffLng,
          pickupSource: booking.pickupSource || draft.pickupSource || "manual",
          date: booking.date || draft.date,
          time: booking.time || draft.time,
          vehicle: booking.vehicle || draft.vehicle,
          fare: booking.fare ?? fare,
          distance: booking.distance ?? draft.distance,
          status: booking.status || "Pending"
        };

        localStorage.setItem(
          "meiVelocityCustomerBooking",
          JSON.stringify(localBooking)
        );

        localStorage.removeItem(
          "meiVelocityBookingDraft"
        );

        const rides =
          JSON.parse(
            localStorage.getItem(
              "meiVelocityRideHistory"
            ) || "[]"
          );

        rides.unshift({
          id:
            booking.id,

          phone,

          pickup:
            booking.pickup,

          dropoff:
            booking.dropoff,

          date:
            booking.date,

          time:
            booking.time,

          vehicle:
            booking.vehicle,

          fare:
            booking.fare,

          distance:
            booking.distance ?? draft.distance,

          pickupLat:
            localBooking.pickupLat,

          pickupLng:
            localBooking.pickupLng,

          dropoffLat:
            localBooking.dropoffLat,

          dropoffLng:
            localBooking.dropoffLng,

          pickupSource:
            localBooking.pickupSource,

          status:
            booking.status ||
            "Pending",

          createdAt:
            new Date().toISOString()
        });

        localStorage.setItem(
          "meiVelocityRideHistory",
          JSON.stringify(
            rides.slice(
              0,
              50
            )
          )
        );

        window.location.assign(
          `index.html?view=ride&bookingId=${encodeURIComponent(
            booking.id
          )}`
        );

      } catch (error) {
        message.textContent =
          apiErrorMessage(
            error
          );

        button.disabled =
          false;

        button.textContent =
          "Request this ride";
      }
    }

    return;
  }


  /* =======================================================
     LIVE RIDE PAGE
  ======================================================= */

  const page =
    document.getElementById(
      "ridePage"
    );

  page.hidden =
    false;

  let activeRide =
    null;

  let pollTimer =
    null;

  let map =
    null;

  let pickupMarker =
    null;

  let riderMarker =
    null;

  let riderWatchId =
    null;

  let dropMarker =
    null;

  let driverMarker =
    null;

  let routeLine =
    null;

  let approachLine =
    null;

  let lastState =
    "";


  const queryId =
    new URLSearchParams(
      window.location.search
    ).get(
      "bookingId"
    );


  try {
    activeRide =
      JSON.parse(
        localStorage.getItem(
          "meiVelocityCustomerBooking"
        ) || "null"
      );

  } catch {
    activeRide =
      null;
  }


  if (
    queryId &&
    (
      activeRide?.id !== queryId ||
      !activeRide?.pickup ||
      !activeRide?.dropoff
    )
  ) {
    let history = [];

    try {
      history =
        JSON.parse(
          localStorage.getItem(
            "meiVelocityRideHistory"
          ) || "[]"
        );

    } catch {}

    const ride =
      history.find(
        item =>
          item.id ===
          queryId
      );

    activeRide =
      ride
        ? {
            id:
              queryId,

            phone:
              ride.phone ||
              customerSession?.customer?.phone ||
              "",

            ...ride
          }

        : {
            id:
              queryId,

            phone:
              customerSession?.customer?.phone ||
              ""
          };
  }


  if (
    !activeRide?.id ||
    !activeRide.phone
  ) {
    text(
      "rideTitle",
      "Ride details unavailable"
    );

    text(
      "rideMessage",
      "Go back to your account’s ride history and open a saved ride."
    );

    return;
  }


  text(
    "ridePickup",
    activeRide.pickup
  );

  text(
    "rideDropoff",
    activeRide.dropoff
  );


  function initMap() {
    if (!window.L) {
      text(
        "trackingError",
        "The map library could not load."
      );

      return;
    }

    map =
      L.map(
        "rideMap",
        {
          zoomControl:
            false
        }
      ).setView(
        [-17.8252, 31.0335],
        12
      );

    L.tileLayer(
      window.MEI_MAP_TILE_URL ||
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom:
          19,

        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
      }
    ).addTo(map);

    setTimeout(
      () =>
        map?.invalidateSize(),
      120
    );

    loadRoute();
  }


  async function geocode(
    place
  ) {
    const q =
      place
        .toLowerCase()
        .includes(
          "harare"
        )
        ? place
        : `${place}, Harare, Zimbabwe`;

    const r =
      await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
          q
        )}`
      );

    const d =
      await r.json();

    if (!d.length) {
      throw new Error(
        "Location not found"
      );
    }

    return [
      Number(
        d[0].lat
      ),

      Number(
        d[0].lon
      )
    ];
  }


  async function loadRoute() {
    try {
      const hasSavedPickup =
        activeRide.pickupLat != null &&
        activeRide.pickupLng != null &&
        activeRide.pickupLat !== "" &&
        activeRide.pickupLng !== "";

      const hasSavedDropoff =
        activeRide.dropoffLat != null &&
        activeRide.dropoffLng != null &&
        activeRide.dropoffLat !== "" &&
        activeRide.dropoffLng !== "";

      const savedPickupLat = Number(activeRide.pickupLat);
      const savedPickupLng = Number(activeRide.pickupLng);
      const savedDropoffLat = Number(activeRide.dropoffLat);
      const savedDropoffLng = Number(activeRide.dropoffLng);

      const a =
        hasSavedPickup &&
        Number.isFinite(savedPickupLat) &&
        Number.isFinite(savedPickupLng)
          ? [savedPickupLat, savedPickupLng]
          : await geocode(activeRide.pickup);

      const b =
        hasSavedDropoff &&
        Number.isFinite(savedDropoffLat) &&
        Number.isFinite(savedDropoffLng)
          ? [savedDropoffLat, savedDropoffLng]
          : await geocode(activeRide.dropoff);

      riderMarker =
        L.marker(a, {
          icon: riderLocationIcon(),
          zIndexOffset: 1000
        })
          .addTo(map)
          .bindPopup("You / pickup");

      pickupMarker = riderMarker;

      dropMarker =
        L.circleMarker(
          b,
          {
            radius: 9,
            color: "#fff",
            weight: 3,
            fillColor: "#ff7900",
            fillOpacity: 1
          }
        )
          .addTo(map)
          .bindPopup("Destination");

      const r =
        await fetch(
          `https://router.project-osrm.org/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`
        );

      const d =
        await r.json();

      if (d.code === "Ok") {
        const points =
          d.routes[0].geometry.coordinates.map(
            ([lon, lat]) => [lat, lon]
          );

        routeLine =
          L.polyline(points, {
            color: "#ff7900",
            weight: 5,
            opacity: 0.9
          }).addTo(map);

        map.fitBounds(
          routeLine.getBounds(),
          {
            padding: [40, 40],
            maxZoom: 16
          }
        );
      } else {
        map.fitBounds([a, b], {
          padding: [40, 40],
          maxZoom: 16
        });
      }

      if (activeRide.pickupSource === "current") {
        startRiderLocationTracking();
      }

    } catch (error) {
      console.warn("Could not load ride route:", error);
      map?.setView([-17.8252, 31.0335], 12);
    }
  }


  function startRiderLocationTracking() {
    if (!navigator.geolocation || riderWatchId !== null) return;

    riderWatchId = navigator.geolocation.watchPosition(
      position => {
        const point = [
          position.coords.latitude,
          position.coords.longitude
        ];

        if (riderMarker) {
          riderMarker.setLatLng(point);
        }

        activeRide.pickupLat = point[0];
        activeRide.pickupLng = point[1];

        try {
          localStorage.setItem(
            "meiVelocityCustomerBooking",
            JSON.stringify(activeRide)
          );
        } catch {}

        if (approachLine && driverMarker) {
          approachLine.setLatLngs([
            driverMarker.getLatLng(),
            point
          ]);
        }
      },
      error => {
        console.warn("Live rider location unavailable:", error);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 2000,
        timeout: 12000
      }
    );
  }


  function statusInfo(
    booking
  ) {
    if (
      booking.status ===
      "Cancelled"
    ) {
      return {
        title:
          "Ride cancelled",

        message:
          "This ride request has been cancelled.",

        step:
          -1
      };
    }

    if (
      booking.status ===
        "Completed" ||
      booking.driverStatus ===
        "Completed"
    ) {
      return {
        title:
          "Ride completed",

        message:
          "Thanks for riding with MEI Velocity.",

        step:
          4
      };
    }

    switch (
      booking.driverStatus
    ) {
      case "Picked Up":
        return {
          title:
            "Ride in progress",

          message:
            "Your trip has started.",

          step:
            4
        };

      case "Arrived":
        return {
          title:
            "Driver arrived",

          message:
            "Your driver is at the pickup point.",

          step:
            3
        };

      case "On the Way":
        return {
          title:
            "Driver is on the way",

          message:
            "Your driver is coming to your pickup.",

          step:
            2
        };

      case "Accepted":
        return {
          title:
            "Driver accepted",

          message:
            "Your driver is heading to the pickup.",

          step:
            1
        };

      default:
        return {
          title:
            "Finding your driver",

          message:
            "Your request is with MEI Velocity drivers. We’ll update this page as soon as someone accepts.",

          step:
            0
        };
    }
  }


  function renderBooking(
    booking
  ) {
    const info =
      statusInfo(
        booking
      );

    text(
      "rideTitle",
      info.title
    );

    text(
      "rideMessage",
      info.message
    );

    text(
      "rideStatusPill",
      info.title
    );

    document
      .querySelectorAll(
        "#rideProgress span"
      )
      .forEach(
        (bar, index) =>
          bar.classList.toggle(
            "active",
            info.step >=
              index &&
              info.step >=
                0
          )
      );

    const assigned =
      Boolean(
        booking.assignedDriverId
      );

    document.getElementById(
      "driverPanel"
    ).hidden =
      !assigned;

    const messageLink =
      document.getElementById(
        "messageDriverLink"
      );

    const chatAvailable =
      Boolean(
        assigned &&
        (
          (
            booking.status ===
              "Confirmed" &&
            [
              "Accepted",
              "On the Way",
              "Arrived",
              "Picked Up"
            ].includes(
              booking.driverStatus
            )
          ) ||
          (
            booking.status ===
              "Completed" &&
            booking.driverStatus ===
              "Completed"
          )
        )
      );

    messageLink.hidden =
      !chatAvailable;

    messageLink.textContent =
      booking.status ===
      "Completed"
        ? "Continue chat"
        : "Message driver";

    messageLink.href =
      `chat.html?bookingId=${encodeURIComponent(
        booking.id
      )}`;

    if (assigned) {
      text(
        "trackingDriverName",
        booking.driverName ||
          booking.assignedDriverName ||
          "Your MEI Velocity driver"
      );

      text(
        "trackingDriverVehicle",
        booking.driverVehicle ||
          booking.vehicle ||
          "Vehicle"
      );

      text(
        "trackingDriverPlate",
        booking.driverPlate ||
          "Plate pending"
      );
    }

    const lat =
      Number(
        booking.driverLat
      );

    const lng =
      Number(
        booking.driverLng
      );

    if (
      assigned &&
      Number.isFinite(
        lat
      ) &&
      Number.isFinite(
        lng
      ) &&
      map
    ) {
      const point = [
        lat,
        lng
      ];

      if (
        !driverMarker
      ) {
        driverMarker =
          L.marker(
            point,
            {
              icon:
                driverCarIcon()
            }
          )
            .addTo(map)
            .bindPopup(
              "Your driver"
            );

        if (riderMarker) {
          map.fitBounds(
            [
              riderMarker.getLatLng(),
              point
            ],
            {
              padding: [55, 55],
              maxZoom: 16
            }
          );
        } else {
          map.setView(point, 15);
        }

      } else {
        driverMarker.setLatLng(
          point
        );
      }

      if (riderMarker) {
        const visibleBounds =
          map.getBounds().pad(-0.12);

        const pairBounds =
          L.latLngBounds([
            riderMarker.getLatLng(),
            point
          ]);

        if (!visibleBounds.contains(pairBounds)) {
          map.fitBounds(pairBounds, {
            padding: [55, 55],
            maxZoom: 16
          });
        }
      }

      if (
        riderMarker || pickupMarker
      ) {
        const riderPoint =
          (riderMarker || pickupMarker).getLatLng();

        if (
          approachLine
        ) {
          approachLine.setLatLngs(
            [
              point,
              riderPoint
            ]
          );

        } else {
          approachLine =
            L.polyline(
              [
                point,
                riderPoint
              ],
              {
                color:
                  "#ff7900",

                weight:
                  4,

                dashArray:
                  "7 8"
              }
            ).addTo(map);
        }
      }

      text(
        "locationMessage",
        "Live driver location is updating on the map."
      );

    } else if (
      assigned
    ) {
      text(
        "locationMessage",
        "Your driver accepted. Their live location will appear when GPS sharing starts."
      );

    } else {
      text(
        "locationMessage",
        "The driver’s live location appears here when they share it."
      );
    }

    document.getElementById(
      "cancelRide"
    ).hidden =
      !(
        booking.status ===
          "Pending" &&
        !assigned
      );

    const completed =
      booking.status ===
        "Completed" ||
      booking.driverStatus ===
        "Completed";

    const ratingArea =
      document.getElementById(
        "ratingArea"
      );

    ratingArea.hidden =
      !completed;

    if (
      completed
    ) {
      if (
        booking.rating
      ) {
        text(
          "rideRatingFeedback",
          `Thanks for rating this ride ${booking.rating}/5.`
        );

        document.getElementById(
          "rideRatingSelect"
        ).hidden =
          true;

        document.getElementById(
          "rideRatingSubmit"
        ).hidden =
          true;

      } else {
        text(
          "rideRatingFeedback",
          customerSession?.token
            ? "Your feedback helps us improve."
            : "Sign in on the home page to save your rating."
        );
      }
    }

    const state =
      `${booking.status}:${booking.driverStatus}`;

    if (
      lastState &&
      lastState !==
        state &&
      localStorage.getItem(
        "meiVelocityRideNotifications"
      ) === "true" &&
      "Notification" in window &&
      Notification.permission ===
        "granted"
    ) {
      new Notification(
        "MEI Velocity ride update",
        {
          body:
            info.message
        }
      );
    }

    lastState =
      state;
  }


  async function refreshDriverMessageNotice(
    booking
  ) {
    const notice =
      document.getElementById(
        "driverMessageNotice"
      );

    const link =
      document.getElementById(
        "messageDriverLink"
      );

    const available =
      Boolean(
        booking?.assignedDriverId &&
        (
          (
            booking.status ===
              "Confirmed" &&
            [
              "Accepted",
              "On the Way",
              "Arrived",
              "Picked Up"
            ].includes(
              booking.driverStatus
            )
          ) ||
          (
            booking.status ===
              "Completed" &&
            booking.driverStatus ===
              "Completed"
          )
        )
      );

    if (
      !available ||
      !customerSession?.token
    ) {
      notice.hidden =
        true;

      return;
    }

    try {
      const response =
        await fetch(
          `${API_BASE}/api/customer/bookings/${encodeURIComponent(
            booking.id
          )}/messages`,
          {
            headers: {
              Authorization:
                `Bearer ${customerSession.token}`
            }
          }
        );

      if (
        !response.ok
      ) {
        return;
      }

      const data =
        await response.json();

      const latestDriverMessage =
        (
          data.messages ||
          []
        )
          .slice()
          .reverse()
          .find(
            message =>
              message.senderType ===
              "driver"
          );

      if (
        !latestDriverMessage
      ) {
        notice.hidden =
          true;

        return;
      }

      const readId =
        Number(
          localStorage.getItem(
            `meiVelocityChatRead:${booking.id}`
          ) || 0
        );

      if (
        Number(
          latestDriverMessage.id
        ) > readId
      ) {
        notice.hidden =
          false;

        notice.textContent =
          `New message from your driver: ${latestDriverMessage.body}`;

        link.textContent =
          "Open driver message";

      } else {
        notice.hidden =
          true;

        link.textContent =
          booking.status ===
          "Completed"
            ? "Continue chat"
            : "Message driver";
      }

    } catch {
      // Keep ride tracking working if chat is temporarily unavailable.
    }
  }


  async function poll() {
    try {
      const r =
        await fetch(
          `${API_BASE}/api/bookings/${encodeURIComponent(
            activeRide.id
          )}/status?phone=${encodeURIComponent(
            activeRide.phone
          )}`
        );

      const d =
        await r.json();

      if (!r.ok) {
        throw new Error(
          d.message ||
            "Could not refresh the ride."
        );
      }

      activeRide = {
        ...activeRide,
        ...d.booking,
        pickupLat: d.booking.pickupLat ?? activeRide.pickupLat,
        pickupLng: d.booking.pickupLng ?? activeRide.pickupLng,
        dropoffLat: d.booking.dropoffLat ?? activeRide.dropoffLat,
        dropoffLng: d.booking.dropoffLng ?? activeRide.dropoffLng,
        pickupSource: d.booking.pickupSource ?? activeRide.pickupSource
      };

      text("ridePickup", activeRide.pickup || "Pickup");
      text("rideDropoff", activeRide.dropoff || "Destination");

      renderBooking(
        activeRide
      );

      await refreshDriverMessageNotice(
        activeRide
      );

      text(
        "trackingError",
        ""
      );

      const rides =
        JSON.parse(
          localStorage.getItem(
            "meiVelocityRideHistory"
          ) || "[]"
        );

      const saved =
        rides.find(
          x =>
            x.id ===
            activeRide.id
        );

      if (saved) {
        saved.status =
          d.booking.status ||
          saved.status;

        if (
          d.booking.rating
        ) {
          saved.rating =
            d.booking.rating;
        }

        localStorage.setItem(
          "meiVelocityRideHistory",
          JSON.stringify(
            rides
          )
        );
      }

    } catch (error) {
      text(
        "trackingError",
        error.message
      );
    }
  }


  document
    .getElementById(
      "cancelRide"
    )
    .addEventListener(
      "click",
      async event => {
        const button =
          event.currentTarget;

        button.disabled =
          true;

        try {
          const r =
            await fetch(
              `${API_BASE}/api/bookings/${encodeURIComponent(
                activeRide.id
              )}/cancel`,
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json"
                },

                body:
                  JSON.stringify({
                    phone:
                      activeRide.phone
                  })
              }
            );

          const d =
            await r.json();

          if (!r.ok) {
            throw new Error(
              d.message ||
                "Could not cancel this request."
            );
          }

          renderBooking(
            d.booking
          );

        } catch (error) {
          text(
            "trackingError",
            error.message
          );

        } finally {
          button.disabled =
            false;
        }
      }
    );


  document
    .getElementById(
      "rideRatingSubmit"
    )
    .addEventListener(
      "click",
      async () => {
        if (
          !customerSession?.token
        ) {
          text(
            "rideRatingFeedback",
            "Sign in on the home page to save your rating."
          );

          return;
        }

        try {
          const r =
            await fetch(
              `${API_BASE}/api/customer/bookings/${encodeURIComponent(
                activeRide.id
              )}/rating`,
              {
                method:
                  "PATCH",

                headers: {
                  "Content-Type":
                    "application/json",

                  Authorization:
                    `Bearer ${customerSession.token}`
                },

                body:
                  JSON.stringify({
                    rating:
                      Number(
                        document.getElementById(
                          "rideRatingSelect"
                        ).value
                      )
                  })
              }
            );

          const d =
            await r.json();

          if (!r.ok) {
            throw new Error(
              d.message ||
                "Could not save your rating."
            );
          }

          text(
            "rideRatingFeedback",
            `Thanks for rating this ride ${d.rating}/5.`
          );

          document.getElementById(
            "rideRatingSelect"
          ).hidden =
            true;

          document.getElementById(
            "rideRatingSubmit"
          ).hidden =
            true;

        } catch (error) {
          text(
            "rideRatingFeedback",
            error.message
          );
        }
      }
    );


  window.addEventListener("pagehide", () => {
    if (riderWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(riderWatchId);
      riderWatchId = null;
    }
  });

  initMap();
  poll();

  pollTimer =
    setInterval(
      poll,
      4000
    );

})();