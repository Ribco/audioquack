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
    AudioPlayerStatus, VoiceConnectionStatus 
} = require('@discordjs/voice');
const play = require('play-dl');
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
    clientId: "1489574284572495944",
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID,
    spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    dashboardSecret: process.env.DASHBOARD_SECRET || 'super-secret-key-quack-quackify',
    callbackURL: process.env.CALLBACK_URL || 'https://audioquack.bot.nu/auth/discord/callback',
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
};

// ==========================================
// PLAY-DL SETUP
// ==========================================
if (CONFIG.spotifyClientId && CONFIG.spotifyClientSecret) {
    play.setToken({
        spotify: {
            client_id: CONFIG.spotifyClientId,
            client_secret: CONFIG.spotifyClientSecret,
        }
    });
    console.log('✅ Spotify integration enabled');
}

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

class MusicQueue {
    constructor(guildId, voiceChannel, textChannel) {
        this.guildId = guildId;
        this.voiceChannel = voiceChannel;
        this.textChannel = textChannel;
        this.songs = [];
        this.current = 0;
        this.player = createAudioPlayer();
        this.connection = null;
        this.volume = CONFIG.defaultVolume;
        this.isPlaying = false;
        this.startTime = null;
        this.pausedAt = null;
        
        this.player.on(AudioPlayerStatus.Idle, () => this.handleIdle());
        this.player.on(AudioPlayerStatus.Playing, () => {
            this.isPlaying = true;
            this.startTime = Date.now();
            this.broadcastUpdate();
        });
        this.player.on(AudioPlayerStatus.Paused, () => {
            this.isPlaying = false;
            this.pausedAt = Date.now();
            this.broadcastUpdate();
        });
        this.player.on('error', error => {
            console.error('Player error:', error);
            this.skip();
        });
    }

