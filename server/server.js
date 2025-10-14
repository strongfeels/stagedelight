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
    stage: { duration: 12 * 60, label: '🎭 Theater Stage', minVotesToStart: 2 },
    concert: { duration: 6 * 60, label: '🎸 Concert', minVotesToStart: 2 },
    classroom: { duration: 9 * 60, label: '🎓 Classroom', minVotesToStart: 2 },
    casual: { duration: 3 * 60, label: '☕ Coffee Shop', minVotesToStart: 2 }
};

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
        this.startTimeout = null;
    }

    addUser(socketId) {
        this.users.set(socketId, {
            id: socketId,
            joinedAt: Date.now()
        });
        this.queue.push({ id: socketId });

        // Set timeout for auto-start after 5 minutes
        if (this.queue.length === 1 && !this.hasStarted) {
            this.startTimeout = setTimeout(() => {
                this.forceStart();
            }, 5 * 60 * 1000); // 5 minutes
        }
    }

    removeUser(socketId) {
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

        // Clear timeout if room becomes empty
        if (this.queue.length === 0 && this.startTimeout) {
            clearTimeout(this.startTimeout);
            this.startTimeout = null;
        }
    }

    voteToStart(socketId) {
        if (this.hasStarted) return null;

        this.startVotes.add(socketId);

        const needed = this.config.minVotesToStart;
        if (this.startVotes.size >= needed) {
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
        if (this.startTimeout) {
            clearTimeout(this.startTimeout);
            this.startTimeout = null;
        }
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
        return this.getCurrentSpeaker();
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
        if (room.roomType === roomType && room.users.size < 5) {
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
        const roomType = data.roomType || 'conference';
        currentRoom = findOrCreateRoom(roomType);
        socket.join(`room-${currentRoom.id}`);

        socket.to(`room-${currentRoom.id}`).emit('user-joined', socket.id);

        currentRoom.addUser(socket.id);

        socket.emit('room-joined', {
            roomId: currentRoom.id,
            roomType: currentRoom.roomType,
            queue: currentRoom.queue,
            hasStarted: currentRoom.hasStarted,
            duration: currentRoom.config.duration
        });

        io.to(`room-${currentRoom.id}`).emit('queue-updated', currentRoom.queue);

        // Broadcast updated room stats to all users
        io.emit('room-stats', getRoomStats());

        if (currentRoom.hasStarted) {
            const currentSpeaker = currentRoom.getCurrentSpeaker();
            if (currentSpeaker) {
                socket.emit('speaker-changed', {
                    speakerId: currentSpeaker.id
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

        socket.emit('skip-votes-updated', {
            votes: currentRoom.skipVotes.size,
            needed: currentRoom.getSkipVotesNeeded()
        });
    });

    socket.on('vote-to-start', () => {
        if (currentRoom && !currentRoom.hasStarted) {
            const result = currentRoom.voteToStart(socket.id);

            if (result.started) {
                const speaker = currentRoom.getCurrentSpeaker();
                io.to(`room-${currentRoom.id}`).emit('room-started', {
                    speakerId: speaker.id
                });
            } else {
                io.to(`room-${currentRoom.id}`).emit('start-votes-updated', {
                    votes: result.votes,
                    needed: result.needed,
                    hasStarted: false
                });
            }
        }
    });

    socket.on('leave-room', () => {
        if (currentRoom) {
            const wasSpeaking = currentRoom.getCurrentSpeaker()?.id === socket.id;

            currentRoom.removeUser(socket.id);
            socket.to(`room-${currentRoom.id}`).emit('user-left', socket.id);

            io.to(`room-${currentRoom.id}`).emit('queue-updated', currentRoom.queue);

            if (wasSpeaking && currentRoom.hasStarted && currentRoom.queue.length > 0) {
                const newSpeaker = currentRoom.getCurrentSpeaker();
                io.to(`room-${currentRoom.id}`).emit('speaker-changed', {
                    speakerId: newSpeaker.id
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
                }
            }
        }
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

            if (wasSpeaking && currentRoom.hasStarted && currentRoom.queue.length > 0) {
                const newSpeaker = currentRoom.getCurrentSpeaker();
                io.to(`room-${currentRoom.id}`).emit('speaker-changed', {
                    speakerId: newSpeaker.id
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