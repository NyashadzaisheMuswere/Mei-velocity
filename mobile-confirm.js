
/*
  MEI VELOCITY — mobile confirmation map helper

  This file does not submit bookings and does not replace app.js.
  It only restores the existing home map on the phone confirmation view
  and redraws the route already stored in meiVelocityBookingDraft.
*/

(function () {
  "use strict";

  const params =
    new URLSearchParams(
      window.location.search
    );

  if (
    params.get("view") !== "confirm" ||
    window.matchMedia("(min-width: 701px)").matches
  ) {
    return;
  }

  let draft = null;

  try {
    draft =
      JSON.parse(
        localStorage.getItem(
          "meiVelocityBookingDraft"
        ) || "null"
      );
  } catch {
    draft = null;
  }

  if (
    !draft?.pickup ||
    !draft?.dropoff
  ) {
    return;
  }

  async function restoreConfirmMap() {
    try {
      /*
        app.js deliberately skips initHomeMap() when ?view=confirm.
        For the phone layout we now keep the same home map visible,
        so initialize that existing map here.
      */
      if (
        typeof initHomeMap === "function"
      ) {
        initHomeMap();
      }

      const pickupInput =
        document.getElementById(
          "pickup"
        );

      const dropoffInput =
        document.getElementById(
          "dropoff"
        );

      if (pickupInput) {
        pickupInput.value =
          draft.pickup;
      }

      if (dropoffInput) {
        dropoffInput.value =
          draft.dropoff;
      }

      /*
        If exact pickup coordinates were already saved, show the pickup
        marker immediately while the route is being restored.
      */
      const pickupLat =
        Number(
          draft.pickupLat
        );

      const pickupLng =
        Number(
          draft.pickupLng
        );

      if (
        Number.isFinite(
          pickupLat
        ) &&
        Number.isFinite(
          pickupLng
        ) &&
        typeof showHomeRiderLocation ===
          "function"
      ) {
        showHomeRiderLocation(
          pickupLat,
          pickupLng
        );
      }

      /*
        Reuse the existing route/fare calculator from app.js.
        This redraws the orange route on #homeMap without changing
        the booking draft or the backend request flow.
      */
      if (
        typeof calculateFare ===
        "function"
      ) {
        await calculateFare();
      }

      /*
        The review sheet is taller than the normal booking sheet,
        so refit the already-created route with extra bottom padding.
      */
      try {
        if (
          typeof homeMap !==
            "undefined" &&
          homeMap &&
          typeof homeRouteLine !==
            "undefined" &&
          homeRouteLine
        ) {
          const bottomPadding =
            Math.min(
              Math.round(
                window.innerHeight *
                  0.48
              ),
              430
            );

          homeMap.fitBounds(
            homeRouteLine.getBounds(),
            {
              paddingTopLeft:
                [34, 76],

              paddingBottomRight:
                [
                  34,
                  bottomPadding
                ],

              maxZoom:
                15
            }
          );

          setTimeout(
            () =>
              homeMap?.invalidateSize(),
            120
          );
        }
      } catch (
        mapFitError
      ) {
        console.warn(
          "Review map fit skipped:",
          mapFitError
        );
      }

    } catch (error) {
      console.warn(
        "Could not restore the review map:",
        error
      );
    }
  }

  /*
    Defer very slightly so the normal app.js confirmation setup has
    finished populating the review fields first.
  */
  setTimeout(
    restoreConfirmMap,
    120
  );
})();
