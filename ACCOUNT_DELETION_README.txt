MEI VELOCITY — CUSTOMER ACCOUNT DELETION

FILES:
- app.js: replace your current CUSTOMER APP app.js (not the driver's app.js)
- server.js: replace backend/server.js deployed on Render

IMPORTANT:
1. Back up the two original files first.
2. Deploy server.js to Render before publishing app.js.
3. The Delete Account button is automatically added to the existing account profile; no index.html edits are required.
4. This feature requires a valid signed-in customer session. Password-protected accounts must enter their password again. Legacy SMS-only customers can confirm deletion using their current authenticated session.
5. Customers with Pending/Confirmed rides are asked to finish/cancel those rides first.
6. Completed rides retain anonymized bookkeeping records; cancelled bookings are deleted; the account, subscriptions, authentication artifacts and ride chats are removed.
7. After the server confirms deletion, the app clears local account and history data and returns to the homepage.
8. Test with a disposable CUSTOMER account before allowing real users to delete accounts.

The supplied server.js assumes the deployed PostgreSQL schema includes the customerId and ride columns already used by the existing backend. Verify any other tables added outside this file before rollout.
