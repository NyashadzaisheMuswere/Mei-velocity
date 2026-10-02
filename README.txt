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
- Customer signup verifies phone ownership with a six-digit code. Production uses Twilio Verify; local development can use a terminal-only test code.
- Drivers receive new requests while online and pick up waiting requests when they come online or complete another ride. The fare offer is shown to drivers with the request.
- Cash payments are supported. Card payments are marked unavailable until a payment gateway is connected.

To enable phone verification in the backend deployment environment, configure:
- TWILIO_ACCOUNT_SID
- TWILIO_AUTH_TOKEN
- TWILIO_VERIFY_SERVICE_SID (recommended; create a Verify Service in Twilio)
- CUSTOMER_AUTH_SECRET (a long, random secret used to sign customer sessions)

For paid Programmable Messaging fallback, configure TWILIO_FROM_NUMBER instead of TWILIO_VERIFY_SERVICE_SID.

MAP TILES:
- Home and live driver-location maps use OpenStreetMap raster tiles directly, so CARTO's current API-key-required tile response is avoided.
- OpenStreetMap attribution remains visible on the map. Follow the OpenStreetMap tile usage policy; use a commercial tile provider for traffic volumes or production requirements beyond that policy.
- No map API key is required for the configured development map source.

RUN LOCALLY:
1. In `backend/.env`, configure DATABASE_URL. Set NODE_ENV=development and LOCAL_OTP_MODE=true for local-only testing. Twilio settings and CUSTOMER_AUTH_SECRET are not needed in this mode; the backend creates a temporary local signing key. For production, configure CUSTOMER_AUTH_SECRET and Twilio Verify settings.
2. Open a terminal in the `backend` folder and run `npm start`. Leave it running; the test OTP appears in this terminal after you press Send verification code.
3. In another terminal at the project root, run `python -m http.server 8080` and open `http://localhost:8080`.
4. Local pages automatically use the backend at localhost:5000. The local OTP mode only works when the backend is running on localhost and NODE_ENV is not production. Never set LOCAL_OTP_MODE=true on Render; live signup should use Twilio Verify.
