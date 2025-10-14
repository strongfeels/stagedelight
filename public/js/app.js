// Client-side application logic
const state = {
    socket: null,
    roomId: null,
    roomType: null,
    userId: null,
    localStream: null,
    peers: new Map(),
    currentSpeaker: null,
    queue: [],
    timerInterval: null,
    hasVotedSkip: false,
    hasVotedStart: false,
    hasStarted: false,
    maxDuration: 600,
    isCameraOn: true,
    isMicOn: true
};

// DOM elements
const landing = document.getElementById('landing');
const room = document.getElementById('room');
const roomCards = document.querySelectorAll('.room-card');
const voteStartBtn = document.getElementById('voteStartBtn');
const leaveBtn = document.getElementById('leaveBtn');
const skipBtn = document.getElementById('skipBtn');
const speakerVideo = document.getElementById('speakerVideo');
const speakerName = document.getElementById('speakerName');
const audienceContainer = document.getElementById('audience');
const queueList = document.getElementById('queueList');
const timerDisplay = document.getElementById('timer');
const skipCountDisplay = document.getElementById('skipCount');
const skipNeededDisplay = document.getElementById('skipNeeded');
const roomIdDisplay = document.getElementById('roomId');
const cameraToggleBtn = document.getElementById('cameraToggleBtn');
const micToggleBtn = document.getElementById('micToggleBtn');

// Room type selection
roomCards.forEach(card => {
    card.addEventListener('click', async () => {
        roomCards.forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');

        state.roomType = card.dataset.roomType;

        const hasMedia = await getUserMedia();
        if (hasMedia) {
            state.socket.emit('join-room', { roomType: state.roomType });
        }
    });
});

// Initialize Socket.io connection
function initSocket() {
    state.socket = io();

    state.socket.on('connect', () => {
        console.log('Connected to server');
        state.userId = state.socket.id;
    });

    state.socket.on('room-stats', (stats) => {
        updateRoomStats(stats);
    });

    state.socket.on('room-joined', (data) => {
        state.roomId = data.roomId;
        state.roomType = data.roomType;
        state.hasStarted = data.hasStarted;
        state.maxDuration = data.duration;

        roomIdDisplay.textContent = `${data.roomId} (${getRoomTypeLabel(data.roomType)})`;
        updateQueue(data.queue);
        showRoom();

        if (!data.hasStarted) {
            voteStartBtn.classList.remove('hidden');
        }
    });

    state.socket.on('queue-updated', (queue) => {
        updateQueue(queue);
    });

    state.socket.on('start-votes-updated', (data) => {
        if (!data.hasStarted) {
            voteStartBtn.textContent = `Vote to Start (${data.votes}/${data.needed})`;
        }
    });

    state.socket.on('room-started', (data) => {
        state.hasStarted = true;
        voteStartBtn.classList.add('hidden');
        state.currentSpeaker = data.speakerId;
        updateSpeakerDisplay({ speakerId: data.speakerId });
        startTimer();
    });

    state.socket.on('speaker-changed', (data) => {
        state.currentSpeaker = data.speakerId;
        state.hasVotedSkip = false;
        updateSpeakerDisplay(data);
        startTimer();
        updateSkipButton();
    });

    state.socket.on('skip-votes-updated', (data) => {
        skipCountDisplay.textContent = data.votes;
        skipNeededDisplay.textContent = data.needed;
    });

    state.socket.on('user-left', (userId) => {
        removePeer(userId);
    });

    // WebRTC signaling
    state.socket.on('user-joined', async (userId) => {
        await createPeerConnection(userId, true);
    });

    state.socket.on('offer', async (data) => {
        await handleOffer(data);
    });

    state.socket.on('answer', async (data) => {
        await handleAnswer(data);
    });

    state.socket.on('ice-candidate', async (data) => {
        await handleIceCandidate(data);
    });
}

