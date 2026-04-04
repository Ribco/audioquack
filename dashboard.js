// ==========================================
// AUDIOQUACK DASHBOARD - Real-time Control
// ==========================================

const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
});

let currentGuild = null;
let currentQueue = null;
let isPlaying = false;
let progressInterval = null;
let user = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
    setupSocketListeners();
    setupKeyboardShortcuts();
    
    // Fallback: hide loading screen after 2 seconds
    setTimeout(() => {
        document.getElementById('loading')?.classList.add('hidden');
    }, 2000);
});

// ================= AUTH =================
async function checkAuth() {
    try {
        const res = await fetch('/api/user', { credentials: 'include' });
        if (res.ok) {
            user = await res.json();
            showDashboard();
            loadGuilds();
            updateUserUI();
        } else {
            showLanding();
        }
    } catch {
        showLanding();
    }
    document.getElementById('loading')?.classList.add('hidden');
}

function showLanding() {
    document.getElementById('landing')?.style.setProperty('display', 'block');
    document.getElementById('dashboard')?.classList.remove('active');
    document.getElementById('userMenu')?.style.setProperty('display', 'none');
}

function showFeatures() {
    const features = document.getElementById('features');
    if (features.style.display === 'none' || features.style.display === '') {
        features.style.display = 'block';
        features.scrollIntoView({ behavior: 'smooth' });
    } else {
        features.style.display = 'none';
    }
}

function showCommands() {
    const commands = document.getElementById('commands');
    if (commands.style.display === 'none' || commands.style.display === '') {
        commands.style.display = 'block';
        commands.scrollIntoView({ behavior: 'smooth' });
    } else {
        commands.style.display = 'none';
    }
}

function showDashboard() {
    document.getElementById('landing')?.style.setProperty('display', 'none');
    document.getElementById('dashboard')?.classList.add('active');
    document.getElementById('userMenu')?.style.setProperty('display', 'flex');
    document.getElementById('loginBtn')?.style.setProperty('display', 'none');
}

