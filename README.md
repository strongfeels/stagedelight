# Virtual Toastmasters

Practice public speaking with strangers, instantly.

A real-time video chat application that connects you with other people to practice public speaking. Choose a virtual stage, take turns speaking, and get comfortable presenting to an audience.

## Features

- **Multiple Room Types** - Choose from different virtual stages:
  - Conference Room (15 min talks)
  - Theater Stage (12 min talks)
  - Concert Hall (6 min talks)
  - Classroom (9 min talks)
  - Coffee Shop (3 min talks)

- **Speaker Queue** - Fair turn-based system where everyone gets a chance to speak
- **Vote to Start** - Rooms begin when 2+ participants vote to start (or auto-start after 5 min)
- **Vote to Skip** - Audience can vote to skip the current speaker (requires majority)
- **Live Timer** - Countdown timer with color-coded warnings
- **Camera/Mic Controls** - Toggle your video and audio on/off

## Tech Stack

- **Backend**: Node.js, Express, Socket.io
- **Frontend**: Vanilla JavaScript, HTML, CSS
- **Real-time**: WebRTC for peer-to-peer video/audio

## Getting Started

### Prerequisites

- Node.js 18.x

### Installation

```bash
# Clone the repository
git clone https://github.com/strongfeels/stagedelight.git
cd stagedelight

# Install dependencies
npm install

# Start the server
npm start
```

The app will be running at `http://localhost:3000`

### Development

```bash
npm run dev
```

This starts the server with nodemon for auto-restart on file changes.

## How It Works

1. Choose a room type based on your preferred talk duration
2. Allow camera and microphone access
3. Wait for others to join or vote to start
4. When it's your turn, you'll be spotlighted as the speaker
5. Speak until your time runs out or the audience votes to skip
6. Pass the spotlight to the next person in queue

## Connectivity: STUN and TURN

A browser needs help discovering how it is reachable. A **STUN** server tells
it its own public address, which is enough when at least one side's NAT will
accept a packet from a new peer. It is not always enough: behind **symmetric
NAT** — common on corporate networks and some mobile carriers — the NAT opens
a port for one destination only, so no direct path exists and the call never
connects.

**TURN** is the fallback. It relays the media through a server both sides can
reach, so it always works, at the cost of running the traffic through your own
bandwidth.

With nothing configured the app uses a public STUN server and no relay, so
those calls still fail. Set the variables below to fix that; there are three
modes, depending on what your provider issues.

**Cloudflare** mints credentials through its API rather than accepting a
secret:

| variable | meaning |
|---|---|
| `TURN_KEY_ID` | the TURN key's ID, from the Cloudflare dashboard |
| `TURN_API_TOKEN` | the token that goes with it |

**coturn**, or anything supporting its `static-auth-secret` scheme:

| variable | meaning |
|---|---|
| `TURN_URLS` | comma-separated, e.g. `turn:relay.example.com:3478,turns:relay.example.com:5349` |
| `TURN_SECRET` | the same value as coturn's `static-auth-secret` |

**A fixed username and password**, which some hosted providers hand out:

| variable | meaning |
|---|---|
| `TURN_URLS` | as above |
| `TURN_USERNAME` / `TURN_PASSWORD` | the credentials they gave you |

And in any mode:

| variable | meaning |
|---|---|
| `TURN_TTL` | how long minted credentials last, seconds (default `3600`) |
| `STUN_URLS` | override the default STUN server |
| `TURN_ONLY` | `1` forces every call through the relay — for testing only |

Credentials are served from `GET /api/ice` and never written into
`public/js/`, which anyone can read. Prefer a mode that issues short-lived
credentials — Cloudflare's API or coturn's secret — so a credential scraped
off the network stops working within the hour.

If the relay can't be reached, the endpoint falls back to STUN alone and logs
why. Calls that could have worked directly still work; only the ones that
needed the relay fail.

### Checking whether you need it

The server logs how peer connections turn out:

```
[ice] connected via direct | 14 connected, 2 failed (13% failing), 0 needed the relay, 1 saved by the retry
```

Every event reprints the running totals, so only the last line matters. If the
failure rate is near zero there is nothing to fix. The counters are in memory
and reset on restart.

To prove a relay works once configured, set `TURN_ONLY=1` and make a call:
that forces `iceTransportPolicy: 'relay'`, so it can only succeed through the
relay. Turn it off afterwards — it sends all media through the relay and you
pay for every byte.

## License

MIT
