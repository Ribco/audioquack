// ==========================================
// AUDIOQUACK BOT + DASHBOARD SERVER
// Domain: audioquack.bot.nu
// ==========================================

require('dotenv').config();
const {
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes
} = require('discord.js');
const { Player, QueryType, QueueRepeatMode } = require('discord-player');
const { YoutubeiExtractor } = require('discord-player-youtubei');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const cors = require('cors');
const path = require('path');

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID || "1489574284572495944",
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    dashboardSecret: process.env.DASHBOARD_SECRET || 'super-secret-key-quack-quackify',
    callbackURL: process.env.CALLBACK_URL || `http://localhost:${process.env.PORT || 3000}/auth/discord/callback`,
    port: process.env.PORT || 3000,
    color: 0x5865F2,
    errorColor: 0xED4245,
    successColor: 0x57F287,
    searchLimit: parseInt(process.env.SEARCH_LIMIT) || 5,
    enableAutoplay: process.env.ENABLE_AUTOPLAY !== 'false',
};

// ==========================================
// DISCORD CLIENT
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ]
});

// ==========================================
// DISCORD PLAYER SETUP
// ==========================================
const player = new Player(client, {
    ytdlOptions: {
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
    },
});

player.extractors.register(YoutubeiExtractor, {});

const nowPlayingMessages = new Map();
const userSessions = new Map();

// ==========================================
// HELPERS
// ==========================================
function createEmbed(title, description, color = CONFIG.color) {
    return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
}

function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function timeAgo(ms) {
    const diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    return Math.floor(diff / 3600000) + 'h ago';
}

// ==========================================
// PLAYER EVENTS
// ==========================================
player.events.on('playerStart', async (queue, track) => {
    const channel = queue.metadata?.textChannel;
    if (!channel) return;

    const embed = new EmbedBuilder()
        .setTitle('🎵 Now Playing')
        .setDescription(`[${track.title}](${track.url})`)
        .addFields(
            { name: 'Artist', value: track.author || 'Unknown', inline: true },
            { name: 'Duration', value: track.duration || 'Unknown', inline: true },
            { name: 'Requested by', value: `<@${track.requestedBy?.id || 'Unknown'}>`, inline: true }
        )
        .setThumbnail(track.thumbnail)
        .setColor(CONFIG.color)
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId('prev').setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('loop').setEmoji('🔁').setStyle(ButtonStyle.Secondary)
        );

    const oldMsg = nowPlayingMessages.get(queue.guild.id);
    if (oldMsg) { try { await oldMsg.delete(); } catch {} }
    const msg = await channel.send({ embeds: [embed], components: [row] });
    nowPlayingMessages.set(queue.guild.id, msg);

    broadcastUpdate(queue.guild.id);
});

player.events.on('queueEnd', (queue) => {
    broadcastUpdate(queue.guild.id);
});

player.events.on('playerError', (queue, error) => {
    console.error('Player error:', error);
});

player.events.on('error', (queue, error) => {
    console.error('Queue error:', error);
});

// ==========================================
// DASHBOARD BROADCAST
// ==========================================
function getQueueData(guildId) {
    const queue = player.nodes.get(guildId);
    const guild = client.guilds.cache.get(guildId);
    if (!queue || !guild) return null;

    const current = queue.currentTrack;
    return {
        guildId,
        guildName: guild.name,
        guildIcon: guild.iconURL(),
        isPlaying: queue.node.isPlaying(),
        currentSong: current ? {
            title: current.title,
            author: current.author,
            url: current.url,
            thumbnail: current.thumbnail,
            duration: current.duration,
            durationMs: current.durationMS,
            requestedBy: current.requestedBy?.id || 'Unknown',
        } : null,
        queue: queue.tracks.toArray().slice(0, 10).map(t => ({
            title: t.title,
            author: t.author,
            url: t.url,
            thumbnail: t.thumbnail,
            duration: t.duration,
            requestedBy: t.requestedBy?.id || 'Unknown',
        })),
        volume: queue.node.volume,
        loop: queue.repeatMode,
        progress: queue.node.getTimestamp()?.current?.value || 0,
        listeners: queue.channel?.members?.size - 1 || 0,
    };
}

function broadcastUpdate(guildId) {
    if (!io) return;
    const data = getQueueData(guildId);
    io.to(guildId).emit('queueUpdate', data);
}