// Get user media (camera/mic)
async function getUserMedia() {
    try {
        state.localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        return true;
    } catch (err) {
        console.error('Error accessing media devices:', err);
        alert('Please allow camera and microphone access');
        return false;
    }
}

// WebRTC Functions
async function createPeerConnection(userId, isInitiator) {
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    state.localStream.getTracks().forEach(track => {
        pc.addTrack(track, state.localStream);
    });

    pc.ontrack = (event) => {
        addRemoteStream(userId, event.streams[0]);
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            state.socket.emit('ice-candidate', {
                to: userId,
                candidate: event.candidate
            });
        }
    };

    state.peers.set(userId, pc);

    if (isInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        state.socket.emit('offer', {
            to: userId,
            offer: offer
        });
    }

    return pc;
}

async function handleOffer(data) {
    let pc = state.peers.get(data.from);
    if (!pc) {
        pc = await createPeerConnection(data.from, false);
    }
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    state.socket.emit('answer', {
        to: data.from,
        answer: answer
    });
}

async function handleAnswer(data) {
    const pc = state.peers.get(data.from);
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
}

async function handleIceCandidate(data) {
    const pc = state.peers.get(data.from);
    if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
}

function addRemoteStream(userId, stream) {
    if (userId === state.currentSpeaker) {
        speakerVideo.srcObject = stream;
        speakerVideo.muted = false;
    } else {
        let videoEl = document.getElementById(`audience-${userId}`);
        if (!videoEl) {
            const container = document.createElement('div');
            container.className = 'audience-video';
            container.id = `container-${userId}`;
            container.innerHTML = `
                <video id="audience-${userId}" autoplay playsinline></video>
                <div class="audience-name">User ${userId.slice(-4)}</div>
            `;
            audienceContainer.appendChild(container);
            videoEl = document.getElementById(`audience-${userId}`);
        }
        videoEl.srcObject = stream;
        videoEl.muted = (userId === state.userId);
    }
}

function removePeer(userId) {
    const pc = state.peers.get(userId);
    if (pc) {
        pc.close();
        state.peers.delete(userId);
    }

    const container = document.getElementById(`container-${userId}`);
    if (container) {
        container.remove();
    }
}

// UI Functions
function updateRoomStats(stats) {
    Object.keys(stats).forEach(roomType => {
        const userCountEl = document.querySelector(`.room-users[data-type="${roomType}"]`);
        if (userCountEl) {
            const count = stats[roomType];
            userCountEl.textContent = `${count} ${count === 1 ? 'user' : 'users'}`;
        }
    });
}

function showRoom() {
    landing.classList.add('hidden');
    room.style.display = 'flex';

    if (state.localStream) {
        speakerVideo.srcObject = state.localStream;
        speakerVideo.muted = true;
    }
}

function showLanding() {
    room.style.display = 'none';
    landing.classList.remove('hidden');
}

