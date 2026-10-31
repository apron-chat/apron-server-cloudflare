#!/usr/bin/env node
// Prints a per-day report of the server's Cloudflare usage: the Durable
// Object's awake time and billed duration, peak open sockets and busiest hour
// (GraphQL analytics, unsampled), invocations that threw, and the counters in
// the METRICS Analytics Engine dataset (src/metrics.ts), also unsampled.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run usage:report -- --days 3
//
// The token needs Account Analytics Read. Options: --days N (default 2, at
// most 7: GraphQL serves a week), --dataset NAME (default
// apron_server_metrics). Days are UTC.

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) {
	console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Account Analytics Read).");
	process.exit(1);
}
const days = Math.min(7, Math.max(1, Number(option("days", "2")) || 2));
const dataset = option("dataset", "apron_server_metrics");
if (!/^[A-Za-z0-9_]+$/.test(dataset)) {
	console.error("--dataset must be letters, digits and _");
	process.exit(1);
}
const api = "https://api.cloudflare.com/client/v4";
const headers = { Authorization: `Bearer ${token}` };
// Whole UTC days, ending with today so far.
const end = new Date();
const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - (days - 1)));

async function graphql(query) {
	const response = await fetch(`${api}/graphql`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
	const body = await response.json();
	if (!response.ok || body.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(body.errors ?? response.status)}`);
	return body.data.viewer.accounts[0];
}

async function analyticsSql(sql) {
	const response = await fetch(`${api}/accounts/${account}/analytics_engine/sql`, { method: "POST", headers, body: sql });
	const text = await response.text();
	if (!response.ok) throw new Error(`Analytics Engine: HTTP ${response.status} ${text.slice(0, 200)}`);
	return JSON.parse(text).data;
}

const durable = await graphql(`{ viewer { accounts(filter: { accountTag: ${JSON.stringify(account)} }) {
	hours: durableObjectsPeriodicGroups(limit: 200, filter: { datetimeHour_geq: ${JSON.stringify(start.toISOString())} }, orderBy: [datetimeHour_ASC]) {
		dimensions { datetimeHour } sum { activeTime duration } max { activeWebsocketConnections }
	}
	invocations: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date_geq: ${JSON.stringify(start.toISOString().slice(0, 10))} }) {
		dimensions { date status } sum { requests }
	}
} } }`);

const perDay = new Map();
const dayOf = (date) => perDay.get(date) ?? perDay.set(date, { awake: 0, gbSeconds: 0, sockets: 0, busiest: 0, requests: 0, threw: 0 }).get(date);
for (const hour of durable.hours) {
	const day = dayOf(hour.dimensions.datetimeHour.slice(0, 10));
	const awake = hour.sum.activeTime / 1e6;
	day.awake += awake;
	day.gbSeconds += hour.sum.duration;
	day.sockets = Math.max(day.sockets, hour.max.activeWebsocketConnections);
	day.busiest = Math.max(day.busiest, awake / 3_600);
}
for (const group of durable.invocations) {
	const day = dayOf(group.dimensions.date);
	day.requests += group.sum.requests;
	if (group.dimensions.status === "scriptThrewException") day.threw += group.sum.requests;
}

const percent = (value) => `${Math.round(value * 100)}%`;
console.log("Durable Object, per UTC day (GraphQL analytics, unsampled)\n");
console.table([...perDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => ({
	day: date,
	"awake s": Math.round(day.awake),
	"awake %": percent(day.awake / 86_400),
	"GB-s": Math.round(day.gbSeconds),
	"busiest hour": percent(day.busiest),
	"peak sockets": day.sockets,
	invocations: Math.round(day.requests),
	threw: day.threw,
})));

try {
	const rows = await analyticsSql(`SELECT toStartOfDay(timestamp) AS day, blob1 AS event, blob2 AS detail,
		SUM(_sample_interval) AS points, SUM(_sample_interval * double1) AS value
		FROM ${dataset} WHERE timestamp >= toDateTime('${start.toISOString().slice(0, 19).replace("T", " ")}')
		GROUP BY day, event, detail ORDER BY day, event, detail FORMAT JSON`);
	console.log(`\nCounters in ${dataset}, per UTC day (Analytics Engine, unsampled)\n`);
	if (!rows.length) console.log("(none yet)");
	else console.table(rows.map((row) => ({ day: String(row.day).slice(0, 10), event: row.event, detail: row.detail, count: Number(row.points), value: Number(row.value) })));
} catch (error) {
	console.log(`\nCounters in ${dataset}: unavailable (${error.message}). The dataset exists once the server has written to it.`);
}
