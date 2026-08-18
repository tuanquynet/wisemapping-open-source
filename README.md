# WiseMapping Open Source

WiseMapping is a free, open-source, web-based mind mapping tool designed for individuals, teams, and educational institutions. It enables users to create, share, and collaborate on mind maps in real-time, facilitating brainstorming sessions, project planning, and knowledge management. Built with modern open standards technologies like SVG and React, WiseMapping provides a versatile and user-friendly platform to visualize and organize complex information effectively. The open-source codebase powers https://www.wisemapping.com, ensuring reliability and continuity in its development.

## 🎯 Capabilities

WiseMapping provides a comprehensive set of features for creating, managing, and sharing mind maps:

- **🎨 Visual Mapping**: Create rich mind maps with icons, colors, fonts, and custom styling
- **👥 Collaboration**: Share mind maps with team members with role-based access control
- **📱 Multi-platform**: Access your maps from any device with a modern web browser
- **📊 Export & Import**: Import existing maps from Freeplane, XMind, and Mind Manager. Export mind maps to PDF, SVG, Freeplane, and other formats
- **🔗 Document Linking**: Integrate external documents and resources into your mind maps
- **📤 Embed & Share**: Easily embed mind maps into web pages, blogs, and documentation
- **🆓 100% Free**: Access all features without any restrictions
- **🔍 Search & Navigation**: Quickly find content across all your mind maps
- **📝 Rich Content**: Add detailed notes, links, and formatted text to nodes
- **🔒 Self-hosted**: Complete control over your data with on-premise deployment
- **🌐 Multi-language**: Available in multiple languages (English, Spanish, French, German, Italian, Russian, Chinese, and more)
- **🔌 REST API**: Full REST API built with Bun, Hono, and TypeScript
- **📈 User Management**: Authentication, JWT tokens, and account management
- **💾 Embedded Persistence**: Built-in SQLite database (`bun:sqlite`), no external database server required
- **🐳 Docker Deployment**: Production-ready Docker images available on [Docker Hub](https://hub.docker.com/r/wisemapping/wisemapping)

## Development (Local)

The following steps are intended for local development.

### Prerequisites

- **Bun** (v1.x or higher — [https://bun.sh](https://bun.sh))
- **Node.js** (v24 or higher)
- **Yarn** (v4 or higher)

---

### Step 1: Start Backend API (`wise-api-bun`)

The REST API backend lives under `wise-api-bun/`.

```sh
cd wise-api-bun

# Install dependencies
bun install

# Configure environment variables
cp .env.example .env
echo "JWT_SECRET=$(openssl rand -base64 48)" >> .env

# Start development server (runs on http://localhost:8080)
bun run dev
```

Run tests & typechecks:
```sh
bun test
bun run typecheck
```

---

### Step 2: Start Frontend (`wisemapping-frontend`)

Checkout `https://github.com/wisemapping/wisemapping-frontend` alongside this repository:

```sh
export NODE_OPTIONS=--openssl-legacy-provider
export APP_CONFIG_TYPE="file:dev"

cd wisemapping-frontend
yarn install 
yarn build

cd packages/webapp
yarn start
```

Application will be available at http://localhost:3000/c/login.

---

## Configuration

The backend is configured via environment variables (`.env` file in `wise-api-bun/`):

- `PORT` — server port (default: `8080`).
- `JWT_SECRET` — **Required**. JWT signing key.
- `DATABASE_PATH` — SQLite database file location (default: `./data/wisemapping.db`).
- `EMAIL_CONFIRMATION_ENABLED` — set to `true` to enable email confirmations (activation links logged to stdout).
- `SITE_BASE_URL` — base URL used for links (default: `http://localhost:8080`).

---

# Members

## Founders

   * Paulo Veiga <pveiga@wisemapping.com>
   * Pablo Luna <pablo@wisemapping.com>

## Past Individual Contributors

   * Ezequiel Bergamaschi <ezequielbergamaschi@gmail.com>
   
## License

The source code is Licensed under the WiseMapping Open License, Version 1.0 (the “License”);
You may obtain a copy of the License at: [https://github.com/wisemapping/wisemapping-open-source/blob/develop/LICENSE.md](https://github.com/wisemapping/wisemapping-open-source/blob/develop/LICENSE.md)

---

## 📚 Documentation

- **[CLAUDE.md](CLAUDE.md)** — Guide for AI coding assistants working in this repository
- **[API Documentation](doc/api-documentation/README.md)** — REST API reference and details