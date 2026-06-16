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
    transitionInterval: null,
    hasVotedSkip: false,
    hasVotedStart: false,
    hasStarted: false,
    maxDuration: 600,
    isCameraOn: false,
    isMicOn: false,
    inQueue: false,
    myName: null,
    names: {}
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
const joinQueueBtn = document.getElementById('joinQueueBtn');
const audienceListEl = document.getElementById('audienceList');
const cameraMenu = document.getElementById('cameraMenu');
const micMenu = document.getElementById('micMenu');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatMessages = document.getElementById('chatMessages');

const speakerTransition = document.getElementById('speakerTransition');
const transitionNameEl = speakerTransition.querySelector('.transition-name');
const transitionCountdownEl = speakerTransition.querySelector('.transition-countdown');

const VALID_ROOMS = ['conference', 'stage', 'concert', 'classroom', 'casual'];

async function autoJoinFromUrl() {
    const roomType = window.location.pathname.slice(1).toLowerCase();
    if (!VALID_ROOMS.includes(roomType)) return;

    const hasMedia = await getUserMedia();
    if (hasMedia) {
        state.roomType = roomType;
        state.socket.emit('join-room', { roomType });
    }
}

function displayName(userId) {
    const name = state.names[userId] || `User ${userId.slice(-4)}`;
    if (userId === state.userId) return `${name} (you)`;
    return name;
}

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
        const wasInRoom = state.roomType && room.style.display === 'flex';
        state.userId = state.socket.id;

        // Close stale peer connections from before reconnect
        state.peers.forEach(pc => pc.close());
        state.peers.clear();

        if (wasInRoom && state.localStream) {
            // Reconnect: re-join the same room with existing stream
            state.socket.emit('join-room', { roomType: state.roomType });
        } else if (window.location.pathname.length > 1) {
            // Fresh page load with room URL
            autoJoinFromUrl();
        }
    });

    state.socket.on('room-stats', (stats) => {
        updateRoomStats(stats);
    });

    state.socket.on('room-joined', (data) => {
        state.roomId = data.roomId;
        state.roomType = data.roomType;
        state.hasStarted = data.hasStarted;
        state.maxDuration = data.duration;
        state.myName = data.yourName;
        state.names = data.names || {};

        roomIdDisplay.textContent = getRoomTypeLabel(data.roomType);
        audienceContainer.innerHTML = '';
        chatMessages.innerHTML = '';
        state.inQueue = false;
        state.hasVotedStart = false;
        state.hasVotedSkip = false;
        joinQueueBtn.textContent = 'Join Queue';
        joinQueueBtn.classList.remove('off');
        voteStartBtn.disabled = false;
        skipBtn.disabled = false;
        skipBtn.textContent = 'Vote to Skip';
        updateQueue(data.queue);
        updateAudience(data.audience);

        // Sync camera/mic button states with actual track state (preserves across reconnect)
        if (state.localStream) {
            const videoTrack = state.localStream.getVideoTracks()[0];
            const audioTrack = state.localStream.getAudioTracks()[0];
            if (videoTrack) {
                state.isCameraOn = videoTrack.enabled;
                cameraToggleBtn.textContent = state.isCameraOn ? 'Camera ON' : 'Camera OFF';
                cameraToggleBtn.classList.toggle('off', !state.isCameraOn);
            }
            if (audioTrack) {
                state.isMicOn = audioTrack.enabled;
                micToggleBtn.textContent = state.isMicOn ? 'Mic ON' : 'Mic OFF';
                micToggleBtn.classList.toggle('off', !state.isMicOn);
            }
        }

        showRoom();
        if (window.location.pathname !== `/${data.roomType}`) {
            history.pushState({ roomType: data.roomType }, '', `/${data.roomType}`);
        }

        if (!data.hasStarted) {
            voteStartBtn.classList.remove('hidden');
        }
    });

    state.socket.on('queue-updated', (queue) => {
        updateQueue(queue);
    });

    state.socket.on('audience-updated', (audience) => {
        updateAudience(audience);
    });

    state.socket.on('start-votes-updated', (data) => {
        if (!data.hasStarted) {
            voteStartBtn.textContent = `Vote to Start (${data.votes}/${data.needed})`;
        }
    });

    state.socket.on('room-started', (data) => {
        state.hasStarted = true;
        voteStartBtn.classList.add('hidden');
        dismissTransition();
        updateSpeakerDisplay({ speakerId: data.speakerId });
        startTimer(data.remainingTime);
    });

    state.socket.on('speaker-transition', (data) => {
        // Show the transition overlay
        transitionNameEl.textContent = data.name;
        transitionCountdownEl.textContent = data.duration;
        speakerTransition.classList.add('active');

        // Stop the current timer display
        if (state.timerInterval) clearInterval(state.timerInterval);
        timerDisplay.textContent = '';
        timerDisplay.style.color = '';

        // Client-side countdown on the overlay
        if (state.transitionInterval) clearInterval(state.transitionInterval);
        let count = data.duration;
        state.transitionInterval = setInterval(() => {
            count--;
            if (count <= 0) {
                clearInterval(state.transitionInterval);
                state.transitionInterval = null;
                transitionCountdownEl.textContent = '';
            } else {
                transitionCountdownEl.textContent = count;
            }
        }, 1000);
    });

    state.socket.on('speaker-changed', (data) => {
        dismissTransition();
        state.hasVotedSkip = false;
        updateSpeakerDisplay(data);
        startTimer(data.remainingTime);
        updateSkipButton();
    });

    state.socket.on('skip-votes-updated', (data) => {
        skipCountDisplay.textContent = data.votes;
        skipNeededDisplay.textContent = data.needed;
    });

    state.socket.on('user-left', (userId) => {
        delete state.names[userId];
        removePeer(userId);
        // Also remove from speaker display if they were speaking
        if (state.currentSpeaker === userId) {
            speakerVideo.srcObject = null;
            speakerName.textContent = 'Waiting for speaker...';
            state.currentSpeaker = null;
        }
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

    state.socket.on('queue-status', (data) => {
        state.inQueue = data.inQueue;
        if (state.inQueue) {
            joinQueueBtn.textContent = 'Leave Queue';
            joinQueueBtn.classList.add('off');
        } else {
            joinQueueBtn.textContent = 'Join Queue';
            joinQueueBtn.classList.remove('off');
        }
    });

    state.socket.on('name-assigned', (data) => {
        state.names[data.userId] = data.name;
    });

    // Chat messages
    state.socket.on('chat-message', (data) => {
        const name = data.name || state.names[data.userId] || `User ${data.userId.slice(-4)}`;
        const msg = document.createElement('div');
        msg.className = 'chat-msg';
        msg.innerHTML = `<span class="chat-user">${name}</span><span class="chat-text">${data.text}</span>`;
        chatMessages.appendChild(msg);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

function isVirtualCamera(label) {
    const l = label.toLowerCase();
    return l.includes('virtual') || l.includes('obs') || l.includes('manycam')
        || l.includes('snap camera') || l.includes('xsplit') || l.includes('mmhmm');
}

// Get user media (camera/mic)
async function getUserMedia() {
    try {
        state.localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });

        // Block virtual cameras (OBS, ManyCam, etc.)
        const devices = await navigator.mediaDevices.enumerateDevices();
        const physicalCameras = devices.filter(d =>
            d.kind === 'videoinput' && !isVirtualCamera(d.label)
        );

        if (physicalCameras.length === 0) {
            state.localStream.getTracks().forEach(t => t.stop());
            state.localStream = null;
            alert('No physical camera detected. Virtual cameras are not allowed.');
            return false;
        }

        // If the default picked a virtual camera, swap to a physical one
        const videoTrack = state.localStream.getVideoTracks()[0];
        if (videoTrack && isVirtualCamera(videoTrack.label)) {
            const betterStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: physicalCameras[0].deviceId } },
                audio: false
            });
            const newTrack = betterStream.getVideoTracks()[0];
            state.localStream.removeTrack(videoTrack);
            state.localStream.addTrack(newTrack);
            videoTrack.stop();
        }

        state.localStream.getVideoTracks().forEach(t => t.enabled = false);
        state.localStream.getAudioTracks().forEach(t => t.enabled = false);
        state.isCameraOn = false;
        state.isMicOn = false;
        cameraToggleBtn.textContent = 'Camera OFF';
        cameraToggleBtn.classList.add('off');
        micToggleBtn.textContent = 'Mic OFF';
        micToggleBtn.classList.add('off');
        await populateDevices();
        return true;
    } catch (err) {
        console.error('Error accessing media devices:', err);
        alert('Please allow camera and microphone access');
        return false;
    }
}

