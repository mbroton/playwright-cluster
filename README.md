<p align="center">
  <img src="assets/logo.png" alt="Playwright-Distributed logo" width="160">
</p>

<h1 align="center">playwright-distributed</h1>

<p align="center">
  <strong>Self-hosted, horizontally-scalable <a href="https://playwright.dev/">Playwright</a> grid.</strong><br/>
  Spin up as many browser workers as you need on your own infrastructure and access them through a single WebSocket endpoint.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/mbroton/playwright-distributed?color=blue" alt="License"></a>
</p>

<p align="center">
  <em>This project is currently in beta.</em>
</p>

---

## Why use playwright-distributed?
- Single WebSocket endpoint routes each session through a smart selector that balances load *and* staggers worker restarts.
- Warm Chromium instances - no waiting for browser startup.
- Each connection gets a fresh, isolated browser context.
- Stateless design: add or remove workers at any time; Redis is the only shared component.
- Works with any Playwright client.

### Motivation

Modern teams often need **many concurrent browsers**: scraping pipelines, AI agents, CI test suites, synthetic monitors… Spawning a fresh headless browser for every task wastes tens of seconds and huge amounts of memory. Existing SaaS grids solve this but:

1. You may not want to ship data to a third-party cloud.
2. Vendor pricing scales linearly with sessions.
3. Latency to a remote grid quickly adds up.

`playwright-distributed` lets you run **your own grid** with Docker-simple deployment:

- Keep data on your infrastructure.
- Pay only for the compute you actually run (add/remove workers on demand).
- Share one endpoint across languages, teams and use-cases.


## 🚀 Quick Start (Local)

```bash
# 1. Grab the repo
git clone https://github.com/mbroton/playwright-distributed.git
cd playwright-distributed

# 2. Fire it up (proxy + 1 worker + Redis)
docker compose up -d
```

Connect from your code:

```js
import { chromium } from 'playwright';

const browser = await chromium.connect('ws://localhost:8080');
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('https://example.com');
console.log(await page.title());
await browser.close();
```
That's it! The same `ws://localhost:8080` endpoint works with any Playwright client (Node.js, Python, Java, .NET, etc.).


## 🛠 Use Cases

| Scenario | Benefit |
|----------|---------|
| **AI / LLM agents** | Give each agent an isolated browser with zero startup cost. |
| **Web scraping / data collection** | Crawl at scale; add workers to raise throughput, remove them to save money. |
| **CI end-to-end tests** | Parallelise test runs across many browsers and cut build times dramatically. |
| **Synthetic monitoring** | Continuously exercise critical user journeys from multiple regions. |
| **Shared “browser-as-a-service”** | One endpoint for your whole team – no more local browser zoo. |


## ⚙️ Production Deployment

Run each component (proxy, Redis, workers) as independent services (Docker/K8s). Checklist:

- **Networking**
  - Workers ➜ Redis (register, heartbeats)
  - Proxy ➜ Redis (worker discovery)
  - Proxy ➜ Workers (WebSocket forward)
- **Exposure** – expose **only the proxy**.
- **Scaling** – add or remove workers freely; the proxy always chooses the next worker according to the staggered-restart algorithm.


## 📚 Usage Examples

### Node.js

```js
import { chromium } from 'playwright';

const browser = await chromium.connect('ws://localhost:8080');
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('https://example.com');
console.log(await page.title());
await browser.close();
```

### Python

```python
from playwright.async_api import async_playwright
import asyncio

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.connect('ws://localhost:8080')
        context = await browser.new_context()
        page = await context.new_page()
        await page.goto('https://example.com')
        print(await page.title())
        await browser.close()

asyncio.run(main())
```

> Any Playwright-compatible client can connect to the same `ws://localhost:8080` endpoint.


## 🏗 Architecture

```mermaid
flowchart TD
    Client[(Your Playwright code)] -->|WebSocket| Proxy

    subgraph playwright-distributed
        direction LR

        Proxy -->|select worker| Redis[(Redis)]
        Proxy <--> workerGroup

        subgraph workerGroup [Workers]
            direction LR
            Worker1(Worker)
            Worker2(Worker)
            WorkerN(...)
        end

        Worker1 --> Redis
        Worker2 --> Redis
        WorkerN --> Redis
    end
```

### Session Handling

1. **One connection → One context** – every websocket maps to a unique browser context.
2. **Concurrent sessions** – each worker serves several contexts in parallel.
3. **Recycling** – after serving a configurable number of sessions the worker shuts down; Docker/K8s restarts it, guaranteeing a fresh Chromium.
4. **Smart worker selection** – the proxy’s algorithm keeps workers from hitting their restart threshold at the same time and still favours the busiest eligible worker.


## 🤝 Contributing

Found a bug? Have an idea for improvement? PRs and issues are welcome!

## 📜 License

This project is licensed under the [MIT License](LICENSE).