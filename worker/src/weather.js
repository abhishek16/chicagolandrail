// Weather at a station via the free api.weather.gov (no key, but wants a
// User-Agent). Two-step: /points → hourly forecast URL → hourly periods.

export async function weatherFor(lat, lon, contact) {
  const headers = {
    "User-Agent": `chicagoland-rail (${contact || "commuter app"})`,
    "Accept": "application/geo+json",
  };
  const pRes = await fetch(`https://api.weather.gov/points/${lat},${lon}`, { headers });
  if (!pRes.ok) throw Object.assign(new Error(`weather points ${pRes.status}`), { status: 502 });
  const hourlyUrl = (await pRes.json()).properties?.forecastHourly;
  if (!hourlyUrl) throw Object.assign(new Error("no hourly forecast"), { status: 502 });

  const hRes = await fetch(hourlyUrl, { headers });
  if (!hRes.ok) throw Object.assign(new Error(`weather hourly ${hRes.status}`), { status: 502 });
  const periods = ((await hRes.json()).properties?.periods || []).slice(0, 12).map(p => ({
    t: p.startTime,
    temp: p.temperature,
    unit: p.temperatureUnit,
    sky: p.shortForecast,
    precip: p.probabilityOfPrecipitation?.value ?? null,
  }));
  return { periods };
}
