// server.js
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Serve static files
app.use(express.static('public'));

// Room configurations
const ROOM_CONFIGS = {
    conference: { duration: 15 * 60, label: '💼 Conference', minVotesToStart: 2 },
    stage: { duration: 12 * 60, label: 'Theater Stage', minVotesToStart: 2 },
    concert: { duration: 9 * 60, label: 'Concert Hall', minVotesToStart: 2 },
    classroom: { duration: 6 * 60, label: 'Classroom', minVotesToStart: 2 },
    casual: { duration: 3 * 60, label: '☕ Coffee Shop', minVotesToStart: 2 }
};

// Serve index.html for valid room type URLs (e.g. /casual, /stage)
app.get('/:roomType', (req, res, next) => {
    if (ROOM_CONFIGS[req.params.roomType]) {
        res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } else {
        next();
    }
});

// Display names pool
const SPEAKER_NAMES = [
    'Gandalf', 'Atticus', 'Tyrion', 'Morpheus', 'Aragorn',
    'Dumbledore', 'Hamlet', 'Optimus', 'Maximus', 'Yoda',
    'Aslan', 'Theoden', 'Daenerys', 'Prospero', 'Samwise',
    'Hermione', 'Elrond', 'Rafiki', 'Minerva', 'Groot'
];

// Room management
class Room {
    constructor(id, roomType) {
        this.id = id;
        this.roomType = roomType;
        this.config = ROOM_CONFIGS[roomType];
        this.queue = [];
        this.users = new Map();
        this.skipVotes = new Set();
        this.currentSpeakerIndex = 0;
        this.hasStarted = false;
        this.startVotes = new Set();
        this.speakerStartedAt = null;
        this.availableNames = [...SPEAKER_NAMES].sort(() => Math.random() - 0.5);
        this.nameMap = new Map(); // socketId -> display name
    }

    addUser(socketId) {
        const name = this.availableNames.pop() || `Speaker ${socketId.slice(-4)}`;
        this.nameMap.set(socketId, name);
        this.users.set(socketId, {
            id: socketId,
            name: name,
            joinedAt: Date.now()
        });
    }

    getName(socketId) {
        return this.nameMap.get(socketId) || socketId.slice(-4);
    }

    joinQueue(socketId) {
        if (!this.users.has(socketId)) return;
        if (this.queue.some(u => u.id === socketId)) return;

        this.queue.push({ id: socketId });

        // Auto-start if enough votes were already cast but queue was empty
        if (!this.hasStarted && this.startVotes.size >= this.config.minVotesToStart) {
            this.forceStart();
            return { autoStarted: true };
        }

        return null;
    }

    leaveQueue(socketId) {
        const wasSpeaking = this.getCurrentSpeaker()?.id === socketId;
        const oldIndex = this.queue.findIndex(u => u.id === socketId);
        if (oldIndex === -1) return;

        if (wasSpeaking && this.hasStarted) {
            this.nextSpeaker();
        }

        this.queue = this.queue.filter(u => u.id !== socketId);

        // Adjust speaker index after removal
        if (this.queue.length > 0) {
            if (oldIndex < this.currentSpeakerIndex) {
                this.currentSpeakerIndex--;
            }
            if (this.currentSpeakerIndex >= this.queue.length) {
                this.currentSpeakerIndex = 0;
            }
        } else {
            this.currentSpeakerIndex = 0;
        }
    }

    getAudience() {
        const queueIds = new Set(this.queue.map(u => u.id));
        const audience = [];
        for (const [id, user] of this.users) {
            if (!queueIds.has(id)) {
                audience.push({ id });
            }
        }
        return audience;
    }

    removeUser(socketId) {
        const name = this.nameMap.get(socketId);
        if (name) {
            this.availableNames.push(name);
            this.nameMap.delete(socketId);
        }
        this.users.delete(socketId);
        this.queue = this.queue.filter(user => user.id !== socketId);
        this.skipVotes.delete(socketId);
        this.startVotes.delete(socketId);

        if (this.currentSpeakerIndex >= this.queue.length && this.queue.length > 0) {
            this.currentSpeakerIndex = 0;
            if (this.hasStarted) {
                this.startNextSpeaker();
            }
        }

    }

