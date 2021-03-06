// Skylines API.

/* eslint-disable @typescript-eslint/no-var-requires */
const request = require('request-zero');

import { decodeDeltas } from 'ol/format/Polyline';

import { createFeatures, Point, REFRESH_EVERY_MINUTES } from './trackers';

const SECONDS_IN_DAY = 60 * 60 * 24;

// Queries the datastore for the devices that have not been updated in REFRESH_EVERY_MINUTES.
// Queries the skylines API until the timeout is reached and store the data back into the datastore.
export async function refresh(datastore: any, maxHour: number, timeoutSecs: number): Promise<number> {
  const start = Date.now();

  const query = datastore
    .createQuery('Tracker')
    .filter('device', '=', 'skylines')
    .filter('updated', '<', start - REFRESH_EVERY_MINUTES * 60 * 1000)
    .order('updated', { descending: true });

  const devices = (await datastore.runQuery(query))[0];

  let numDevices = 0;
  const numActiveDevices = 0;

  for (; numDevices < devices.length; numDevices++) {
    const device = devices[numDevices];
    const id: string = device.skylines;
    if (/^\d+$/i.test(id)) {
      console.log(`Refreshing skylines @ ${id}`);
      const url = `https://skylines.aero/api/live/${id}`;
      let response;
      try {
        response = await request(url);
      } catch (e) {
        console.log(`Error refreshing skylines @ ${id} = ${e.message}`);
        continue;
      }
      if (response.code != 200) {
        console.log(`Error refreshing skylines @ ${id}`);
        continue;
      }
      const live = JSON.parse(response.body);

      let points: Point[] = [];
      if (Array.isArray(live.flights) && live.flights.length > 0) {
        points = decodeFlight(live.flights[0], live?.pilots[0]?.name ?? 'unknown', maxHour);
      }

      device.features = JSON.stringify(createFeatures(points));
      device.updated = Date.now();
      device.active = points.length > 0;

      datastore.save({
        key: device[datastore.KEY],
        data: device,
        excludeFromIndexes: ['features'],
      });
    }

    if (Date.now() - start > timeoutSecs * 1000) {
      console.error(`Timeout for skylines devices (${timeoutSecs}s)`);
      break;
    }
  }
  console.log(`Refreshed ${numDevices} skylines in ${(Date.now() - start) / 1000}s`);
  return numActiveDevices;
}

export function decodeFlight(flight: any, name: string, maxHour: number, nowMillis = Date.now()): Point[] {
  const time = decodeDeltas(flight.barogram_t, 1, 1);
  const lonlat = decodeDeltas(flight.points, 2);
  const height = decodeDeltas(flight.barogram_h, 1, 1);
  const geoid = flight.geoid ?? 0;

  // startSeconds reference is a number of seconds since midnight UTC the day the track started.
  const startSeconds = time[0];
  // startDaySeconds is the number of seconds since previous midnight UTC.
  const startDaySeconds = time[0] % SECONDS_IN_DAY;
  // Current timestamp in seconds.
  const nowSeconds = Math.ceil(nowMillis / 1000);
  // Number of seconds since midnight UTC.
  const nowDaySeconds = nowSeconds % SECONDS_IN_DAY;
  const startedOnPreviousDay = startDaySeconds > nowDaySeconds;
  const startOfCurrentDayInSeconds = nowSeconds - nowDaySeconds;
  // Timestamp of the first fix.
  // Start of the current day - 24h if the track was started on the previous day + seconds in day of the first fix.
  const startTimestampSeconds =
    startOfCurrentDayInSeconds - (startedOnPreviousDay ? SECONDS_IN_DAY : 0) + startDaySeconds;

  const points: Point[] = [];
  time.forEach((seconds: number, i: number) => {
    const tsSeconds = startTimestampSeconds + seconds - startSeconds;
    if (nowSeconds - tsSeconds <= maxHour * 3600) {
      points.push({
        ts: tsSeconds * 1000,
        lat: Math.round(lonlat[i * 2] * 1e5) / 1e5,
        lon: Math.round(lonlat[i * 2 + 1] * 1e5) / 1e5,
        alt: Math.round(height[i] + geoid),
        name,
        emergency: false,
      });
    }
  });

  return points;
}
