/* SPDX-License-Identifier: AGPL-3.0-only */
// Planning model; rates checked against Cloudflare documentation on 2026-11-07.
// SFU/TURN: https://developers.cloudflare.com/realtime/sfu/platform/pricing/
// RealtimeKit: https://developers.cloudflare.com/realtime/realtimekit/platform/pricing/

const defaults = {
  participants: 8,
  publishers: undefined,
  'hours-per-day': 3,
  days: 30,
  rooms: 1,
  kbps: 64,
  'relay-fraction': 1,
  'other-realtime-gb': 0,
  'other-kit-minutes': 0,
};

function usage() {
  console.log(`Usage: node scripts/estimate-voice-cost.mjs [options]

  --participants N        People in each room, including listeners (default 8)
  --publishers N          Continuously publishing microphones (default participants)
  --hours-per-day N       Occupied hours per room per day, 0..24 (default 3)
  --days N                Days in the billing period, 1..31 (default 30)
  --rooms N               Identical rooms sharing the account allowance (default 1)
  --kbps N                Average effective kbps per delivered audio copy (default 64)
                         Include protocol overhead; this is a planning assumption.
  --relay-fraction N      Share of mesh delivery bytes billed by TURN, 0..1 (default 1)
  --other-realtime-gb N   Other account SFU/TURN egress this month (default 0)
  --other-kit-minutes N   Other account audio-only participant minutes (default 0)
  --json                 Print machine-readable results
  --help                 Show this help

Prices: SFU/TURN share 1,000 GB/month, then USD 0.05/GB.
RealtimeKit Voice includes 10,000 participant minutes/month, then USD 0.0005/minute.
Alternatives are compared separately, each with the supplied other account usage.
The model excludes Workers, Durable Objects, recordings, AI, taxes and rounding.
Actual average bitrate, relay share and Cloudflare billing can differ.`);
}

function parseArgs(args) {
  const options = { ...defaults };
  let json = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') return { help: true };
    if (argument === '--json') { json = true; continue; }
    const key = argument.startsWith('--') ? argument.slice(2) : '';
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown option: ${argument}`);
    if (seen.has(key)) throw new Error(`Repeated option: ${argument}`);
    const input = args[++index];
    if (input === undefined || input.trim() === '') throw new Error(`Missing value: ${argument}`);
    const value = Number(input);
    if (!Number.isFinite(value)) throw new Error(`Expected a finite number: ${argument}`);
    options[key] = value;
    seen.add(key);
  }
  options.publishers ??= options.participants;
  for (const key of ['participants', 'publishers', 'days', 'rooms']) {
    if (!Number.isSafeInteger(options[key])) throw new Error(`Expected an integer: --${key}`);
  }
  if (options.participants < 1 || options.participants > 500) throw new Error('--participants must be 1..500 (model range, not a product limit)');
  if (options.publishers < 0 || options.publishers > options.participants) throw new Error('--publishers must be 0..participants');
  if (options.days < 1 || options.days > 31) throw new Error('--days must be 1..31');
  if (options.rooms < 1) throw new Error('--rooms must be positive');
  if (options['hours-per-day'] < 0 || options['hours-per-day'] > 24) throw new Error('--hours-per-day must be 0..24');
  if (options.kbps <= 0) throw new Error('--kbps must be positive');
  if (options['relay-fraction'] < 0 || options['relay-fraction'] > 1) throw new Error('--relay-fraction must be 0..1');
  if (options['other-realtime-gb'] < 0 || options['other-kit-minutes'] < 0) throw new Error('Other account usage must be non-negative');
  return { options, json };
}

function estimate(options) {
  const roomHours = options.rooms * options.days * options['hours-per-day'];
  // Every publisher delivers one copy to every other participant. GB is decimal.
  const deliveredCopies = options.publishers * (options.participants - 1);
  const egressGbPerRoomHour = deliveredCopies * options.kbps * 1_000 / 8 * 3_600 / 1_000_000_000;
  const sfuEgressGb = roomHours * egressGbPerRoomHour;
  const turnEgressGb = sfuEgressGb * options['relay-fraction'];
  const participantMinutes = options.participants * roomHours * 60;
  const realtimeRemainingGb = Math.max(0, 1_000 - options['other-realtime-gb']);
  const kitRemainingMinutes = Math.max(0, 10_000 - options['other-kit-minutes']);
  const result = {
    checkedOn: '2026-11-07',
    assumptions: options,
    roomHours,
    deliveredCopies,
    egressGbPerRoomHour,
    remainingAccountAllowances: { realtimeGb: realtimeRemainingGb, kitVoiceMinutes: kitRemainingMinutes },
    sfu: {
      egressGb: sfuEgressGb,
      incrementalMediaUsd: Math.max(0, sfuEgressGb - realtimeRemainingGb) * 0.05,
      freeRoomHours: egressGbPerRoomHour ? realtimeRemainingGb / egressGbPerRoomHour : null,
    },
    meshWithTurn: {
      egressGb: turnEgressGb,
      incrementalMediaUsd: Math.max(0, turnEgressGb - realtimeRemainingGb) * 0.05,
    },
    realtimeKitVoice: {
      participantMinutes,
      incrementalMediaUsd: Math.max(0, participantMinutes - kitRemainingMinutes) * 0.0005,
      freeRoomHours: kitRemainingMinutes / (options.participants * 60),
    },
  };
  for (const value of [roomHours, sfuEgressGb, participantMinutes]) {
    if (!Number.isFinite(value)) throw new Error('Inputs exceed the numeric range of this model');
  }
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage();
  else {
    const result = estimate(args.options);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      const number = value => value.toLocaleString('en-US', { maximumFractionDigits: 3 });
      console.log(`Planning estimate: ${number(result.roomHours)} total room-hours; ${result.assumptions.participants} people/room; ${result.assumptions.publishers} publishing; ${result.assumptions.kbps} effective kbps/copy.`);
      console.table([
        { alternative: 'SFU', usage: `${number(result.sfu.egressGb)} GB`, incrementalMediaUsd: number(result.sfu.incrementalMediaUsd) },
        { alternative: `P2P + TURN (${number(result.assumptions['relay-fraction'] * 100)}% relayed bytes)`, usage: `${number(result.meshWithTurn.egressGb)} GB`, incrementalMediaUsd: number(result.meshWithTurn.incrementalMediaUsd) },
        { alternative: 'RealtimeKit Voice', usage: `${number(result.realtimeKitVoice.participantMinutes)} participant-minutes`, incrementalMediaUsd: number(result.realtimeKitVoice.incrementalMediaUsd) },
      ]);
      console.log('Uses one shared account allowance per alternative. Mesh relay share and bitrate need measurement. Backend and other services are excluded. Use --json for full assumptions.');
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