    voteToStart(socketId) {
        if (this.hasStarted) return null;

        this.startVotes.add(socketId);

        const needed = this.config.minVotesToStart;
        if (this.startVotes.size >= needed && this.queue.length > 0) {
            this.forceStart();
            return { started: true };
        }

        return {
            started: false,
            votes: this.startVotes.size,
            needed: needed
        };
    }

    forceStart() {
        if (this.hasStarted) return;

        this.hasStarted = true;
        this.startVotes.clear();
        if (this.queue.length > 0) {
            this.startNextSpeaker();
        }
    }

    voteSkip(socketId) {
        this.skipVotes.add(socketId);

        const needed = Math.ceil(this.users.size / 2);
        if (this.skipVotes.size >= needed) {
            this.skipCurrentSpeaker();
        }

        return {
            votes: this.skipVotes.size,
            needed: needed
        };
    }

    skipCurrentSpeaker() {
        this.skipVotes.clear();
        this.nextSpeaker();
    }

    nextSpeaker() {
        if (this.queue.length === 0) return null;

        this.currentSpeakerIndex = (this.currentSpeakerIndex + 1) % this.queue.length;
        this.startNextSpeaker();
    }

    startNextSpeaker() {
        this.skipVotes.clear();
        this.speakerStartedAt = Date.now();
        return this.getCurrentSpeaker();
    }

    getRemainingTime() {
        if (!this.speakerStartedAt) return this.config.duration;
        const elapsed = Math.floor((Date.now() - this.speakerStartedAt) / 1000);
        return Math.max(0, this.config.duration - elapsed);
    }

    getCurrentSpeaker() {
        if (this.queue.length === 0) return null;
        return this.queue[this.currentSpeakerIndex];
    }

    getSkipVotesNeeded() {
        return Math.ceil(this.users.size / 2);
    }

    isEmpty() {
        return this.users.size === 0;
    }

    getUserCount() {
        return this.users.size;
    }
}

// Global rooms manager
const rooms = new Map();
let roomCounter = 1;

function findOrCreateRoom(roomType) {
    for (const [id, room] of rooms) {
        if (room.roomType === roomType && room.users.size < 20) {
            return room;
        }
    }

    const newRoom = new Room(roomCounter++, roomType);
    rooms.set(newRoom.id, newRoom);
    return newRoom;
}

