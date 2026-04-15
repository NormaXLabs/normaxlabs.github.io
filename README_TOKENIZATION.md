# Tokenization dApp Kit

This Astro project now includes a standalone copy of the tokenization dApp and the Sepolia relayer server.

## Install dependencies

```bash
npm install
```

## Configure Sepolia

Create:

```text
.env.sepolia.local
```

You can start from:

```text
.env.sepolia.example
```

The repository already includes a ready-to-use `.env.sepolia.local` with the current public Sepolia addresses.

The only secret you must add is:

```text
SEPOLIA_PRIVATE_KEY=0x...
```

All contract addresses in the example file are already set to the current deployed Sepolia contracts.

## Run the Sepolia relayer server

```bash
make server:sepolia
```

The relayer listens by default on:

```text
http://127.0.0.1:3000
```

## Run the Astro website

```bash
npm run dev:sepolia
```

Then open:

```text
http://localhost:4321/tokenization-platform
```

## Notes

- The mounted page uses the full React dApp.
- The Investor gasless flow requires the relayer server.
- Public frontend env values are loaded from `.env.sepolia.local` / `.env.sepolia.example`.
