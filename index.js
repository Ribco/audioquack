// ==========================================
// AUDIOQUACK BOT + DASHBOARD SERVER
// Domain: audioquack.bot.nu
// ==========================================

require('dotenv').config();
const { 
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes 
} = require('discord.js');
const { 
    joinVoiceChannel, createAudioPlayer, createAudioResource, 
    AudioPlayerStatus, VoiceConnectionStatus, entersState 
} = require('@discordjs/voice');
const { Manager } = require('erela.js');
// const Spotify = require('erela.js-spotify');
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
  //  spotifyClientId: process.env.SPOTIFY_CLIENT_ID,
  //  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    dashboardSecret: process.env.DASHBOARD_SECRET || 'super-secret-key-quack-quackify',
    callbackURL: process.env.CALLBACK_URL || `http://localhost:${process.env.PORT || 3000}/auth/discord/callback`,
    port: process.env.PORT || 3000,
    prefix: '!',
    color: 0x5865F2,
    errorColor: 0xED4245,
    successColor: 0x57F287,
    maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE) || 100,
    defaultVolume: parseInt(process.env.DEFAULT_VOLUME) || 100,
    maxVolume: parseInt(process.env.MAX_VOLUME) || 200,
    leaveTimeout: parseInt(process.env.LEAVE_TIMEOUT) || 30000, // 30 seconds
    searchLimit: parseInt(process.env.SEARCH_LIMIT) || 5,
    enableSpotify: process.env.ENABLE_SPOTIFY === 'true',
    enableAutoplay: process.env.ENABLE_AUTOPLAY !== 'false',
    logLevel: process.env.LOG_LEVEL || 'info',
    // Lavalink configuration
  lavalink: {
    host: 'lavalink.lexnet.cc',
    port: 443,
    password: 'lexn3tl@val!nk',
    secure: true
}
};

