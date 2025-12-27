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

## License

MIT
