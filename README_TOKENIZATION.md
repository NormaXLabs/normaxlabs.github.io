# Tokenization dApp Kit

This Astro project now includes a standalone copy of the tokenization dApp and an embedded Sepolia relayer API served by Astro.

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
- The Investor gasless flow and the Proxy Wallet section are now served by the same Astro project through `/api/relayer/*`.
- `npm run dev:sepolia` is enough for local development, provided the relayer env is present in `.env.sepolia.local`.
- The relayer API uses the website server process, so the browser no longer needs a second standalone relayer server.
- Public frontend env values are loaded from `.env.sepolia.local` / `.env.sepolia.example`.