// ==========================================
// SLASH COMMANDS
// ==========================================
const commands = [
    new SlashCommandBuilder().setName('play').setDescription('Play a song from YouTube').addStringOption(opt => opt.setName('query').setDescription('Song name or URL').setRequired(true)),
    new SlashCommandBuilder().setName('search').setDescription('Search YouTube tracks').addStringOption(opt => opt.setName('query').setDescription('Search term').setRequired(true)),
    new SlashCommandBuilder().setName('skip').setDescription('Skip song').addIntegerOption(opt => opt.setName('amount').setDescription('Skip count')),
    new SlashCommandBuilder().setName('previous').setDescription('Previous song'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop and clear'),
    new SlashCommandBuilder().setName('pause').setDescription('Pause'),
    new SlashCommandBuilder().setName('resume').setDescription('Resume'),
    new SlashCommandBuilder().setName('queue').setDescription('Show queue').addIntegerOption(opt => opt.setName('page').setDescription('Page')),
    new SlashCommandBuilder().setName('nowplaying').setDescription('Current song'),
    new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle queue'),
    new SlashCommandBuilder().setName('loop').setDescription('Set loop').addStringOption(opt => opt.setName('mode').setDescription('Mode').addChoices({ name: 'Off', value: 'none' }, { name: 'Track', value: 'track' }, { name: 'Queue', value: 'queue' })),
    new SlashCommandBuilder().setName('volume').setDescription('Set volume').addIntegerOption(opt => opt.setName('level').setDescription('0-100').setRequired(true)),
    new SlashCommandBuilder().setName('remove').setDescription('Remove song').addIntegerOption(opt => opt.setName('position').setDescription('Position').setRequired(true)),
    new SlashCommandBuilder().setName('clear').setDescription('Clear queue'),
    new SlashCommandBuilder().setName('disconnect').setDescription('Disconnect'),
    new SlashCommandBuilder().setName('autoplay').setDescription('Toggle autoplay'),
    new SlashCommandBuilder().setName('stats').setDescription('Bot stats'),
    new SlashCommandBuilder().setName('help').setDescription('Show help'),
];

// ==========================================
// BOT EVENTS
// ==========================================
client.once('ready', async () => {
    console.log(`🤖 Bot logged in as ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(CONFIG.token);
    try {
        await rest.put(Routes.applicationCommands(CONFIG.clientId), { body: commands.map(c => c.toJSON()) });
        console.log('✅ Slash commands registered');
    } catch (error) {
        console.error('Command registration failed:', error);
    }
    updatePresence();
});

function updatePresence() {
    client.user.setPresence({
        activities: [{ name: `YouTube Music | ${client.guilds.cache.size} servers`, type: 2 }],
        status: 'online',
    });
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

    if (interaction.isButton()) {
        await handleButton(interaction);
        return;
    }

    const { commandName, guildId, member, channel } = interaction;

    const voiceChannel = member.voice.channel;
    if (!voiceChannel && !['help', 'stats', 'nowplaying', 'queue'].includes(commandName)) {
        return interaction.reply({ embeds: [createEmbed('Error', 'Join a voice channel first!', CONFIG.errorColor)], ephemeral: true });
    }

    const queue = player.nodes.get(guildId);

    try {
        switch (commandName) {
            case 'play': {
                const query = interaction.options.getString('query');
                await interaction.deferReply();

                const result = await player.search(query, {
                    requestedBy: interaction.user,
                    searchEngine: QueryType.AUTO,
                });

                if (!result || !result.tracks.length) {
                    return interaction.editReply({ embeds: [createEmbed('No Results', 'No tracks found!', CONFIG.errorColor)] });
                }

                const track = result.tracks[0];

                let q = player.nodes.get(guildId);
                if (!q) {
                    q = player.nodes.create(interaction.guild, {
                        metadata: { textChannel: channel },
                        selfDeafen: true,
                        volume: 80,
                        leaveOnEmpty: true,
                        leaveOnEmptyCooldown: 30000,
                        leaveOnEnd: false,
                    });
                }

                if (!q.connection) await q.connect(voiceChannel);

                q.addTrack(track);
                if (!q.node.isPlaying()) await q.node.play();

                await interaction.editReply({ embeds: [createEmbed('🎵 Added to Queue', `[${track.title}](${track.url}) by ${track.author}`, CONFIG.successColor)] });
                break;
            }
            case 'skip': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                const amount = interaction.options.getInteger('amount') || 1;
                for (let i = 0; i < amount; i++) queue.node.skip();
                interaction.reply({ embeds: [createEmbed('⏭️ Skipped', `Skipped ${amount}`, CONFIG.successColor)] });
                break;
            }
            case 'pause': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                queue.node.pause();
                broadcastUpdate(guildId);
                interaction.reply({ embeds: [createEmbed('⏸️ Paused', 'Paused', CONFIG.successColor)] });
                break;
            }
            case 'resume': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                queue.node.resume();
                broadcastUpdate(guildId);
                interaction.reply({ embeds: [createEmbed('▶️ Resumed', 'Resumed', CONFIG.successColor)] });
                break;
            }
            case 'stop': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                queue.delete();
                broadcastUpdate(guildId);
                interaction.reply({ embeds: [createEmbed('⏹️ Stopped', 'Queue cleared', CONFIG.successColor)] });
                break;
            }
            case 'queue': {
                if (!queue || !queue.currentTrack) return interaction.reply({ embeds: [createEmbed('Queue', 'Empty', CONFIG.color)] });
                const page = (interaction.options.getInteger('page') || 1) - 1;
                const perPage = 10;
                const tracks = queue.tracks.toArray();
                const start = page * perPage;
                const desc = [queue.currentTrack, ...tracks].slice(start, start + perPage).map((t, i) =>
                    `${i === 0 && page === 0 ? '▶️' : start + i + 1}. [${t.title}](${t.url}) | \`${t.duration}\``
                ).join('\n');
                interaction.reply({ embeds: [createEmbed(`📋 Queue (${tracks.length + 1})`, desc || 'Empty', CONFIG.color)] });
                break;
            }
            case 'volume': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                const vol = Math.min(100, Math.max(0, interaction.options.getInteger('level')));
                queue.node.setVolume(vol);
                broadcastUpdate(guildId);
                interaction.reply({ embeds: [createEmbed('🔊 Volume', `${vol}%`, CONFIG.successColor)] });
                break;
            }
            case 'loop': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                const mode = interaction.options.getString('mode') || 'none';
                const modeMap = { none: QueueRepeatMode.OFF, track: QueueRepeatMode.TRACK, queue: QueueRepeatMode.QUEUE };
                queue.setRepeatMode(modeMap[mode]);
                broadcastUpdate(guildId);
                interaction.reply({ embeds: [createEmbed('🔁 Loop', mode.toUpperCase(), CONFIG.successColor)] });
                break;
            }
            case 'shuffle': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'No queue', CONFIG.errorColor)], ephemeral: true });
                queue.tracks.shuffle();
                broadcastUpdate(guildId);
                interaction.reply({ embeds: [createEmbed('🔀 Shuffled', 'Queue shuffled!', CONFIG.successColor)] });
                break;
            }
            case 'disconnect': {
                if (queue) queue.delete();
                interaction.reply({ embeds: [createEmbed('👋 Disconnected', 'Bye!', CONFIG.successColor)] });
                break;
            }
            case 'search': {
                const query = interaction.options.getString('query');
                await interaction.deferReply();
                const result = await player.search(query, { requestedBy: interaction.user, searchEngine: QueryType.YOUTUBE });
                if (!result || !result.tracks.length) {
                    return interaction.editReply({ embeds: [createEmbed('No Results', 'No tracks found!', CONFIG.errorColor)] });
                }
                const desc = result.tracks.slice(0, CONFIG.searchLimit).map((t, i) =>
                    `${i + 1}. [${t.title}](${t.url}) - ${t.author}`
                ).join('\n');
                const embed = createEmbed(`🔍 Results for "${query}"`, desc, CONFIG.color);
                embed.setFooter({ text: 'Use /play with the song name to add to queue' });
                interaction.editReply({ embeds: [embed] });
                break;
            }
            case 'nowplaying': {
                if (!queue || !queue.currentTrack) return interaction.reply({ embeds: [createEmbed('Nothing Playing', 'No song is currently playing', CONFIG.color)] });
                const t = queue.currentTrack;
                const embed = new EmbedBuilder()
                    .setTitle('🎵 Now Playing')
                    .setDescription(`[${t.title}](${t.url})`)
                    .addFields(
                        { name: 'Artist', value: t.author || 'Unknown', inline: true },
                        { name: 'Duration', value: t.duration, inline: true },
                        { name: 'Requested by', value: `<@${t.requestedBy?.id || 'Unknown'}>`, inline: true }
                    )
                    .setThumbnail(t.thumbnail)
                    .setColor(CONFIG.color);
                interaction.reply({ embeds: [embed] });
                break;
            }
            case 'remove': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'No queue', CONFIG.errorColor)], ephemeral: true });
                const pos = interaction.options.getInteger('position') - 1;
                const tracks = queue.tracks.toArray();
                if (pos < 0 || pos >= tracks.length) return interaction.reply({ embeds: [createEmbed('Error', 'Invalid position', CONFIG.errorColor)], ephemeral: true });
                const removed = tracks[pos];
                queue.node.remove(pos);
                broadcastUpdate(guildId);
                interaction.reply({ embeds: [createEmbed('✅ Removed', `Removed [${removed.title}](${removed.url})`, CONFIG.successColor)] });
                break;
            }
            case 'clear': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'No queue', CONFIG.errorColor)], ephemeral: true });
                queue.tracks.clear();
                broadcastUpdate(guildId);
                interaction.reply({ embeds: [createEmbed('🗑️ Cleared', 'Queue cleared', CONFIG.successColor)] });
                break;
            }
            case 'autoplay': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                const enabled = queue.repeatMode !== QueueRepeatMode.AUTOPLAY;
                queue.setRepeatMode(enabled ? QueueRepeatMode.AUTOPLAY : QueueRepeatMode.OFF);
                broadcastUpdate(guildId);
                interaction.reply({ embeds: [createEmbed('🎵 Autoplay', enabled ? 'Enabled' : 'Disabled', CONFIG.successColor)] });
                break;
            }
            case 'previous': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                await queue.history.previous();
                interaction.reply({ embeds: [createEmbed('⏮️ Previous', 'Playing previous track', CONFIG.successColor)] });
                break;
            }
            case 'stats': {
                const playing = player.nodes.cache.filter(q => q.node.isPlaying()).size;
                interaction.reply({ embeds: [createEmbed('📊 Stats', `Servers: ${client.guilds.cache.size}\nPlaying: ${playing}\nUptime: ${formatDuration(client.uptime)}`, CONFIG.color)] });
                break;
            }
            case 'help': {
                interaction.reply({ embeds: [createEmbed('🎵 YouTube Music Commands', '/play, /search, /nowplaying, /pause, /resume, /skip, /stop, /queue, /volume, /loop, /shuffle, /remove, /clear, /autoplay, /previous, /disconnect, /stats', CONFIG.color)] });
                break;
            }
        }
    } catch (error) {
        console.error(error);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ embeds: [createEmbed('Error', error.message, CONFIG.errorColor)], ephemeral: true }).catch(() => {});
        } else {
            await interaction.reply({ embeds: [createEmbed('Error', error.message, CONFIG.errorColor)], ephemeral: true }).catch(() => {});
        }
    }
});