async function populateDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput' && !isVirtualCamera(d.label));
    const audioDevices = devices.filter(d => d.kind === 'audioinput');

    const currentVideoId = state.localStream?.getVideoTracks()[0]?.getSettings().deviceId;
    const currentAudioId = state.localStream?.getAudioTracks()[0]?.getSettings().deviceId;

    buildMenu(cameraMenu, videoDevices, currentVideoId, 'video');
    buildMenu(micMenu, audioDevices, currentAudioId, 'audio');
}

function buildMenu(menu, devices, activeId, kind) {
    menu.innerHTML = '';
    devices.forEach((d, i) => {
        const item = document.createElement('div');
        item.className = 'device-menu-item';
        if (d.deviceId === activeId) item.classList.add('active');
        item.textContent = d.label || `${kind === 'video' ? 'Camera' : 'Mic'} ${i + 1}`;
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            switchDevice(kind, d.deviceId);
            menu.classList.remove('open');
        });
        menu.appendChild(item);
    });
}

async function switchDevice(kind, deviceId) {
    const isVideo = kind === 'video';
    const constraints = isVideo
        ? { video: { deviceId: { exact: deviceId } }, audio: false }
        : { video: false, audio: { deviceId: { exact: deviceId } } };

    try {
        const tempStream = await navigator.mediaDevices.getUserMedia(constraints);
        const newTrack = tempStream.getTracks()[0];
        const oldTrack = isVideo
            ? state.localStream.getVideoTracks()[0]
            : state.localStream.getAudioTracks()[0];

        // Preserve enabled state
        newTrack.enabled = isVideo ? state.isCameraOn : state.isMicOn;

        // Replace in local stream
        if (oldTrack) state.localStream.removeTrack(oldTrack);
        state.localStream.addTrack(newTrack);
        oldTrack?.stop();

        // Replace in all peer connections
        state.peers.forEach(pc => {
            const sender = pc.getSenders().find(s =>
                s.track && s.track.kind === (isVideo ? 'video' : 'audio')
            );
            if (sender) sender.replaceTrack(newTrack);
        });

        // Update local video display if switching camera
        if (isVideo && state.currentSpeaker === state.userId) {
            speakerVideo.srcObject = state.localStream;
        }

        // Update active state in menu
        const menu = isVideo ? cameraMenu : micMenu;
        menu.querySelectorAll('.device-menu-item').forEach(el => el.classList.remove('active'));
        const items = menu.querySelectorAll('.device-menu-item');
        const devices = (await navigator.mediaDevices.enumerateDevices())
            .filter(d => d.kind === (isVideo ? 'videoinput' : 'audioinput'));
        devices.forEach((d, i) => {
            if (d.deviceId === deviceId && items[i]) items[i].classList.add('active');
        });
    } catch (err) {
        console.error(`Error switching ${kind} device:`, err);
    }
}

