/* =========================================================
   MEI VELOCITY SERVICE WORKER
   Handles phone push notifications
========================================================= */

self.addEventListener("install", event => {
  console.log("MEI Velocity service worker installed.");

  self.skipWaiting();
});


self.addEventListener("activate", event => {
  console.log("MEI Velocity service worker activated.");

  event.waitUntil(
    self.clients.claim()
  );
});


/* =========================================================
   RECEIVE PUSH NOTIFICATION
========================================================= */

self.addEventListener("push", event => {
  let payload = {
    title: "MEI Velocity",
    body: "You have a new ride update.",
    url: "./index.html"
  };

  if (event.data) {
    try {
      payload = {
        ...payload,
        ...event.data.json()
      };
    } catch {
      payload.body =
        event.data.text();
    }
  }

  const options = {
    body: payload.body,

    icon:
      payload.icon ||
      "./assets/mei_logo.jpg",

    badge:
      payload.badge ||
      "./assets/mei_logo.jpg",

    vibrate: [
      200,
      100,
      200
    ],

    tag:
      payload.tag ||
      "mei-velocity-ride-update",

    renotify: true,

    data: {
      url:
        payload.url ||
        "./index.html",

      bookingId:
        payload.bookingId ||
        null
    }
  };

  event.waitUntil(
    self.registration.showNotification(
      payload.title ||
      "MEI Velocity",
      options
    )
  );
});


/* =========================================================
   USER TAPS NOTIFICATION
========================================================= */

self.addEventListener(
  "notificationclick",
  event => {
    event.notification.close();

    const notificationData =
      event.notification.data || {};

    let targetUrl =
      notificationData.url ||
      "./index.html";

    if (
      notificationData.bookingId &&
      !targetUrl.includes(
        "bookingId="
      )
    ) {
      targetUrl =
        `./index.html?view=ride&bookingId=${encodeURIComponent(
          notificationData.bookingId
        )}`;
    }

    event.waitUntil(
      clients
        .matchAll({
          type: "window",
          includeUncontrolled: true
        })
        .then(clientList => {
          for (
            const client of
            clientList
          ) {
            if (
              "focus" in client
            ) {
              client.navigate(
                targetUrl
              );

              return client.focus();
            }
          }

          if (
            clients.openWindow
          ) {
            return clients.openWindow(
              targetUrl
            );
          }
        })
    );
  }
);