async function handleButton(interaction) {
    const { customId, guildId, member } = interaction;
    const queue = player.nodes.get(guildId);
    if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'No active queue', CONFIG.errorColor)], ephemeral: true }).catch(() => {});
    if (member.voice.channel?.id !== queue.channel?.id) return interaction.reply({ embeds: [createEmbed('Error', 'Join voice channel first!', CONFIG.errorColor)], ephemeral: true }).catch(() => {});

    await interaction.deferUpdate().catch(() => {});

    switch (customId) {
        case 'prev': await queue.history.previous().catch(() => {}); break;
        case 'pause': queue.node.isPlaying() ? queue.node.pause() : queue.node.resume(); break;
        case 'skip': queue.node.skip(); break;
        case 'stop': queue.delete(); break;
        case 'loop': {
            const modes = [QueueRepeatMode.OFF, QueueRepeatMode.TRACK, QueueRepeatMode.QUEUE];
            const next = modes[(modes.indexOf(queue.repeatMode) + 1) % modes.length];
            queue.setRepeatMode(next);
            break;
        }
    }
    broadcastUpdate(guildId);
}

// ==========================================
// EXPRESS SERVER + DASHBOARD API
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: ['https://audioquack.bot.nu', 'http://localhost:3000'], credentials: true }
});

