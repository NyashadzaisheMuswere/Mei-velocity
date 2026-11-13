MEI VELOCITY — BACKEND PASSWORD UPDATE

Adds missing endpoints already expected by the Expo app:
  POST /api/customer/change-password
  POST /api/customer/forgot-password/request
  POST /api/customer/forgot-password/confirm

Includes:
  server.js                 Updated complete backend based on the most recent
                            deletion-enabled server.js shared in this chat.
  add_password_routes.py    Recommended safe patch for YOUR actual latest
                            Render backend file, preserving later changes.

RECOMMENDED: patch YOUR latest live backend code (rather than replacing with an
older complete server.js if you've made more changes since the last upload).

1. In VS Code, open the GitHub repository connected to your Render backend.
2. Find which server.js Render runs. Check Render > Settings > Start Command.
   Example: node backend/server.js (use the actual path).
3. Copy add_password_routes.py into the repository root.
4. From that root, run (adjust path as needed):
      python add_password_routes.py backend/server.js
   If you are IN the backend directory, use:
      python add_password_routes.py server.js
   The script creates a server.js.before_password_recovery.bak backup.
   It will refuse to run if expected code differs; do not force the patch.
5. Check syntax:
      node --check backend/server.js
6. Commit ONLY the modified server.js; do not commit backups or secrets:
      git add backend/server.js
      git commit -m "Add customer password change and SMS recovery"
      git push
7. In Render, verify that this commit is deployed and shows Live.

Alternative: if your deployed server is exactly the deletion-enabled version
that you previously supplied, you may replace backend/server.js with the
included server.js. Back up first. The patch method is safer for evolving code.

SAFE ENDPOINT CHECK: In PowerShell on your laptop, use WITHOUT authorization:
  curl.exe -i -X POST https://mei-velocity1.onrender.com/api/customer/change-password
Expected: HTTP 401 + JSON (route exists and requires sign-in).
HTTP 404 "Cannot POST ..." means Render is still running an older server.

TESTING IN THE APP:
- Sign in to MEI Velocity (do not test account deletion).
- Account > Change Password > enter current and new password.
- After success, the app stores the new session token.
- To test Forgot Password, use your verified phone number; SMS provider
  settings on Render must already be configured.
- Test new sign-in ONLY after a successful password update.

SECURITY:
- Scrypt hashing, authenticated current-password check.
- Password changes invalidate earlier customer sessions.
- Forgot-password SMS codes expire after 10 minutes; attempts/rate limited.
- No change to drivers' passwords, booking, tracking, or account deletion logic.
- Existing token storage on the mobile app continues to be used.

CAUTION: Code is syntax-checked, but live PostgreSQL/Twilio integration and
Render deployment have not been verified. Use a backup, and review changes.