// Split button arrow toggles
document.querySelectorAll('.split-btn-arrow').forEach(arrow => {
    arrow.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = arrow.parentElement.querySelector('.device-menu');
        document.querySelectorAll('.device-menu.open').forEach(m => {
            if (m !== menu) m.classList.remove('open');
        });
        menu.classList.toggle('open');
    });
});

// Close menus when clicking elsewhere
document.addEventListener('click', () => {
    document.querySelectorAll('.device-menu.open').forEach(m => m.classList.remove('open'));
});

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
        addToAudienceGrid(userId, stream);
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
            if (count === 0) {
                userCountEl.innerHTML = '<span class="pulse-dot"></span> Join now';
            } else {
                userCountEl.innerHTML = `<span class="pulse-dot active"></span> ${count} online`;
            }
        }
    });
}

function showRoom() {
    landing.classList.add('hidden');
    room.style.display = 'flex';

    const speaker = document.getElementById('speaker');
    speaker.className = '';
    if (state.roomType) {
        speaker.classList.add(state.roomType);
    }

    if (state.localStream) {
        speakerVideo.srcObject = state.localStream;
        speakerVideo.muted = true;
    }
}

function showLanding(skipToVenues) {
    room.style.display = 'none';
    landing.classList.remove('hidden');
    if (skipToVenues) {
        document.querySelector('.hero').style.display = 'none';
        window.scrollTo(0, 0);
    }
}