app.use(session({
    secret: CONFIG.dashboardSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 86400000 }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(cors({ origin: ['https://audioquack.bot.nu', 'http://localhost:3000', 'http://127.0.0.1:3000'], credentials: true }));
app.use(express.json());
app.use(express.static(__dirname));

passport.use(new DiscordStrategy({
    clientID: CONFIG.clientId,
    clientSecret: CONFIG.clientSecret,
    callbackURL: CONFIG.callbackURL,
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    userSessions.set(profile.id, profile);
    done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, userSessions.get(id)));

const requireAuth = (req, res, next) => {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ error: 'Unauthorized' });
};

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/dashboard');
});

app.get('/api/user', requireAuth, (req, res) => {
    res.json({
        id: req.user.id,
        username: req.user.username,
        avatar: req.user.avatar,
        guilds: req.user.guilds.filter(g => client.guilds.cache.has(g.id))
    });
});

app.get('/api/guilds', requireAuth, (req, res) => {
    const userGuilds = req.user.guilds
        .filter(g => (g.permissions & 0x20) === 0x20 || (g.permissions & 0x8) === 0x8)
        .map(g => ({
            ...g,
            botInGuild: client.guilds.cache.has(g.id),
            hasQueue: !!player.nodes.get(g.id),
            isPlaying: player.nodes.get(g.id)?.node.isPlaying() || false
        }));
    res.json(userGuilds);
});