function getRoomStats() {
    const stats = {};
    Object.keys(ROOM_CONFIGS).forEach(type => {
        stats[type] = 0;
    });

    rooms.forEach(room => {
        stats[room.roomType] += room.getUserCount();
    });

    return stats;
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    let currentRoom = null;

    // Send initial room stats
    socket.emit('room-stats', getRoomStats());

    socket.on('join-room', (data) => {
        // Clean up previous room if any
        if (currentRoom) {
            currentRoom.removeUser(socket.id);
            socket.to(`room-${currentRoom.id}`).emit('user-left', socket.id);
            io.to(`room-${currentRoom.id}`).emit('queue-updated', currentRoom.queue);
            io.to(`room-${currentRoom.id}`).emit('audience-updated', currentRoom.getAudience());
            if (!currentRoom.isEmpty()) {
                io.to(`room-${currentRoom.id}`).emit('skip-votes-updated', {
                    votes: currentRoom.skipVotes.size,
                    needed: currentRoom.getSkipVotesNeeded()
                });
            }
            socket.leave(`room-${currentRoom.id}`);
            if (currentRoom.isEmpty()) {
                rooms.delete(currentRoom.id);
            }
        }

        const roomType = data.roomType || 'conference';
        currentRoom = findOrCreateRoom(roomType);
        socket.join(`room-${currentRoom.id}`);

        currentRoom.addUser(socket.id);

        socket.to(`room-${currentRoom.id}`).emit('user-joined', socket.id);
        socket.to(`room-${currentRoom.id}`).emit('name-assigned', {
            userId: socket.id,
            name: currentRoom.getName(socket.id)
        });

        socket.emit('room-joined', {
            roomId: currentRoom.id,
            roomType: currentRoom.roomType,
            queue: currentRoom.queue,
            audience: currentRoom.getAudience(),
            hasStarted: currentRoom.hasStarted,
            duration: currentRoom.config.duration,
            yourName: currentRoom.getName(socket.id),
            names: Object.fromEntries(currentRoom.nameMap)
        });

        io.to(`room-${currentRoom.id}`).emit('queue-updated', currentRoom.queue);
        io.to(`room-${currentRoom.id}`).emit('audience-updated', currentRoom.getAudience());

        // Broadcast updated room stats to all users
        io.emit('room-stats', getRoomStats());

        if (currentRoom.hasStarted) {
            const currentSpeaker = currentRoom.getCurrentSpeaker();
            if (currentSpeaker) {
                socket.emit('speaker-changed', {
                    speakerId: currentSpeaker.id,
                    remainingTime: currentRoom.getRemainingTime()
                });
            }
        } else {
            // Send start vote status
            io.to(`room-${currentRoom.id}`).emit('start-votes-updated', {
                votes: currentRoom.startVotes.size,
                needed: currentRoom.config.minVotesToStart,
                hasStarted: false
            });
        }

        io.to(`room-${currentRoom.id}`).emit('skip-votes-updated', {
            votes: currentRoom.skipVotes.size,
            needed: currentRoom.getSkipVotesNeeded()
        });
    });

    socket.on('vote-to-start', () => {
        if (currentRoom && !currentRoom.hasStarted) {
            const result = currentRoom.voteToStart(socket.id);
            if (!result) return;

            if (result.started) {
                const speaker = currentRoom.getCurrentSpeaker();
                if (speaker) {
                    io.to(`room-${currentRoom.id}`).emit('room-started', {
                        speakerId: speaker.id,
                        remainingTime: currentRoom.getRemainingTime()
                    });
                }
            } else {
                io.to(`room-${currentRoom.id}`).emit('start-votes-updated', {
                    votes: result.votes,
                    needed: result.needed,
                    hasStarted: false
                });
            }
        }
    });

    socket.on('join-queue', () => {
        if (currentRoom) {
            const result = currentRoom.joinQueue(socket.id);
            const inQueue = currentRoom.queue.some(u => u.id === socket.id);
            socket.emit('queue-status', { inQueue });
            io.to(`room-${currentRoom.id}`).emit('queue-updated', currentRoom.queue);
            io.to(`room-${currentRoom.id}`).emit('audience-updated', currentRoom.getAudience());

            // If joining the queue triggered auto-start
            if (result && result.autoStarted) {
                const speaker = currentRoom.getCurrentSpeaker();
                if (speaker) {
                    io.to(`room-${currentRoom.id}`).emit('room-started', {
                        speakerId: speaker.id,
                        remainingTime: currentRoom.getRemainingTime()
                    });
                }
            }
        } else {
            socket.emit('queue-status', { inQueue: false });
        }
    });

    socket.on('leave-queue', () => {
        if (currentRoom) {
            const wasSpeaking = currentRoom.getCurrentSpeaker()?.id === socket.id;
            currentRoom.leaveQueue(socket.id);
            socket.emit('queue-status', { inQueue: false });
            io.to(`room-${currentRoom.id}`).emit('queue-updated', currentRoom.queue);
            io.to(`room-${currentRoom.id}`).emit('audience-updated', currentRoom.getAudience());

            if (wasSpeaking && currentRoom.hasStarted && currentRoom.queue.length > 0) {
                const newSpeaker = currentRoom.getCurrentSpeaker();
                io.to(`room-${currentRoom.id}`).emit('speaker-changed', {
                    speakerId: newSpeaker.id,
                    remainingTime: currentRoom.getRemainingTime()
                });
            }
        } else {
            socket.emit('queue-status', { inQueue: false });
        }
    });

    socket.on('leave-room', () => {
        if (currentRoom) {
            const wasSpeaking = currentRoom.getCurrentSpeaker()?.id === socket.id;

            currentRoom.removeUser(socket.id);
            socket.to(`room-${currentRoom.id}`).emit('user-left', socket.id);

            io.to(`room-${currentRoom.id}`).emit('queue-updated', currentRoom.queue);
            io.to(`room-${currentRoom.id}`).emit('audience-updated', currentRoom.getAudience());

            if (wasSpeaking && currentRoom.hasStarted && currentRoom.queue.length > 0) {
                const newSpeaker = currentRoom.getCurrentSpeaker();
                io.to(`room-${currentRoom.id}`).emit('speaker-changed', {
                    speakerId: newSpeaker.id,
                    remainingTime: currentRoom.getRemainingTime()
                });
            }

            // Update skip vote count for remaining users
            if (!currentRoom.isEmpty()) {
                io.to(`room-${currentRoom.id}`).emit('skip-votes-updated', {
                    votes: currentRoom.skipVotes.size,
                    needed: currentRoom.getSkipVotesNeeded()
                });
            }

            if (currentRoom.isEmpty()) {
                rooms.delete(currentRoom.id);
            }

            socket.leave(`room-${currentRoom.id}`);

            // Broadcast updated room stats
            io.emit('room-stats', getRoomStats());

            currentRoom = null;
        }
    });

    socket.on('vote-skip', () => {
        if (currentRoom && currentRoom.hasStarted) {
            const voteData = currentRoom.voteSkip(socket.id);

            io.to(`room-${currentRoom.id}`).emit('skip-votes-updated', voteData);

            if (currentRoom.skipVotes.size === 0) {
                const newSpeaker = currentRoom.getCurrentSpeaker();
                if (newSpeaker) {
                    io.to(`room-${currentRoom.id}`).emit('speaker-changed', {
                        speakerId: newSpeaker.id
                    });
                    io.to(`room-${currentRoom.id}`).emit('queue-updated', currentRoom.queue);
                    io.to(`room-${currentRoom.id}`).emit('audience-updated', currentRoom.getAudience());
                }
            }
        }
    });

    socket.on('time-expired', () => {
        if (currentRoom && currentRoom.hasStarted) {
            const currentSpeaker = currentRoom.getCurrentSpeaker();

            // Verify this user is actually the current speaker
            if (currentSpeaker && currentSpeaker.id === socket.id) {
                console.log(`Time expired for speaker ${socket.id}, moving to next`);

                currentRoom.nextSpeaker();
                const newSpeaker = currentRoom.getCurrentSpeaker();

                if (newSpeaker) {
                    io.to(`room-${currentRoom.id}`).emit('speaker-changed', {
                        speakerId: newSpeaker.id
                    });
                    io.to(`room-${currentRoom.id}`).emit('queue-updated', currentRoom.queue);
                    io.to(`room-${currentRoom.id}`).emit('audience-updated', currentRoom.getAudience());
                }
            }
        }
    });

    // Chat
    socket.on('chat-message', (data) => {
        if (!currentRoom) return;
        const text = (typeof data.text === 'string' ? data.text : '').trim().slice(0, 300);
        if (!text) return;
        // Basic sanitization: strip HTML tags
        const sanitized = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        io.to(`room-${currentRoom.id}`).emit('chat-message', {
            userId: socket.id,
            name: currentRoom.getName(socket.id),
            text: sanitized,
            timestamp: Date.now()
        });
    });

    // WebRTC signaling
    socket.on('offer', (data) => {
        socket.to(data.to).emit('offer', {
            from: socket.id,
            offer: data.offer
        });
    });

    socket.on('answer', (data) => {
        socket.to(data.to).emit('answer', {
            from: socket.id,
            answer: data.answer
        });
    });

    socket.on('ice-candidate', (data) => {
        socket.to(data.to).emit('ice-candidate', {
            from: socket.id,
            candidate: data.candidate
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        if (currentRoom) {
            const wasSpeaking = currentRoom.getCurrentSpeaker()?.id === socket.id;

            currentRoom.removeUser(socket.id);
            socket.to(`room-${currentRoom.id}`).emit('user-left', socket.id);
            io.to(`room-${currentRoom.id}`).emit('queue-updated', currentRoom.queue);
            io.to(`room-${currentRoom.id}`).emit('audience-updated', currentRoom.getAudience());

            if (wasSpeaking && currentRoom.hasStarted && currentRoom.queue.length > 0) {
                const newSpeaker = currentRoom.getCurrentSpeaker();
                io.to(`room-${currentRoom.id}`).emit('speaker-changed', {
                    speakerId: newSpeaker.id,
                    remainingTime: currentRoom.getRemainingTime()
                });
            }

            if (!currentRoom.isEmpty()) {
                io.to(`room-${currentRoom.id}`).emit('skip-votes-updated', {
                    votes: currentRoom.skipVotes.size,
                    needed: currentRoom.getSkipVotesNeeded()
                });
            }

            if (currentRoom.isEmpty()) {
                rooms.delete(currentRoom.id);
            }

            // Broadcast updated room stats
            io.emit('room-stats', getRoomStats());
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});