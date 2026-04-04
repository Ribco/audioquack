# AudioQuack 🤖🎵

A modern Discord music bot with a real-time web dashboard for queue management.

## Features

- 🎵 High-quality music playback using Spotify
- 🎛️ Real-time dashboard with queue control
- 🔄 Loop, shuffle, and autoplay features
- 🎚️ Volume control and seeking
- 📱 Responsive web interface
- 🔐 Discord OAuth2 authentication
- 🌐 WebSocket real-time updates

## Setup

### Prerequisites

- Node.js 20+
- A Discord bot token
- Discord application with OAuth2 setup

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/audioquack.git
   cd audioquack
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy the environment file and configure it:
   ```bash
   cp .env.example .env
   # Edit .env with your bot token and secrets
   ```

4. Start the bot:
   ```bash
   npm start
   ```

### Environment Variables

See `.env.example` for required configuration.

### Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section and create a bot
4. Copy the token to `DISCORD_TOKEN`
5. Go to "OAuth2" section and copy client secret to `DISCORD_CLIENT_SECRET`
6. Set redirect URI to your callback URL (default: `https://audioquack.bot.nu/auth/discord/callback`)

### Deployment

The bot includes a built-in Express server for the dashboard. Deploy to a VPS or cloud service that supports persistent Node.js applications.

#### Using GitHub Actions (Recommended)

1. Set up a VPS with Node.js 20+ and PM2:
   ```bash
   # On your server
   sudo apt update
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   sudo npm install -g pm2
   ```

2. Clone your repository on the server:
   ```bash
   git clone https://github.com/yourusername/audioquack.git
   cd audioquack
   npm install
   # No need to create .env manually - the workflow handles it!
   ```

3. Create a `.env` file on your server with your secrets when deploying manually.

4. Add these secrets to your GitHub repository or to a GitHub environment named `production`:
   - `SERVER_HOST`: Your server's IP address or domain
   - `SERVER_USER`: SSH username (usually `root` or your user)
   - `SERVER_SSH_KEY`: Private SSH key (generate with `ssh-keygen`)
   - `SERVER_PORT`: SSH port (default 22)
   - `BOT_PATH`: Path to your bot directory on the server (default `/root/audioquack`)
   - `DISCORD_TOKEN`: Your Discord bot token
   - `DISCORD_CLIENT_SECRET`: Discord OAuth2 client secret
   - `DISCORD_CLIENT_ID`: Discord OAuth2 client ID (optional, defaults to the bundled AudioQuack application)
   - `DASHBOARD_SECRET`: Session secret for dashboard (optional, has default)
   - `CALLBACK_URL`: OAuth2 callback URL (optional, has default)
   - `BOT_PORT`: Port for the bot server (optional, default 3000)

> The `run.yml` workflow now uses GitHub environment secrets and generates a `.env` file automatically for the bot.

5. Add your public SSH key to the server's `~/.ssh/authorized_keys`

6. Push to main branch to trigger deployment

#### Manual Deployment

If you prefer manual deployment:

```bash
# On your server
git clone https://github.com/yourusername/audioquack.git
cd audioquack
npm install
cp .env.example .env
# Edit .env with your values
npm start
```

For production, use PM2:
```bash
npm install -g pm2
pm2 start index.js --name audioquack
pm2 save
pm2 startup
```

**Note**: When using GitHub Actions deployment, the `.env` file is automatically created with your GitHub secrets, so manual `.env` creation is not needed.

## Commands

- `/play <query>` - Play music from Spotify (tracks, playlists, albums)
- `/pause` - Pause playback
- `/resume` - Resume playback
- `/skip` - Skip current song
- `/stop` - Stop and clear queue
- `/queue` - Show current queue
- `/volume <level>` - Set volume (0-200)
- `/loop <mode>` - Set loop mode (none/track/queue)
- `/shuffle` - Shuffle queue
- And many more...

## Dashboard

Access the web dashboard at `http://localhost:3000` (or your configured port) to control the bot in real-time.

## License

MIT