app.get('/api/guild/:id/queue', requireAuth, (req, res) => {
    const data = getQueueData(req.params.id);
    if (!data) return res.status(404).json({ error: 'No active queue' });
    res.json(data);
});

app.post('/api/guild/:id/control', requireAuth, async (req, res) => {
    const { action, data } = req.body;
    const queue = player.nodes.get(req.params.id);
    if (!queue) return res.status(404).json({ error: 'No active queue' });

    const guild = client.guilds.cache.get(req.params.id);
    const member = await guild.members.fetch(req.user.id).catch(() => null);
    if (!member) return res.status(403).json({ error: 'Not in guild' });

    switch (action) {
        case 'pause': queue.node.pause(); break;
        case 'resume': queue.node.resume(); break;
        case 'skip': queue.node.skip(); break;
        case 'previous': await queue.history.previous().catch(() => {}); break;
        case 'stop': queue.delete(); break;
        case 'shuffle': queue.tracks.shuffle(); break;
        case 'volume': queue.node.setVolume(data.volume); break;
        case 'loop': {
            const modeMap = { none: QueueRepeatMode.OFF, track: QueueRepeatMode.TRACK, queue: QueueRepeatMode.QUEUE };
            queue.setRepeatMode(modeMap[data.mode] ?? QueueRepeatMode.OFF);
            break;
        }
        case 'remove': queue.node.remove(data.index); break;
        case 'add': {
            const result = await player.search(data.query, { requestedBy: member.user });
            if (result?.tracks?.length) {
                queue.addTrack(result.tracks[0]);
                if (!queue.node.isPlaying()) await queue.node.play();
            }
            break;
        }
    }
    broadcastUpdate(req.params.id);
    res.json({ success: true });
});

app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', (req, res) => {
    if (req.isAuthenticated()) res.redirect('/dashboard');
    else res.sendFile(path.join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {
    socket.on('subscribe', (guildId) => {
        socket.join(guildId);
        const data = getQueueData(guildId);
        if (data) socket.emit('queueUpdate', data);
    });
    socket.on('unsubscribe', (guildId) => socket.leave(guildId));
});

setInterval(updatePresence, 300000);

server.listen(CONFIG.port, () => {
    console.log(`🌐 Dashboard running on https://audioquack.bot.nu (port ${CONFIG.port})`);
});

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => { console.error('Uncaught exception:', error); process.exit(1); });

if (!CONFIG.token) {
    console.warn('⚠️ No DISCORD_TOKEN provided.');
} else {
    client.login(CONFIG.token).catch(error => { console.error('Failed to login:', error); process.exit(1); });
}