    async connect() {
        this.connection = joinVoiceChannel({
            channelId: this.voiceChannel.id,
            guildId: this.guildId,
            adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
        });
        this.connection.subscribe(this.player);
        
        this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000)),
                    new Promise(resolve => this.connection.once(VoiceConnectionStatus.Ready, resolve))
                ]);
            } catch {
                this.destroy();
            }
        });
        return this.connection;
    }

    async addSong(song) {
        if (this.songs.length >= CONFIG.maxQueueSize) throw new Error('Queue full');
        this.songs.push(song);
        this.broadcastUpdate();
        return this.songs.length;
    }

    async play(index = null) {
        if (index !== null) this.current = index;
        if (this.current >= this.songs.length) {
            if (loops.get(this.guildId) === 'queue') {
                this.current = 0;
            } else {
                this.handleQueueEnd();
                return;
            }
        }

        const song = this.songs[this.current];
        try {
            console.log(`Playing: ${song.title} (${song.url})`);
            
            let stream;
            if (song.url.includes('spotify.com')) {
                // For Spotify tracks, search for a streamable version
                try {
                    console.log(`Searching for streamable version of: ${song.title} by ${song.author}`);
                    const searchResults = await play.search(`${song.title} ${song.author}`, { 
                        limit: 1,
                        source: { youtube: 'video' } // Search YouTube for streaming
                    });
                    if (searchResults && searchResults[0]) {
                        console.log(`Found streamable version: ${searchResults[0].url}`);
                        stream = await play.stream(searchResults[0].url, { quality: 2 });
                    } else {
                        throw new Error('No streamable version found');
                    }
                } catch (searchError) {
                    console.log('Spotify search streaming failed:', searchError.message);
                    throw new Error(`Cannot find streamable version of Spotify track: ${searchError.message}`);
                }
            } else {
                stream = await play.stream(song.url, { quality: 2 });
            }
            
            if (!stream || !stream.stream) {
                throw new Error('Failed to get stream');
            }
            const resource = createAudioResource(stream.stream, { 
                inputType: stream.type,
                inlineVolume: true 
            });
            resource.volume.setVolume(this.volume / 100);
            this.player.play(resource);
            
            if (!history.has(this.guildId)) history.set(this.guildId, []);
            history.get(this.guildId).unshift(song);
            if (history.get(this.guildId).length > 50) history.get(this.guildId).pop();
            
            this.updateNowPlaying(song);
            this.broadcastUpdate();
        } catch (error) {
            console.error('Play error:', error);
            this.textChannel.send({ embeds: [createEmbed('Error', `Failed to play: ${song.title}\n${error.message}`, CONFIG.errorColor)] });
            this.skip();
        }
    }

    handleIdle() {
        const loopMode = loops.get(this.guildId) || 'none';
        if (loopMode === 'track') {
            this.play(this.current);
        } else {
            this.current++;
            this.play();
        }
    }

    handleQueueEnd() {
        this.isPlaying = false;
        if (autoplay.get(this.guildId) && CONFIG.enableAutoplay && this.songs.length > 0) {
            this.handleAutoplay();
        }
        this.broadcastUpdate();
    }

    async handleAutoplay() {
        const lastSong = this.songs[this.songs.length - 1];
        try {
            // Search for tracks by the same artist
            const search = await play.search(lastSong.author, { 
                limit: 1,
                source: { spotify: 'track' }
            });
            if (search[0]) {
                const song = await createSongFromSearch(search[0], client.user.id);
                await this.addSong(song);
                this.play();
            }
        } catch (error) {
            console.error('Autoplay error:', error);
            this.destroy();
        }
    }

    skip() {
        this.player.stop();
        this.broadcastUpdate();
    }

    previous() {
        if (this.current > 0) {
            this.current -= 2;
            this.player.stop();
        }
    }

    pause() {
        this.player.pause();
    }

    resume() {
        this.player.unpause();
    }

    stop() {
        this.songs = [];
        this.current = 0;
        this.player.stop();
        this.isPlaying = false;
        this.broadcastUpdate();
    }

    shuffle() {
        const current = this.songs[this.current];
        const remaining = this.songs.slice(this.current + 1);
        for (let i = remaining.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
        }
        this.songs = [...this.songs.slice(0, this.current + 1), ...remaining];
        this.broadcastUpdate();
    }

    setVolume(vol) {
        this.volume = Math.max(0, Math.min(CONFIG.maxVolume, vol));
        if (this.player.state.resource) {
            this.player.state.resource.volume.setVolume(this.volume / 100);
        }
        this.broadcastUpdate();
    }

    remove(index) {
        if (index > this.current && index < this.songs.length) {
            const removed = this.songs.splice(index, 1)[0];
            this.broadcastUpdate();
            return removed;
        }
        return null;
    }

    move(from, to) {
        if (from > this.current && to > this.current && from < this.songs.length && to < this.songs.length) {
            const [song] = this.songs.splice(from, 1);
            this.songs.splice(to, 0, song);
            this.broadcastUpdate();
            return true;
        }
        return false;
    }

    jump(index) {
        if (index >= 0 && index < this.songs.length) {
            this.current = index - 1;
            this.skip();
            return true;
        }
        return false;
    }

    destroy() {
        this.connection?.destroy();
        queues.delete(this.guildId);
        nowPlayingMessages.delete(this.guildId);
        this.broadcastUpdate();
    }

    getProgress() {
        if (!this.isPlaying || !this.startTime) return 0;
        const elapsed = (Date.now() - this.startTime) / 1000;
        return Math.min(elapsed, this.songs[this.current]?.durationSec || 0);
    }

    broadcastUpdate() {
        const data = this.getDashboardData();
        if (io) {
            io.to(`guild:${this.guildId}`).emit('queueUpdate', data);
        }
    }

    getDashboardData() {
        return {
            guildId: this.guildId,
            guildName: this.voiceChannel.guild.name,
            guildIcon: this.voiceChannel.guild.iconURL(),
            isPlaying: this.isPlaying,
            currentSong: this.songs[this.current] || null,
            queue: this.songs.slice(this.current + 1),
            history: (history.get(this.guildId) || []).slice(0, 10),
            volume: this.volume,
            loop: loops.get(this.guildId) || 'none',
            autoplay: autoplay.get(this.guildId) || false,
            progress: this.getProgress(),
            listeners: this.voiceChannel.members.size - 1, // Exclude bot
        };
    }

    async updateNowPlaying(song) {
        const embed = new EmbedBuilder()
            .setTitle('🎵 Now Playing')
            .setDescription(`[${song.title}](${song.url})`)
            .addFields(
                { name: 'Artist', value: song.author, inline: true },
                { name: 'Duration', value: song.duration, inline: true },
                { name: 'Requested by', value: `<@${song.requestedBy}>`, inline: true }
            )
            .setThumbnail(song.thumbnail)
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
            try { await oldMsg.delete(); } catch {}
        }
        const msg = await this.textChannel.send({ embeds: [embed], components: [row] });
        nowPlayingMessages.set(this.guildId, msg);
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
    new SlashCommandBuilder().setName('play').setDescription('Play Spotify tracks').addStringOption(opt => opt.setName('query').setDescription('Song name or Spotify track URL').setRequired(true)),
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
        activities: [{ name: `Spotify | ${guildCount} servers`, type: 2 }], // Listening
        status: 'dnd',
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
                    await queue.connect();
                } else if (queue.voiceChannel.id !== voiceChannel.id) {
                    return interaction.editReply({ embeds: [createEmbed('Error', 'Already playing elsewhere!', CONFIG.errorColor)] });
                }

                let searchResult;
                if (query.includes('spotify.com') || query.includes('open.spotify.com')) {
                    console.log(`Getting Spotify content for URL: ${query}`);
                    if (query.includes('/playlist/')) {
                        throw new Error('Playlists are not yet supported. Please use individual track URLs only.');
                    } else if (query.includes('/album/')) {
                        throw new Error('Albums are not yet supported. Please use individual track URLs only.');
                    } else if (query.includes('/track/')) {
                        try {
                            // For Spotify tracks, get basic info and then search for streamable version
                            const trackId = query.split('/track/')[1].split('?')[0];
                            console.log(`Processing Spotify track: ${trackId}`);
                            
                            // Create a basic track object for now - in a full implementation, 
                            // you'd use Spotify API to get track details
                            const basicTrack = {
                                id: trackId,
                                title: 'Spotify Track', // Placeholder
                                author: 'Unknown Artist', // Placeholder  
                                url: query,
                                duration_ms: 0,
                                thumbnail: 'https://i.scdn.co/image/ab67616d0000b273000000000000000000000000'
                            };
                            searchResult = { video_details: basicTrack };
                        } catch (error) {
                            console.error('Spotify track processing error:', error);
                            throw new Error(`Failed to process Spotify track: ${error.message}`);
                        }
                    } else {
                        throw new Error('Unsupported Spotify URL type. Please use individual track URLs.');
                    }
                } else if (query.includes('youtube.com') || query.includes('youtu.be')) {
                    throw new Error('YouTube is not supported. Please use Spotify tracks, playlists, or albums only!');
                } else {
                    console.log(`Searching Spotify for: ${query}`);
                    const results = await play.search(query, { 
                        limit: 1, 
                        source: { spotify: 'track' } 
                    });
                    if (!results || !results[0]) throw new Error('No Spotify results found for that search');
                    searchResult = { video_details: results[0] };
                }

                const song = await createSongFromSearch(searchResult.video_details, user.id);
                const position = await queue.addSong(song);
                
                if (position === 1 && !queue.isPlaying) {
                    await queue.play();
                    await interaction.editReply({ embeds: [createEmbed('🎵 Playing', `[${song.title}](${song.url})`, CONFIG.successColor)] });
                } else {
                    await interaction.editReply({ embeds: [createEmbed('✅ Added', `[${song.title}](${song.url}) - #${position}`, CONFIG.successColor)] });
                }
                break;
            }
            case 'skip': {
                if (!queue) return interaction.reply({ embeds: [createEmbed('Error', 'Nothing playing', CONFIG.errorColor)], ephemeral: true });
                const amount = interaction.options.getInteger('amount') || 1;
                queue.current += amount - 1;
                queue.skip();
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
                if (!queue || !queue.songs.length) return interaction.reply({ embeds: [createEmbed('Queue', 'Empty', CONFIG.color)] });
                const page = (interaction.options.getInteger('page') || 1) - 1;
                const perPage = 10;
                const start = page * perPage;
                const desc = queue.songs.slice(start, start + perPage).map((s, i) => {
                    const idx = start + i;
                    return `${idx === queue.current ? '▶️' : idx + 1}. [${s.title}](${s.url}) | \`${s.duration}\``;
                }).join('\n');
                interaction.reply({ embeds: [createEmbed(`📋 Queue (${queue.songs.length})`, desc || 'Empty', CONFIG.color)] });
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
                
                const results = await play.search(query, { 
                    limit: CONFIG.searchLimit,
                    source: { spotify: 'track' }
                });
                if (!results || results.length === 0) {
                    return interaction.editReply({ embeds: [createEmbed('No Results', 'No Spotify tracks found for that search', CONFIG.errorColor)] });
                }
                
                const desc = results.slice(0, CONFIG.searchLimit).map((song, i) => 
                    `${i + 1}. [${song.title}](${song.url}) - ${song.artist || song.author || 'Unknown'}`
                ).join('\n');
                
                const embed = createEmbed(`🔍 Spotify Search Results for "${query}"`, desc, CONFIG.color);
                embed.setFooter({ text: 'Use /play with the song name or Spotify URL to add to queue' });
                
                interaction.editReply({ embeds: [embed] });
                break;
            }
            case 'nowplaying': {
                if (!queue || !queue.songs[queue.current]) return interaction.reply({ embeds: [createEmbed('Nothing Playing', 'No song is currently playing', CONFIG.color)] });
                const song = queue.songs[queue.current];
                const embed = new EmbedBuilder()
                    .setTitle('🎵 Now Playing')
                    .setDescription(`[${song.title}](${song.url})`)
                    .addFields(
                        { name: 'Artist', value: song.author, inline: true },
                        { name: 'Duration', value: song.duration, inline: true },
                        { name: 'Requested by', value: `<@${song.requestedBy}>`, inline: true }
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
                const playing = Array.from(queues.values()).filter(q => q.isPlaying).length;
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
        interaction.reply({ embeds: [createEmbed('Error', error.message, CONFIG.errorColor)], ephemeral: true });
    }
});

