# Nika-agent

Nika Agent is a local browser workflow orchestrator for managing multiple signed-in ChatGPT web chats without the OpenAI API.

## Current implemented core

- WXT + TypeScript + Manifest V3 foundation;
- agent registry with roles, ChatGPT URLs, prompts and schedules;
- `chrome.alarms` interval/one-shot scheduling foundation;
- reuse or background creation of target ChatGPT tabs;
- generation-state detection and idle waiting;
- prompt submission through a dedicated ChatGPT DOM adapter;
- capture of the latest assistant response;
- workflow engine with `send`, `wait_idle`, `capture`, `forward` and `delay` steps;
- bounded execution log in `chrome.storage.local`;
- keyboard/NVDA-oriented popup for chat creation, editing, deletion and manual runs.

## Example workflow

Developer chat -> wait for completion -> capture response -> forward response to auditor chat -> auditor continues work.

## Development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
npm run zip
```

## Documentation

- `docs/ARCHITECTURE.md` — runtime design and reliability/security rules.
- `docs/RESEARCH.md` — evaluated open-source projects and reuse decisions.

## Important boundary

Nika Agent automates the ChatGPT web interface using the user's existing signed-in browser session. It does not store ChatGPT credentials and does not call the OpenAI API.