function updateQueue(queue) {
    state.queue = queue;
    queueList.innerHTML = '';

    queue.forEach((user, index) => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        if (index === 0) item.classList.add('active');

        item.innerHTML = `
            <span>${displayName(user.id)}</span>
            <span class="queue-position">${index === 0 ? 'Speaking' : `#${index}`}</span>
        `;
        queueList.appendChild(item);
    });
}

function updateAudience(audience) {
    audienceListEl.innerHTML = '';
    audience.forEach(user => {
        const item = document.createElement('div');
        item.className = 'audience-item';
        item.textContent = displayName(user.id);
        audienceListEl.appendChild(item);
    });
}

function getStreamFromPeer(userId) {
    const pc = state.peers.get(userId);
    if (!pc) return null;
    const receivers = pc.getReceivers();
    if (receivers.length === 0) return null;
    const stream = new MediaStream();
    receivers.forEach(r => { if (r.track) stream.addTrack(r.track); });
    return stream.getTracks().length > 0 ? stream : null;
}

function addToAudienceGrid(userId, stream) {
    if (!stream) return;
    let videoEl = document.getElementById(`audience-${userId}`);
    if (!videoEl) {
        const container = document.createElement('div');
        container.className = 'audience-video';
        container.id = `container-${userId}`;
        container.innerHTML = `
            <video id="audience-${userId}" autoplay playsinline></video>
            <div class="audience-name">${displayName(userId)}</div>
        `;
        audienceContainer.appendChild(container);
        videoEl = document.getElementById(`audience-${userId}`);
    }
    videoEl.srcObject = stream;
    videoEl.muted = (userId === state.userId);
}

function updateSpeakerDisplay(data) {
    const oldSpeaker = state.currentSpeaker;
    state.currentSpeaker = data.speakerId;
    speakerName.textContent = displayName(data.speakerId);

    // Remove new speaker from audience grid (they're on stage now)
    const newSpeakerContainer = document.getElementById(`container-${data.speakerId}`);
    if (newSpeakerContainer) newSpeakerContainer.remove();

    // Move old speaker back to audience grid
    if (oldSpeaker && oldSpeaker !== data.speakerId) {
        if (oldSpeaker === state.userId) {
            addToAudienceGrid(oldSpeaker, state.localStream);
        } else {
            const stream = getStreamFromPeer(oldSpeaker);
            if (stream) addToAudienceGrid(oldSpeaker, stream);
        }
    }

    // Set speaker video
    if (data.speakerId === state.userId) {
        speakerVideo.srcObject = state.localStream;
        speakerVideo.muted = true;
        // Remove self from audience grid since we're on stage
        const selfContainer = document.getElementById(`container-${state.userId}`);
        if (selfContainer) selfContainer.remove();
    } else {
        const stream = getStreamFromPeer(data.speakerId);
        if (stream) {
            speakerVideo.srcObject = stream;
            speakerVideo.muted = false;
        }
        // Ensure local user has a self-view in audience grid
        if (state.localStream && !document.getElementById(`container-${state.userId}`)) {
            addToAudienceGrid(state.userId, state.localStream);
        }
    }
}

function dismissTransition() {
    speakerTransition.classList.remove('active');
    if (state.transitionInterval) {
        clearInterval(state.transitionInterval);
        state.transitionInterval = null;
    }
}

function startTimer(remainingTime) {
    if (state.timerInterval) clearInterval(state.timerInterval);

    let secondsLeft = remainingTime != null ? remainingTime : state.maxDuration;
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
        voteStartBtn.textContent = 'Vote Counted';
    }
});

joinQueueBtn.addEventListener('click', () => {
    if (state.inQueue) {
        state.socket.emit('leave-queue');
    } else {
        state.socket.emit('join-queue');
    }
});

leaveBtn.addEventListener('click', () => {
    state.socket.emit('leave-room');
    state.inQueue = false;

    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
    }
    state.peers.forEach(pc => pc.close());
    state.peers.clear();
    state.names = {};
    if (state.timerInterval) clearInterval(state.timerInterval);
    dismissTransition();

    // Clear stale DOM elements
    audienceContainer.innerHTML = '';
    chatMessages.innerHTML = '';
    queueList.innerHTML = '';
    audienceListEl.innerHTML = '';
    speakerVideo.srcObject = null;

    showLanding(true);
    if (window.location.pathname !== '/') {
        history.pushState(null, '', '/');
    }
});

skipBtn.addEventListener('click', () => {
    if (!state.hasVotedSkip) {
        state.socket.emit('vote-skip');
        state.hasVotedSkip = true;
        updateSkipButton();
    }
});

chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    state.socket.emit('chat-message', { text });
    chatInput.value = '';
});

function getRoomTypeLabel(type) {
    const labels = {
        conference: 'Conference',
        stage: 'Stage',
        concert: 'Concert',
        classroom: 'Classroom',
        casual: 'Casual'
    };
    return labels[type] || type;
}

const roomBackgrounds = {
    conference: 'images/conferencehall.jpg',
    stage: 'images/theatre.avif',
    concert: 'images/concert.avif',
    classroom: 'images/classroom.avif',
    casual: 'images/coffeeshop.avif'
};

// Media controls
cameraToggleBtn.addEventListener('click', () => {
    if (state.localStream) {
        const videoTrack = state.localStream.getVideoTracks()[0];
        if (videoTrack) {
            state.isCameraOn = !state.isCameraOn;
            videoTrack.enabled = state.isCameraOn;

            if (state.isCameraOn) {
                cameraToggleBtn.textContent = 'Camera ON';
                cameraToggleBtn.classList.remove('off');
            } else {
                cameraToggleBtn.textContent = 'Camera OFF';
                cameraToggleBtn.classList.add('off');
            }

            // Update local video display
            if (state.currentSpeaker === state.userId) {
                speakerVideo.classList.toggle('camera-off', !state.isCameraOn);
            } else {
                const container = document.getElementById(`container-${state.userId}`);
                if (container) {
                    const bg = roomBackgrounds[state.roomType] || '';
                    container.classList.toggle('camera-off', !state.isCameraOn);
                    container.style.backgroundImage = !state.isCameraOn && bg ? `url('${bg}')` : '';
                }
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
                micToggleBtn.textContent = 'Mic ON';
                micToggleBtn.classList.remove('off');
            } else {
                micToggleBtn.textContent = 'Mic OFF';
                micToggleBtn.classList.add('off');
            }
        }
    }
});

// Collapsible panels on mobile
document.querySelectorAll('.panel-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        toggle.nextElementSibling.classList.toggle('collapsed', expanded);
    });
});

// Initialize
initSocket();

// Handle browser back/forward
window.addEventListener('popstate', () => {
    if (room.style.display === 'flex') {
        leaveBtn.click();
    }
});