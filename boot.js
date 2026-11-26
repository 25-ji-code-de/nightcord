/* SPDX-License-Identifier: AGPL-3.0-only */

// Keep startup external so CSP can reject inline scripts and event handlers.
if (typeof RoomDestination !== 'undefined') RoomDestination.capture();
let nightcord = new Nightcord();
const params = new URLSearchParams(location.search);
if (params.has('test')) {
  nightcord.init('nightcord-test');
} else {
  nightcord.init();
}

if (typeof RoomDestination !== 'undefined' && RoomDestination.pending) { const destination = RoomDestination.pending; void nightcord.roomsView.enter(destination.id, destination.secret); }