// ==========================================
// ERELA.JS SETUP
// ==========================================
const manager = new Manager({
    const manager = new Manager({
    nodes: [{
        host: 'lavalink.lexnet.cc',
        port: 443,
        password: 'lexn3tl@val!nk',
        secure: true,
        identifier: 'main',
        retryAmount: 5,
        retryDelay: 3000,
    }],
    autoPlay: true,
   // plugins: [
    //    new Spotify({
    //        clientId: CONFIG.spotifyClientId,
     //       clientSecret: CONFIG.spotifyClientSecret,
    //    }),
  //  ],
    send: (id, payload) => {
        const guild = client.guilds.cache.get(id);
        if (guild) guild.shard.send(payload);
    },
});

manager.on('nodeConnect', (node) => {
    console.log(`✅ Lavalink node connected: ${node.options.identifier}`);
});

manager.on('nodeError', (node, error) => {
    console.error(`❌ Lavalink node error: ${error.message}`);
});

manager.on('trackStart', (player, track) => {
    const guild = client.guilds.cache.get(player.guild);
    if (guild) {
        const queue = queues.get(guild.id);
        if (queue) {
            queue.updateNowPlaying(track);
            queue.broadcastUpdate();
        }
    }
});

manager.on('queueEnd', (player) => {
    const guild = client.guilds.cache.get(player.guild);
    if (guild) {
        const queue = queues.get(guild.id);
        if (queue) {
            queue.handleQueueEnd();
        }
    }
});

manager.on('playerMove', (player, oldChannel, newChannel) => {
    if (!newChannel) {
        player.destroy();
    }
});

// ==========================================
// STATE MANAGEMENT
// ==========================================
const queues = new Map();
const history = new Map();
const nowPlayingMessages = new Map();
const loops = new Map();
const autoplay = new Map();
const userSessions = new Map(); // For dashboard auth
const guildSettings = new Map(); // Per-guild settings

// ==========================================
// DISCORD BOT SETUP
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
client.on('raw', d => manager.updateVoiceState(d));
class MusicQueue {
    constructor(guildId, voiceChannel, textChannel) {
        this.guildId = guildId;
        this.voiceChannel = voiceChannel;
        this.textChannel = textChannel;
        this.player = manager.create({
            guild: guildId,
            voiceChannel: voiceChannel.id,
            textChannel: textChannel.id,
            selfDeafen: true,
        });
        this.player.connect();
        queues.set(guildId, this);
    }

    async addSong(track) {
        this.player.queue.add(track);
        return this.player.queue.size;
    }

    async play() {
        if (!this.player.playing && !this.player.paused) {
            this.player.play();
        }
    }

    skip(amount = 1) {
        for (let i = 0; i < amount - 1; i++) {
            this.player.queue.shift();
        }
        this.player.stop();
    }

    previous() {
        const previousTrack = this.player.queue.previous?.pop();
        if (previousTrack) {
            this.player.queue.splice(0, 0, previousTrack);
            this.player.stop();
        }
    }

    pause() {
        this.player.pause(true);
    }

    resume() {
        this.player.pause(false);
    }

    stop() {
        this.player.queue.clear();
        this.player.stop();
    }

    shuffle() {
        this.player.queue.shuffle();
    }

    setVolume(vol) {
        this.player.setVolume(vol / 100);
    }

    remove(position) {
        if (position > 0 && position <= this.player.queue.size) {
            return this.player.queue.remove(position - 1);
        }
        return null;
    }

    jump(position) {
        if (position >= 0 && position < this.player.queue.size) {
            this.player.queue.splice(0, position);
            this.player.stop();
            return true;
        }
        return false;
    }

    destroy() {
        this.player.destroy();
        queues.delete(this.guildId);
        nowPlayingMessages.delete(this.guildId);
        this.broadcastUpdate();
    }

    getProgress() {
        if (this.player.playing && this.player.position) {
            return this.player.position / 1000;
        }
        return 0;
    }

    broadcastUpdate() {
        const data = this.getDashboardData();
        if (io) {
            io.to(this.guildId).emit('queueUpdate', data);
        }
    }

    getDashboardData() {
        return {
            guildId: this.guildId,
            guildName: this.voiceChannel.guild.name,
            guildIcon: this.voiceChannel.guild.iconURL(),
            isPlaying: this.player.playing,
            currentSong: this.player.queue.current ? {
                id: this.player.queue.current.identifier,
                title: this.player.queue.current.title,
                author: this.player.queue.current.author,
                url: this.player.queue.current.uri,
                thumbnail: this.player.queue.current.thumbnail,
                duration: formatDuration(this.player.queue.current.duration / 1000),
                durationSec: this.player.queue.current.duration / 1000,
                requestedBy: this.player.queue.current.requester?.id || 'Unknown',
            } : null,
            queue: this.player.queue.slice(1, 11).map(track => ({
                id: track.identifier,
                title: track.title,
                author: track.author,
                url: track.uri,
                thumbnail: track.thumbnail,
                duration: formatDuration(track.duration / 1000),
                durationSec: track.duration / 1000,
                requestedBy: track.requester?.id || 'Unknown',
            })),
            history: (history.get(this.guildId) || []).slice(0, 10),
            volume: Math.round(this.player.volume * 100),
            loop: 'none', // Erela.js handles this differently
            autoplay: autoplay.get(this.guildId) || false,
            progress: this.getProgress(),
            listeners: this.voiceChannel.members.size - 1,
        };
    }

    async updateNowPlaying(track) {
        const embed = new EmbedBuilder()
            .setTitle('🎵 Now Playing')
            .setDescription(`[${track.title}](${track.uri})`)
            .addFields(
                { name: 'Artist', value: track.author, inline: true },
                { name: 'Duration', value: formatDuration(track.duration / 1000), inline: true },
                { name: 'Requested by', value: `<@${track.requester?.id || 'Unknown'}>`, inline: true }
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

        const oldMsg = nowPlayingMessages.get(this.guildId);
        if (oldMsg) {
            try {
                await oldMsg.delete();
            } catch {}
        }
        const msg = await this.textChannel.send({ embeds: [embed], components: [row] });
        nowPlayingMessages.set(this.guildId, msg);
    }

    handleQueueEnd() {
        if (autoplay.get(this.guildId) && CONFIG.enableAutoplay) {
            this.handleAutoplay();
        }
        this.broadcastUpdate();
    }

    async handleAutoplay() {
        const lastSong = this.player.queue.previous?.[0] || this.player.queue.current;
        if (!lastSong) return;

        try {
            const searchResults = await manager.search(`${lastSong.author}`, this.player);
            if (searchResults && searchResults.tracks && searchResults.tracks.length > 0) {
                const randomTrack = searchResults.tracks[Math.floor(Math.random() * Math.min(searchResults.tracks.length, 5))];
                this.player.queue.add(randomTrack);
                if (!this.player.playing && !this.player.paused) {
                    this.player.play();
                }
            }
        } catch (error) {
            console.error('Autoplay error:', error);
        }
    }
}

function createEmbed(title, description, color = CONFIG.color) {
    return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
}

async function createSongFromSearch(track, userId) {
    return {
        id: track.id || track.videoId || track.video_id || track.trackId,
        title: track.title || track.name,
        author: track.artist || track.author || track.artists?.[0]?.name || 'Unknown Artist',
        url: track.url || track.external_urls?.spotify || track.webpage_url || `https://open.spotify.com/track/${track.id}`,
        thumbnail: track.thumbnail || track.album?.images?.[0]?.url || track.thumbnails?.[0]?.url || 'https://i.scdn.co/image/ab67616d0000b273000000000000000000000000',
        duration: track.durationString || formatDuration(track.durationInSec || track.duration_ms / 1000 || track.duration || 0),
        durationSec: track.durationInSec || track.duration_ms / 1000 || track.duration || 0,
        requestedBy: userId,
    };
}

function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ==========================================
// SLASH COMMANDS
// ==========================================
const commands = [
    new SlashCommandBuilder().setName('play').setDescription('Play music from Spotify').addStringOption(opt => opt.setName('query').setDescription('Song name or Spotify track URL').setRequired(true)),
    new SlashCommandBuilder().setName('search').setDescription('Search Spotify tracks').addStringOption(opt => opt.setName('query').setDescription('Search term').setRequired(true)),
    new SlashCommandBuilder().setName('skip').setDescription('Skip song').addIntegerOption(opt => opt.setName('amount').setDescription('Skip count')),
    new SlashCommandBuilder().setName('previous').setDescription('Previous song'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop and clear'),
    new SlashCommandBuilder().setName('pause').setDescription('Pause'),
    new SlashCommandBuilder().setName('resume').setDescription('Resume'),
    new SlashCommandBuilder().setName('queue').setDescription('Show queue').addIntegerOption(opt => opt.setName('page').setDescription('Page')),
    new SlashCommandBuilder().setName('nowplaying').setDescription('Current song'),
    new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle queue'),
    new SlashCommandBuilder().setName('loop').setDescription('Set loop').addStringOption(opt => opt.setName('mode').setDescription('Mode').addChoices({name:'Off',value:'none'},{name:'Track',value:'track'},{name:'Queue',value:'queue'})),
    new SlashCommandBuilder().setName('volume').setDescription('Set volume').addIntegerOption(opt => opt.setName('level').setDescription('0-200').setRequired(true)),
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
    
    // Init Lavalink AFTER bot is ready
    manager.init(client.user.id);
    
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
    const guildCount = client.guilds.cache.size;
    client.user.setPresence({
        activities: [{ name: `Spotify Music | ${guildCount} servers`, type: 2 }], // Listening
        status: 'online',
    });
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
    
    const { commandName, guildId, user, member, channel } = interaction;
    
    if (interaction.isButton()) {
        await handleButton(interaction);
        return;
    }

    const voiceChannel = member.voice.channel;
    if (!voiceChannel && commandName !== 'help' && commandName !== 'stats') {
        return interaction.reply({ embeds: [createEmbed('Error', 'Join a voice channel first!', CONFIG.errorColor)], ephemeral: true });
    }

    let queue = queues.get(guildId);

    try {
        switch (commandName) {
            case 'play': {
                const query = interaction.options.getString('query');
                await interaction.deferReply();
                
                if (!queue) {
                    queue = new MusicQueue(guildId, voiceChannel, channel);
                    queues.set(guildId, queue);
                } else if (queue.voiceChannel.id !== voiceChannel.id) {
                    return interaction.editReply({ embeds: [createEmbed('Error', 'Already playing elsewhere!', CONFIG.errorColor)] });
                }

                try {
                    console.log(`Searching for: ${query}`);
                    const searchResults = await manager.search(query, interaction.user);
                    
                    if (!searchResults || !searchResults.tracks || searchResults.tracks.length === 0) {
                        return interaction.editReply({ embeds: [createEmbed('No Results', 'No tracks found for that search', CONFIG.errorColor)] });
                    }

                    const track = searchResults.tracks[0];
                    track.requester = interaction.user;
                    
                    queue.addSong(track);
                    
                    if (queue.player.queue.size === 1 && !queue.player.playing && !queue.player.paused) {
                        queue.play();
                    }
                    
                    await interaction.editReply({ embeds: [createEmbed('🎵 Added to Queue', `[${track.title}](${track.uri}) by ${track.author}`, CONFIG.successColor)] });
                } catch (error) {
                    console.error('Play command error:', error);
                    await interaction.editReply({ embeds: [createEmbed('Error', `Failed to play: ${error.message}`, CONFIG.errorColor)] });
                }
                break;
            }
            case 'skip': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                const amount = interaction.options.getInteger('amount') || 1;
                queue.skip(amount);
                interaction.reply({ embeds: [createEmbed('⏭️ Skipped', `Skipped ${amount}`, CONFIG.successColor)] });
                break;
            }
            case 'pause': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                queue.pause();
                interaction.reply({ embeds: [createEmbed('⏸️ Paused', 'Paused', CONFIG.successColor)] });
                break;
            }
            case 'resume': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                queue.resume();
                interaction.reply({ embeds: [createEmbed('▶️ Resumed', 'Resumed', CONFIG.successColor)] });
                break;
            }
            case 'stop': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                queue.stop();
                interaction.reply({ embeds: [createEmbed('⏹️ Stopped', 'Queue cleared', CONFIG.successColor)] });
                break;
            }
            case 'queue': {
                if (!queue || !queue.player.queue.current) return interaction.reply({ embeds: [createEmbed('Queue', 'Empty', CONFIG.color)] });
                const page = (interaction.options.getInteger('page') || 1) - 1;
                const perPage = 10;
                const tracks = queue.player.queue.slice(0, queue.player.queue.size);
                const start = page * perPage;
                const desc = tracks.slice(start, start + perPage).map((track, i) => {
                    const idx = start + i;
                    return `${idx === 0 ? '▶️' : idx + 1}. [${track.title}](${track.uri}) | \`${formatDuration(track.duration / 1000)}\``;
                }).join('\n');
                interaction.reply({ embeds: [createEmbed(`📋 Queue (${tracks.length})`, desc || 'Empty', CONFIG.color)] });
                break;
            }
            case 'volume': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                const vol = interaction.options.getInteger('level');
                queue.setVolume(vol);
                interaction.reply({ embeds: [createEmbed('🔊 Volume', `${vol}%`, CONFIG.successColor)] });
                break;
            }
            case 'loop': {
                const mode = interaction.options.getString('mode') || 'none';
                loops.set(guildId, mode);
                interaction.reply({ embeds: [createEmbed('🔁 Loop', mode.toUpperCase(), CONFIG.successColor)] });
                break;
            }
            case 'shuffle': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'No queue', CONFIG.errorColor)], ephemeral: true });
                queue.shuffle();
                interaction.reply({ embeds: [createEmbed('🔀 Shuffled', 'Queue shuffled!', CONFIG.successColor)] });
                break;
            }
            case 'disconnect': {
                if (queue) queue.destroy();
                else if (voiceChannel) {
                    const conn = joinVoiceChannel({
                        channelId: voiceChannel.id,
                        guildId: guildId,
                        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                    });
                    conn.destroy();
                }
                interaction.reply({ embeds: [createEmbed('👋 Disconnected', 'Bye!', CONFIG.successColor)] });
                break;
            }
            case 'search': {
                const query = interaction.options.getString('query');
                await interaction.deferReply();
                
                try {
                    const searchResults = await manager.search(query, interaction.user);
                    
                    if (!searchResults || !searchResults.tracks || searchResults.tracks.length === 0) {
                        return interaction.editReply({ embeds: [createEmbed('No Results', 'No tracks found for that search', CONFIG.errorColor)] });
                    }
                    
                    const desc = searchResults.tracks.slice(0, CONFIG.searchLimit).map((track, i) => 
                        `${i + 1}. [${track.title}](${track.uri}) - ${track.author}`
                    ).join('\n');
                    
                    const embed = createEmbed(`🔍 Search Results for "${query}"`, desc, CONFIG.color);
                    embed.setFooter({ text: 'Use /play with the song name or URL to add to queue' });
                    
                    interaction.editReply({ embeds: [embed] });
                } catch (error) {
                    console.error('Search command error:', error);
                    interaction.editReply({ embeds: [createEmbed('Search Error', `Failed to search for "${query}": ${error.message}`, CONFIG.errorColor)] });
                }
                break;
            }
            case 'nowplaying': {
                if (!queue || !queue.player.queue.current) return interaction.reply({ embeds: [createEmbed('Nothing Playing', 'No song is currently playing', CONFIG.color)] });
                const song = queue.player.queue.current;
                const embed = new EmbedBuilder()
                    .setTitle('🎵 Now Playing')
                    .setDescription(`[${song.title}](${song.uri})`)
                    .addFields(
                        { name: 'Artist', value: song.author, inline: true },
                        { name: 'Duration', value: formatDuration(song.duration / 1000), inline: true },
                        { name: 'Requested by', value: `<@${song.requester?.id || 'Unknown'}>`, inline: true }
                    )
                    .setThumbnail(song.thumbnail)
                    .setColor(CONFIG.color);
                interaction.reply({ embeds: [embed] });
                break;
            }
            case 'remove': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'No queue', CONFIG.errorColor)], ephemeral: true });
                const position = interaction.options.getInteger('position');
                const removed = queue.remove(position);
                if (removed) {
                    interaction.reply({ embeds: [createEmbed('✅ Removed', `Removed [${removed.title}](${removed.url})`, CONFIG.successColor)] });
                } else {
                    interaction.reply({ embeds: [createEmbed('Error', 'Invalid position', CONFIG.errorColor)], ephemeral: true });
                }
                break;
            }
            case 'clear': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'No queue', CONFIG.errorColor)], ephemeral: true });
                queue.stop();
                interaction.reply({ embeds: [createEmbed('🗑️ Cleared', 'Queue cleared', CONFIG.successColor)] });
                break;
            }
            case 'autoplay': {
                const enabled = !autoplay.get(guildId);
                autoplay.set(guildId, enabled);
                interaction.reply({ embeds: [createEmbed('🎵 Autoplay', enabled ? 'Enabled' : 'Disabled', CONFIG.successColor)] });
                break;
            }
            case 'stats': {
                const playing = Array.from(queues.values()).filter(q => q.player.playing).length;
                interaction.reply({ embeds: [createEmbed('📊 Stats', `Servers: ${client.guilds.cache.size}\nPlaying: ${playing}\nUptime: ${formatDuration(Math.floor(client.uptime / 1000))}`, CONFIG.color)] });
                break;
            }
            case 'help': {
                interaction.reply({ embeds: [createEmbed('🎵 Spotify Music Commands', '/play (song name or Spotify track URL), /search, /nowplaying, /pause, /resume, /skip, /stop, /queue, /volume, /loop, /shuffle, /remove, /clear, /autoplay, /disconnect, /stats', CONFIG.color)] });
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
    const queue = queues.get(guildId);
    if (!queue) {
        return interaction.reply({ embeds: [createEmbed('Error', 'No active queue', CONFIG.errorColor)], ephemeral: true }).catch(() => {});
    }
    if (member.voice.channel?.id !== queue.voiceChannel.id) {
        return interaction.reply({ embeds: [createEmbed('Error', 'Join voice channel first!', CONFIG.errorColor)], ephemeral: true }).catch(() => {});
    }

    await interaction.deferUpdate().catch(() => {});
    
    switch (customId) {
        case 'prev':
            queue.previous();
            queue.broadcastUpdate();
            break;
        case 'pause':
            queue.pause();
            queue.broadcastUpdate();
            break;
        case 'skip':
            queue.skip();
            queue.broadcastUpdate();
            break;
        case 'stop':
            queue.stop();
            queue.broadcastUpdate();
            break;
        case 'loop': {
            const modes = ['none', 'track', 'queue'];
            const current = loops.get(guildId) || 'none';
            loops.set(guildId, modes[(modes.indexOf(current) + 1) % modes.length]);
            queue.broadcastUpdate();
            if (queue.player.queue.current) {
                queue.updateNowPlaying(queue.player.queue.current);
            }
            break;
        }
    }
}

