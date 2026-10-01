MEI VELOCITY COMPLETE WEBSITE

Files:
- index.html
- styles.css
- app.js
- assets/mei_logo.jpg
- assets/mei_car.jpeg
- assets/services/
- assets/vehicles/

Included:
- Branded Harare taxi homepage
- Hero with MEI Velocity vehicle background
- Ride booking form
- Pickup/drop-off route calculation
- $0.75/km standard fare
- Cash and Card choices
- Our Services with replaceable image spaces
- Our Fleet with enlarged visible MEI Velocity logo
- Replaceable fleet pictures
- Separate Toyota Spade, Nissan Note and Truck for Hire
- Fares, service areas, About Us, benefits and contact sections

Note: Card selection is ready in the interface, but a live payment gateway and backend are required before taking real card payments.


FINAL VISUAL CORRECTION:
- MEI Velocity logo is now displayed fully in Our Fleet without the zoom/cropping problem.
- Toyota Spade, Nissan Note and Truck photos are tightly cropped from the supplied MEI Velocity promotional design.
- Fleet cards and vehicle cards use the corrected vehicle images.
- Service and fleet picture upload/replace controls remain included.

CUSTOMER APP FLOW:
- Interactive OpenStreetMap basemap centered on Harare, with an optional current-location pickup.
- Pickup and destination route preview, vehicle selection, fare offer, Ride Now and Schedule options.
- A verified customer account is required before a ride can be booked. Existing and new customers use the same phone verification flow.
- Customers can cancel a request while it is still waiting for a driver, track an accepted driver on the map, and start another booking after completion or cancellation.
- Recent locations and ride history are saved on the device; verified accounts also sync history to PostgreSQL.
- Customers can rate completed rides from the tracker or account ride history; ratings are stored with the booking in PostgreSQL.
- Signed-in customers can opt into browser notifications for ride status changes.
- WELCOME10 gives a one-time $10 ride credit per phone number.
- Customer signup verifies phone ownership with a six-digit code sent through Twilio.
- Drivers receive new requests while online and pick up waiting requests when they come online or complete another ride. The fare offer is shown to drivers with the request.
- Cash payments are supported. Card payments are marked unavailable until a payment gateway is connected.

To enable phone verification in the backend deployment environment, configure:
- TWILIO_ACCOUNT_SID
- TWILIO_AUTH_TOKEN
- TWILIO_FROM_NUMBER
- CUSTOMER_AUTH_SECRET (a long, random secret used to sign customer sessions)

The customer signup flow reports that verification is unavailable until all four settings are configured.

MAP TILES:
- Home and live driver-location maps use OpenStreetMap raster tiles directly, so CARTO's current API-key-required tile response is avoided.
- OpenStreetMap attribution remains visible on the map. Follow the OpenStreetMap tile usage policy; use a commercial tile provider for traffic volumes or production requirements beyond that policy.
- No map API key is required for the configured development map source.

RUN LOCALLY:
1. In one terminal, open the project root folder and run `python -m http.server 8080`.
2. Open `http://localhost:8080`. Customer sign-in, booking, and ride tracking use the MEI Velocity Render API from the local page.
3. The local backend in `backend` is optional for driver/admin pages. Run `npm start` there only when you want those pages to use the local API at port 5000.
4. Phone verification requires the deployed Render backend to include the customer account routes and have Twilio settings configured. The current Render URL responds with `404 Cannot POST /api/customer/request-code`, so the backend deployment must be updated before account verification and customer ride booking can work. The browser now reports this clearly instead of showing a JSON parsing error. Do not put Twilio credentials in the frontend or this static project.
