# Anagrama CLI

A terminal client for [Anagrama](https://playanagrama.com) - the daily word puzzle game.

## Installation

Run directly with npx (no install needed):

```bash
npx anagrama
```

Or install globally:

```bash
npm install -g anagrama
```

## Usage

Simply run `anagrama` to start the interactive menu:

```bash
anagrama
```

### Commands

- `anagrama` - Start interactive mode
- `anagrama login` - Link your Anagrama account
- `anagrama logout` - Remove local credentials
- `anagrama whoami` - Show current login
- `anagrama play` - Play today's puzzle directly

### In-Game Commands

While playing, type these commands:

- `/help` - Show all commands
- `/hint` - Get a hint (reveals one letter)
- `/shuffle` - Shuffle the available letters
- `/exit` - Return to menu
- `/quit` - Exit the app

### Options

- `-m, --minimal` - Use minimal output mode (less visual clutter)

## How to Play

1. You're given scrambled letters
2. Find the target word using those letters
3. You have 5 lives - wrong guesses cost a life
4. Find alternate anagrams for bonus points!

## Development

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/anagrama-cli.git
cd anagrama-cli

# Install dependencies
npm install

# Build
npm run build

# Run locally
npm start
```

## Config

Set `ANAGRAMA_URL` to point at a different server (default is `https://playanagrama.com`):

```bash
ANAGRAMA_URL=https://playanagrama.com anagrama play
```

## License

MIT