// ==========================================
// EXPRESS SERVER + DASHBOARD API
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: ["https://audioquack.bot.nu", "http://localhost:3000"],
        credentials: true
    }
});

// Session middleware
app.use(session({
    secret: CONFIG.dashboardSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 86400000 } // Allow HTTP for development
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(cors({
    origin: ["https://audioquack.bot.nu", "http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true
}));
app.use(express.json());
app.use(express.static(__dirname));

// Passport Discord Strategy
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

// Auth middleware
const requireAuth = (req, res, next) => {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ error: 'Unauthorized' });
};

// Routes
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
        .filter(g => (g.permissions & 0x20) === 0x20 || (g.permissions & 0x8) === 0x8) // Manage Guild or Admin
        .map(g => ({
            ...g,
            botInGuild: client.guilds.cache.has(g.id),
            hasQueue: queues.has(g.id),
            isPlaying: queues.get(g.id)?.isPlaying || false
        }));
    res.json(userGuilds);
});

app.get('/api/guild/:id/queue', requireAuth, async (req, res) => {
    const queue = queues.get(req.params.id);
    if (!queue) return res.status(404).json({ error: 'No active queue' });
    res.json(queue.getDashboardData());
});

app.post('/api/guild/:id/control', requireAuth, async (req, res) => {
    const { action, data } = req.body;
    const queue = queues.get(req.params.id);
    if (!queue) return res.status(404).json({ error: 'No active queue' });

    // Verify user is in the guild
    const guild = client.guilds.cache.get(req.params.id);
    const member = await guild.members.fetch(req.user.id).catch(() => null);
    if (!member) return res.status(403).json({ error: 'Not in guild' });

    switch (action) {
        case 'play': await queue.play(); break;
        case 'pause': queue.pause(); break;
        case 'resume': queue.resume(); break;
        case 'skip': queue.skip(); break;
        case 'previous': queue.previous(); break;
        case 'stop': queue.stop(); break;
        case 'shuffle': queue.shuffle(); break;
        case 'volume': queue.setVolume(data.volume); break;
        case 'loop': loops.set(req.params.id, data.mode); queue.broadcastUpdate(); break;
        case 'autoplay': autoplay.set(req.params.id, data.enabled); queue.broadcastUpdate(); break;
        case 'remove': queue.remove(data.index); break;
        case 'jump': queue.jump(data.index); break;
        case 'add': {
            try {
                const results = await manager.search(data.query, queue.player);
                const track = results.tracks?.[0];
                if (track) {
                    await queue.addSong(track);
                    if (!queue.player.playing && !queue.player.paused) await queue.play();
                }
            } catch (error) {
                console.error('Dashboard add error:', error);
                // Optionally improve error handling for the dashboard flow
            }
            break;
        }
    }
    res.json({ success: true });
});

