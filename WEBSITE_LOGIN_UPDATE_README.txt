MEI VELOCITY — WEBSITE LOGIN MATCHED TO MOBILE APP

REPLACE:
1. Website/customer frontend app.js with the included app.js.
2. Backend server.js only if your Render deployment does not already have POST /api/customer/login, or if you have not installed the prior Account Deletion update. Back up existing files first.

WHAT CHANGED:
- Website Sign In uses USERNAME + PASSWORD, not SMS each time.
- Create Account uses USERNAME + PHONE NUMBER + PASSWORD, followed by a one-time SMS verification code.
- Uses the SAME customers database and existing backend routes as the phone app; one account can sign in on both platforms.
- Carries forward the account deletion feature from the previously prepared update.
- Does not replace index.html: account form is updated by JavaScript when loaded.

IMPORTANT:
- A passwordless account created earlier on the website cannot sign in with a password until it has been upgraded/assigned one. Do not delete customer records to resolve this.
- Server should be deployed before frontend.
- For an existing password-protected test account, sign in on both phone and website with the same username/password.
- For a NEW test account, create an account on the website, verify SMS and then sign in on the phone.
- Do not test permanent deletion on a real account.
- This was syntax-checked; test actual SMS, login, and deletion against your dev/test backend before releasing.