function updateUserUI() {
    if (!user) return;
    document.getElementById('username').textContent = user.username;
    document.getElementById('userAvatar').src =
        `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
}

// ================= GUILDS =================
async function loadGuilds() {
    try {
        const res = await fetch('/api/guilds', { credentials: 'include' });
        const guilds = await res.json();

        const guildList = document.getElementById('guildList');

        guildList.innerHTML =
            `<h3 style="margin-bottom:20px;">Your Servers</h3>` +
            guilds.map(guild => `
                <div class="guild-item ${guild.hasQueue ? 'active' : ''}"
                     onclick="selectGuild('${guild.id}')"
                     data-id="${guild.id}">
                     
                    <img src="${guild.icon
                        ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
                        : 'https://placehold.co/40x40/111118/5865F2?text=?'}">

                    <div class="guild-info">
                        <div class="guild-name">${guild.name}</div>
                        <div class="guild-status">
                            ${guild.hasQueue
                                ? (guild.isPlaying ? '▶️ Playing' : '⏸️ Paused')
                                : 'Bot not in voice'}
                        </div>
                    </div>

                    <div class="status-dot ${guild.hasQueue ? '' : 'inactive'}"></div>
                </div>
            `).join('');

        const activeGuild = guilds.find(g => g.hasQueue);
        if (activeGuild) selectGuild(activeGuild.id);

    } catch {
        showToast('Failed to load servers', 'error');
    }
}

function selectGuild(guildId) {
    document.querySelectorAll('.guild-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === guildId);
    });

    if (currentGuild) socket.emit('unsubscribe', currentGuild);

    currentGuild = guildId;
    socket.emit('subscribe', guildId);

    loadQueueData(guildId);
}

async function loadQueueData(guildId) {
    try {
        const res = await fetch(`/api/guild/${guildId}/queue`, { credentials: 'include' });
        if (res.ok) {
            const data = await res.json();
            updateDashboard(data);
        }
    } catch {
        showToast('Failed to load queue data', 'error');
    }
}

// ================= SOCKET =================
function setupSocketListeners() {
    socket.on('connect', () => {
        if (currentGuild) socket.emit('subscribe', currentGuild);
    });

    socket.on('queueUpdate', updateDashboard);

    socket.on('error', err => {
        showToast(err.message, 'error');
    });
}

// ================= DASHBOARD =================
function updateDashboard(data) {
    currentQueue = data;
    isPlaying = data.isPlaying;

    document.getElementById('statServers').textContent = data.guildName || 'Unknown';
    document.getElementById('statPlaying').textContent = data.isPlaying ? 'Playing' : 'Stopped';
    document.getElementById('statQueue').textContent = data.queue?.length || 0;

    if (data.currentSong) {
        document.getElementById('albumArt').src = data.currentSong.thumbnail;
        document.getElementById('trackTitle').textContent = data.currentSong.title;
        document.getElementById('trackArtist').textContent = data.currentSong.author;
        document.getElementById('totalTime').textContent = data.currentSong.duration;

        document.getElementById('playBtn').innerHTML =
            data.isPlaying
                ? '<i class="fas fa-pause"></i>'
                : '<i class="fas fa-play"></i>';

        startProgressTracking(data.progress, data.currentSong.durationSec);
    } else {
        stopProgressTracking();
    }

    document.getElementById('volumeFill').style.width = `${data.volume}%`;
    document.getElementById('volumeValue').textContent = `${data.volume}%`;

    updateToggle('loopToggle', data.loop !== 'none', `Loop: ${data.loop}`);
    updateToggle('autoplayToggle', data.autoplay, `Autoplay: ${data.autoplay ? 'On' : 'Off'}`);

    updateQueueList(data.queue, data.history);
}

// ================= QUEUE =================
function updateQueueList(queue = [], history = []) {
    const queueList = document.getElementById('queueList');

    if (!queue.length && !history.length) {
        queueList.innerHTML = `<div class="empty-state">Queue is empty</div>`;
        return;
    }

    queueList.innerHTML = `
        ${history.slice(0,3).map(song => `
            <div class="queue-item" style="opacity:.6">
                <img src="${song.thumbnail}">
                <div>${song.title}</div>
            </div>
        `).join('')}

        ${queue.map((song, i) => `
            <div class="queue-item">
                <img src="${song.thumbnail}">
                <div>${song.title}</div>
                <button onclick="playNow(${i})">▶</button>
                <button onclick="removeSong(${i})">✖</button>
            </div>
        `).join('')}
    `;
}

function updateToggle(id, active, text) {
    const el = document.getElementById(id);
    el.classList.toggle('active', active);
    el.innerHTML = text;
}

// ================= PROGRESS =================
function startProgressTracking(progress, duration) {
    stopProgressTracking();

    progressInterval = setInterval(() => {
        if (isPlaying && progress < duration) {
            progress++;
            document.getElementById('progressFill').style.width =
                `${(progress / duration) * 100}%`;
            document.getElementById('currentTime').textContent = formatTime(progress);
        }
    }, 1000);
}

function stopProgressTracking() {
    clearInterval(progressInterval);
    progressInterval = null;

    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('currentTime').textContent = '0:00';
}

function formatTime(s) {
    return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

// ================= CONTROLS =================
async function sendControl(action, data = {}) {
    if (!currentGuild) return showToast('Select a server first', 'error');

    try {
        await fetch(`/api/guild/${currentGuild}/control`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, data })
        });
    } catch {
        showToast('Control failed', 'error');
    }
}

function togglePlay() { sendControl(isPlaying ? 'pause' : 'resume'); }
function skipTrack() { sendControl('skip'); }
function previousTrack() { sendControl('previous'); }

function toggleLoop() {
    const modes = ['none','track','queue'];
    const next = modes[(modes.indexOf(currentQueue?.loop || 'none')+1)%3];
    sendControl('loop', { mode: next });
}

function toggleAutoplay() {
    sendControl('autoplay', { enabled: !currentQueue?.autoplay });
}

function shuffleQueue() { sendControl('shuffle'); }

function clearQueue() {
    if (!confirm('Clear entire queue?')) return;
    sendControl('clear');
}

// Queue actions
function playNow(i) { sendControl('playNow', { index: i }); }
function removeSong(i) { sendControl('remove', { index: i }); }

// Volume
function setVolume(v) {
    sendControl('volume', { volume: Math.max(0, Math.min(100, v)) });
}

// ================= SHORTCUTS =================
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
        if (['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;

        if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        if (e.code === 'ArrowRight') skipTrack();
        if (e.code === 'ArrowLeft') previousTrack();
    });
}

// ================= TOAST =================
function showToast(msg, type='info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.body.appendChild(el);

    setTimeout(()=>el.classList.add('show'),10);
    setTimeout(()=>{
        el.classList.remove('show');
        setTimeout(()=>el.remove(),300);
    },2500);
}