// Serve dashboard
app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', (req, res) => {
    // Redirect to dashboard if authenticated, otherwise show landing
    if (req.isAuthenticated()) {
        res.redirect('/dashboard');
    } else {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

// WebSocket handling
io.on('connection', (socket) => {
    console.log('Dashboard connected:', socket.id);
    
    socket.on('subscribe', (guildId) => {
        socket.join(`guild:${guildId}`);
        const queue = queues.get(guildId);
        if (queue) socket.emit('queueUpdate', queue.getDashboardData());
    });

    socket.on('unsubscribe', (guildId) => {
        socket.leave(`guild:${guildId}`);
    });

    socket.on('disconnect', () => {
        console.log('Dashboard disconnected:', socket.id);
    });
});

// Update presence every 5 minutes
setInterval(updatePresence, 300000);

// Start server
server.listen(CONFIG.port, () => {
    console.log(`🌐 Dashboard running on https://audioquack.bot.nu (port ${CONFIG.port})`);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});

// Login bot if a token is provided
if (!CONFIG.token) {
    console.warn('⚠️ No DISCORD_TOKEN provided. Starting dashboard only; Discord bot login is disabled.');
} else {
    client.login(CONFIG.token).catch(error => {
        console.error('Failed to login:', error);
        process.exit(1);
    });
}
