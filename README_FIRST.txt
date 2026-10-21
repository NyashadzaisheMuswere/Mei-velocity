MEI VELOCITY — ACCOUNT DELETION BACKEND FIX

This package updates the exact server.js you uploaded on 21 October 2026.
It adds one route:
  DELETE /api/customer/account

It does NOT replace or modify the existing login, driver, notification,
booking, or other endpoints.

Deployment:
1. Make a backup of your current backend/server.js.
2. Replace ONLY backend/server.js with the included server.js.
   (If Render's service uses a different directory, replace the server.js that
   its Start Command actually runs.)
3. Run `node --check server.js` from the backend folder.
4. Push the change to your GitHub repository and deploy on Render.
5. In Render -> Events, wait for the latest deployment to show Live.
6. In your existing Expo app, sign in with a DISPOSABLE test customer account.
   Ensure this customer has no Pending or Confirmed ride.
7. Open Account -> Delete account; enter the correct account password if prompted.
8. Verify the user is signed out and cannot sign in with the deleted credentials.
9. Do NOT test deletion using a real customer's account.

The endpoint:
- Requires an authenticated customer session.
- Rechecks the current password for accounts with a password hash.
- Refuses deletion when there are active rides.
- Removes ride chat messages and cancelled bookings.
- Anonymizes completed booking records for operational accounting.
- Removes customer verification codes, login attempt metadata, web push
  subscriptions and the customer record. Expo push token rows cascade if
  installed with the previously supplied ON DELETE CASCADE migration.
- All SQL changes are in a transaction and roll back on failure.

IMPORTANT: This package has a successful Node syntax check and isolated route
smoke tests. It has NOT been tested against your live Render PostgreSQL schema.
Always test with a disposable account before wider deployment.

No Expo Go refresh, EAS build, or TestFlight upload is necessary for this
server-only change once the iPhone app already has the Delete Account button.