async function handleButton(interaction) {
    const { customId, guildId, member } = interaction;
    const queue = queues.get(guildId);
    if (!queue) return;
    
    if (member.voice.channel?.id !== queue.voiceChannel.id) {
        return interaction.reply({ embeds: [createEmbed('Error', 'Join voice channel first!', CONFIG.errorColor)], ephemeral: true });
    }

    await interaction.deferUpdate().catch(() => {});
    
    switch (customId) {
        case 'prev': queue.previous(); break;
        case 'pause': queue.pause(); break;
        case 'skip': queue.skip(); break;
        case 'stop': queue.stop(); break;
        case 'loop': {
            const modes = ['none', 'track', 'queue'];
            const current = loops.get(guildId) || 'none';
            loops.set(guildId, modes[(modes.indexOf(current) + 1) % modes.length]);
            queue.updateNowPlaying(queue.songs[queue.current]);
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
            const results = await play.search(data.query, { 
                limit: 1,
                source: { spotify: 'track' }
            });
            if (results[0]) {
                const song = await createSongFromSearch(results[0], req.user.id);
                await queue.addSong(song);
                if (!queue.isPlaying) await queue.play();
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

// Login bot
client.login(CONFIG.token).catch(error => {
    console.error('Failed to login:', error);
    process.exit(1);
});