function updateQueue(queue) {
    state.queue = queue;
    queueList.innerHTML = '';

    queue.forEach((user, index) => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        if (index === 0) item.classList.add('active');

        const isYou = user.id === state.userId;
        item.innerHTML = `
            <span>${isYou ? 'You' : `User ${user.id.slice(-4)}`}</span>
            <span class="queue-position">${index === 0 ? 'Speaking' : `#${index}`}</span>
        `;
        queueList.appendChild(item);
    });
}

function updateSpeakerDisplay(data) {
    const isYou = data.speakerId === state.userId;
    speakerName.textContent = isYou ? 'You (Speaking)' : `User ${data.speakerId.slice(-4)}`;

    state.currentSpeaker = data.speakerId;

    if (data.speakerId === state.userId) {
        speakerVideo.srcObject = state.localStream;
        speakerVideo.muted = true;
    } else {
        setTimeout(() => {
            const pc = state.peers.get(data.speakerId);
            if (pc) {
                const receivers = pc.getReceivers();
                if (receivers.length > 0) {
                    const stream = new MediaStream();
                    receivers.forEach(receiver => {
                        if (receiver.track) {
                            stream.addTrack(receiver.track);
                        }
                    });
                    if (stream.getTracks().length > 0) {
                        speakerVideo.srcObject = stream;
                        speakerVideo.muted = false;
                    }
                }
            }
        }, 100);
    }
}

function startTimer() {
    if (state.timerInterval) clearInterval(state.timerInterval);

    let secondsLeft = state.maxDuration;
    const warningTime = 120; // 2 minutes warning

    // Display initial time
    const mins = Math.floor(secondsLeft / 60);
    const secs = secondsLeft % 60;
    timerDisplay.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    state.timerInterval = setInterval(() => {
        secondsLeft--;

        if (secondsLeft < 0) {
            clearInterval(state.timerInterval);
            timerDisplay.textContent = '00:00';
            timerDisplay.style.color = '#f44336';

            // Notify server that time is up (only if you're the speaker)
            if (state.currentSpeaker === state.userId) {
                state.socket.emit('time-expired');
            }
            return;
        }

        const mins = Math.floor(secondsLeft / 60);
        const secs = secondsLeft % 60;
        timerDisplay.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

        // Change color based on time remaining
        if (secondsLeft <= 0) {
            timerDisplay.style.color = '#f44336';
        } else if (secondsLeft <= warningTime) {
            timerDisplay.style.color = '#ff9800';
        } else {
            timerDisplay.style.color = '#4CAF50';
        }
    }, 1000);
}
function updateSkipButton() {
    if (state.hasVotedSkip) {
        skipBtn.disabled = true;
        skipBtn.textContent = 'Vote Counted';
    } else {
        skipBtn.disabled = false;
        skipBtn.textContent = 'Vote to Skip';
    }
}

// Event Handlers
voteStartBtn.addEventListener('click', () => {
    if (!state.hasVotedStart && !state.hasStarted) {
        state.socket.emit('vote-to-start');
        state.hasVotedStart = true;
        voteStartBtn.disabled = true;
    }
});

leaveBtn.addEventListener('click', () => {
    state.socket.emit('leave-room');

    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
    }
    state.peers.forEach(pc => pc.close());
    state.peers.clear();
    if (state.timerInterval) clearInterval(state.timerInterval);

    showLanding();
});

skipBtn.addEventListener('click', () => {
    if (!state.hasVotedSkip) {
        state.socket.emit('vote-skip');
        state.hasVotedSkip = true;
        updateSkipButton();
    }
});

function getRoomTypeLabel(type) {
    const labels = {
        conference: '💼 Conference',
        stage: '🎭 Stage',
        concert: '🎸 Concert',
        classroom: '🎓 Classroom',
        casual: '☕ Casual'
    };
    return labels[type] || type;
}

// Media controls
cameraToggleBtn.addEventListener('click', () => {
    if (state.localStream) {
        const videoTrack = state.localStream.getVideoTracks()[0];
        if (videoTrack) {
            state.isCameraOn = !state.isCameraOn;
            videoTrack.enabled = state.isCameraOn;

            if (state.isCameraOn) {
                cameraToggleBtn.textContent = '📹 Camera ON';
                cameraToggleBtn.classList.remove('off');
            } else {
                cameraToggleBtn.textContent = '📹 Camera OFF';
                cameraToggleBtn.classList.add('off');
            }
        }
    }
});

micToggleBtn.addEventListener('click', () => {
    if (state.localStream) {
        const audioTrack = state.localStream.getAudioTracks()[0];
        if (audioTrack) {
            state.isMicOn = !state.isMicOn;
            audioTrack.enabled = state.isMicOn;

            if (state.isMicOn) {
                micToggleBtn.textContent = '🎤 Mic ON';
                micToggleBtn.classList.remove('off');
            } else {
                micToggleBtn.textContent = '🎤 Mic OFF';
                micToggleBtn.classList.add('off');
            }
        }
    }
});

// Initialize
initSocket();