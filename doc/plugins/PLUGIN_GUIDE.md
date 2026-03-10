# Paperclip Plugin System — Design & Developer Guide

Status: post-V1 target architecture
Companion documents: [PLUGIN_SPEC.md](./PLUGIN_SPEC.md), [ideas-from-opencode.md](./ideas-from-opencode.md)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture Map](#2-architecture-map)
3. [Plugin Types](#3-plugin-types)
4. [Plugin Manifest](#4-plugin-manifest)
5. [Plugin SDK](#5-plugin-sdk)
6. [Trust Model & Capabilities](#6-trust-model--capabilities)
7. [Extension Surfaces](#7-extension-surfaces)
   - 7.1 [Adapter Plugins](#71-adapter-plugins)
   - 7.2 [Storage Provider Plugins](#72-storage-provider-plugins)
   - 7.3 [Secret Provider Plugins](#73-secret-provider-plugins)
   - 7.4 [Connector Plugins](#74-connector-plugins)
   - 7.5 [Agent Tool Plugins](#75-agent-tool-plugins)
   - 7.6 [UI Extension Plugins](#76-ui-extension-plugins)
8. [Event Bus](#8-event-bus)
9. [Plugin Persistence](#9-plugin-persistence)
10. [Plugin Lifecycle](#10-plugin-lifecycle)
11. [Hot Reload](#11-hot-reload)
12. [Development Workflow](#12-development-workflow)
13. [Testing Plugins](#13-testing-plugins)
14. [Reference Examples](#14-reference-examples)

---

## 1. Overview

Paperclip's plugin system uses **multiple extension classes** rather than a single generic hook bag. Each class has:

- a well-defined interface with TypeScript types
- its own trust level and capability gate
- deterministic load order
- isolated failure (one bad plugin does not crash the server)

Plugins are **global to the instance**. There are no per-company plugin installations. "Companies" are organizational records — they are not plugin trust boundaries.

Paperclip core retains exclusive ownership of:
- board governance
- approval gates
- budget hard-stops
- heartbeat and run lifecycle invariants
- agent session state

Plugins extend Paperclip by contributing new **capabilities** — they do not override or shadow core business logic.

---

## 2. Architecture Map

The following extension seams already exist in the codebase and are the foundation for the plugin system:

```
server/src/adapters/registry.ts          ← adapter plugin registry
server/src/storage/provider-registry.ts  ← storage provider registry
server/src/secrets/provider-registry.ts  ← secret provider registry
server/src/services/run-log-store.ts     ← run-log backend (extensible)
server/src/services/activity-log.ts      ← activity/event log (extensible)
packages/adapter-utils/src/types.ts      ← ServerAdapterModule interface
packages/adapter-utils/src/server-utils  ← shared adapter utilities
```

Each registry is currently a **static import map**. The plugin system converts these to **dynamic registries** that can accept plugin-contributed modules at boot time (or at runtime for hot-installed plugins).

The addition required for a full plugin system:

```
server/src/plugins/                      ← NEW: plugin loader and registry
  loader.ts                              ← discovers and loads plugin packages
  registry.ts                            ← runtime plugin registry
  event-bus.ts                           ← typed event bus for plugin hooks
  sandbox.ts                             ← execution context (capability checks)
  scheduler.ts                           ← plugin-contributed cron jobs
packages/plugin-sdk/                     ← NEW: @paperclipai/plugin-sdk
  src/index.ts                           ← public SDK surface
  src/types.ts                           ← all plugin interface types
  src/tool.ts                            ← tool() helper
  src/event.ts                           ← event subscription helpers
db/                                      ← existing Drizzle ORM schemas
  plugin_installations table             ← tracks installed plugins + config
  plugin_data table                      ← per-plugin key-value persistence
  plugin_job_runs table                  ← job execution audit trail
```

---

## 3. Plugin Types

Six plugin classes are supported. Each class maps to a distinct extension surface:

| Class | Runs | Trust Level | Primary Interface |
|---|---|---|---|
| **Adapter** | In-process | Operator (built-in) | `ServerAdapterModule` |
| **Storage Provider** | In-process | Operator | `StorageProvider` |
| **Secret Provider** | In-process | Operator | `SecretProviderModule` |
| **Connector** | Out-of-process | Plugin | `ConnectorPlugin` |
| **Agent Tool** | Out-of-process | Plugin | `AgentToolPlugin` |
| **UI Extension** | Browser (ESM) | Plugin | `UIExtensionPlugin` |

**In-process (Operator trust):** The plugin runs inside the Paperclip server process. It is loaded from a local npm package by a trusted operator. It has full Node.js access. No capability sandbox applies — operator takes full responsibility.

**Out-of-process (Plugin trust):** The plugin is invoked via a defined RPC protocol (HTTP or stdio). Capability gates are enforced. The plugin cannot directly access the database.

**Browser (ESM, Plugin trust):** A React component bundle loaded into declared UI extension slots. It communicates with the server via the standard Paperclip API, using the agent's or user's own auth token. No direct server access.

---

## 4. Plugin Manifest

Every plugin is an npm-compatible package with a `plugin.json` manifest at its root (sibling to `package.json`):

```jsonc
{
  "id": "my-org.my-plugin",           // globally unique, reverse-domain style
  "name": "My Plugin",                // human-readable display name
  "version": "1.0.0",                 // semver
  "description": "Does something useful",
  "author": "My Org <info@example.com>",
  "homepage": "https://example.com/plugin",

  // The plugin class determines load strategy and trust level.
  // Exactly one of these sections must be present.

  // Option A: Adapter plugin (in-process, operator trust)
  "adapter": {
    "entry": "./dist/server/index.js",
    "type": "my_adapter"              // the adapterType string used in agent config
  },

  // Option B: Storage provider plugin (in-process, operator trust)
  "storageProvider": {
    "entry": "./dist/server/index.js",
    "id": "my_storage"
  },

  // Option C: Secret provider plugin (in-process, operator trust)
  "secretProvider": {
    "entry": "./dist/server/index.js",
    "id": "my_secrets"
  },

  // Option D: Connector plugin (out-of-process)
  "connector": {
    "entry": "./dist/server/index.js",   // Node.js process to spawn, OR
    "url": "http://localhost:9100",      // existing HTTP service to connect to
    "transport": "stdio" | "http",

    // Capabilities this plugin needs. Must be declared up front.
    "capabilities": [
      "issues:read",
      "issues:write",
      "comments:write",
      "webhooks:register",
      "agent_tools:contribute",
      "ui:contribute"
    ],

    // Event subscriptions this plugin handles.
    "events": [
      "issue.created",
      "issue.assigned",
      "heartbeat_run.completed",
      "approval.requested"
    ],

    // Scheduled jobs this plugin runs.
    "jobs": [
      { "id": "sync", "cron": "*/15 * * * *", "description": "Sync external issues" }
    ],

    // UI extension slots this plugin contributes to (optional).
    "ui": {
      "entry": "./dist/ui/index.js",
      "slots": ["issue.detail.sidebar", "agent.detail.tab"]
    }
  },

  // Option E: Agent tool plugin (out-of-process)
  "agentTool": {
    "entry": "./dist/server/index.js",
    "transport": "stdio" | "http",
    "capabilities": ["filesystem:read", "http:outbound"]
  },

  // Option F: UI Extension plugin (browser only, no server process)
  "uiExtension": {
    "entry": "./dist/ui/index.js",
    "slots": ["issue.detail.sidebar", "dashboard.widget"]
  },

  // Minimum Paperclip server version required.
  "minPaperclipVersion": "2.0.0",

  // Settings schema exposed in the admin UI.
  "settings": {
    "type": "object",
    "properties": {
      "apiKey": {
        "type": "string",
        "title": "API Key",
        "description": "Your service API key",
        "secret": true             // stored in the secrets provider, not plain DB
      },
      "syncIntervalMinutes": {
        "type": "number",
        "title": "Sync interval (minutes)",
        "default": 15
      }
    },
    "required": ["apiKey"]
  }
}
```

### Plugin package layout

```
my-plugin/
├── plugin.json           ← manifest (required)
├── package.json          ← npm package (required)
├── dist/
│   ├── server/
│   │   └── index.js      ← server entry point
│   └── ui/
│       └── index.js      ← UI bundle (connector/UI plugins only)
├── src/
│   ├── server/
│   │   └── index.ts
│   └── ui/
│       └── index.tsx
└── tsconfig.json
```

---

## 5. Plugin SDK

The `@paperclipai/plugin-sdk` package provides all types and helpers needed to author any plugin class.

```ts
// packages/plugin-sdk/src/index.ts (public surface)
export type {
  // Core manifest / registration
  PluginManifest,
  PluginContext,
  PluginSettings,

  // Adapter class
  ServerAdapterModule,
  AdapterExecutionContext,
  AdapterExecutionResult,

  // Storage class
  StorageProvider,
  StorageObject,

  // Secret class
  SecretProviderModule,
  SecretDescriptor,

  // Connector class
  ConnectorPlugin,
  ConnectorContext,
  ConnectorEventHandler,
  ConnectorJob,

  // Agent tool class
  AgentToolPlugin,
  AgentToolContext,
  AgentToolDefinition,

  // UI extension class
  UIExtensionPlugin,
  UIExtensionSlot,
  UIExtensionContext,

  // Event bus
  PaperclipEvent,
  EventType,
  EventHandler,

  // API client (for connector and UI plugins)
  PaperclipApiClient,
  IssueRef,
  AgentRef,
  RunRef,
  CommentRef,
} from "./types.js";

export {
  defineAdapterPlugin,
  defineConnectorPlugin,
  defineAgentToolPlugin,
  defineUIExtension,
  tool,
  event,
} from "./helpers.js";
```

### The `defineConnectorPlugin` helper (most common entry point)

```ts
import { defineConnectorPlugin, tool, event } from "@paperclipai/plugin-sdk";

export default defineConnectorPlugin({
  // Called once on plugin startup. Use to verify config and set up connections.
  async init(ctx) {
    ctx.log.info("Plugin started, settings:", ctx.settings);
    // ctx.api is a typed Paperclip API client
    // ctx.settings contains validated settings from plugin.json schema
    // ctx.secrets.get("apiKey") returns the secret value
  },

  // Event handlers: object keyed by event type
  events: {
    "issue.created": event(async (ctx, payload) => {
      // payload is typed based on the event schema
      await ctx.api.issues.addComment(payload.issue.id, {
        body: `Issue synced to external system.`,
      });
    }),

    "heartbeat_run.completed": event(async (ctx, payload) => {
      // notify external system of run completion
    }),
  },

  // Scheduled jobs: object keyed by job id from manifest
  jobs: {
    sync: async (ctx) => {
      // runs on the cron defined in plugin.json
      const externalIssues = await fetchExternalIssues(ctx.settings.apiKey);
      for (const issue of externalIssues) {
        await ctx.api.issues.upsert({ externalId: issue.id, title: issue.title });
      }
    },
  },

  // Agent tools: namespace-prefixed, cannot shadow core tools
  tools: [
    tool({
      name: "myplugin:search_issues",   // namespace prefix required
      description: "Search issues in the external system.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
      async execute(ctx, params) {
        const results = await searchExternal(params.query, ctx.settings.apiKey);
        return { results };
      },
    }),
  ],

  // Called on graceful shutdown
  async teardown(ctx) {
    // close connections, flush buffers
  },
});
```

---

## 6. Trust Model & Capabilities

### Trust levels

**Operator trust (in-process plugins)**
- Adapter, storage provider, and secret provider plugins are loaded directly as Node.js modules.
- They run in the server process with full access to the filesystem, network, and database.
- They are authored and installed by the operator who runs the Paperclip instance.
- No capability sandbox. Operator accepts full responsibility.
- These are intended to be first-party or thoroughly reviewed packages.

**Plugin trust (out-of-process plugins)**
- Connector and agent tool plugins run as separate processes or remote services.
- They communicate with Paperclip via a typed RPC protocol.
- They must declare their capability requirements in `plugin.json`.
- The capability sandbox is enforced server-side: unclaimed capabilities are rejected.
- Plugin API tokens are scoped to declared capabilities.

**Browser trust (UI extensions)**
- UI extension bundles are loaded in the browser as ES modules.
- They call the standard Paperclip REST API using the user's session token.
- They have no additional privileges beyond the logged-in user.
- They cannot access the server filesystem or database directly.

### Capability list

Capabilities are declared in `plugin.json` under `connector.capabilities` or `agentTool.capabilities`.

```
issues:read             Read issues, comments, projects, assignees
issues:write            Create/update issues and comments
agents:read             Read agent configurations and run history
agents:wake             Trigger agent wakes (on_demand runs)
approvals:read          Read approval requests
approvals:decide        Approve or reject approval requests
webhooks:register       Register inbound webhook endpoints
agent_tools:contribute  Contribute tools to the agent tool registry
ui:contribute           Contribute UI components to extension slots
secrets:read_own        Read the plugin's own configured secrets
storage:read            Read from run log storage
storage:write           Write to run log storage
http:outbound           Make outbound HTTP requests (connector process)
filesystem:read         Read local files (agent tool subprocess only)
filesystem:write        Write local files (agent tool subprocess only)
```

Requesting `*` (wildcard) is not allowed. Capabilities must be explicitly declared.

---

## 7. Extension Surfaces

### 7.1 Adapter Plugins

Adapter plugins add new agent runtime types (e.g., a new AI coding CLI). They are in-process, operator-trust plugins.

**When to write one:** You want Paperclip to run a new local CLI tool, an HTTP-based agent service, or any execution runtime not already supported.

**Interface** (from `packages/adapter-utils/src/types.ts`):

```ts
export interface ServerAdapterModule {
  // Unique string identifier. Used in agent adapterType field.
  type: string;

  // Execute one agent run. Called by the heartbeat service.
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;

  // (Optional) Test the local environment before allowing agents to be created.
  testEnvironment?(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;

  // (Optional) Codec for serializing/deserializing session state across runs.
  sessionCodec?: AdapterSessionCodec;

  // (Optional) Static list of supported models.
  models?: AdapterModel[];

  // (Optional) Dynamic model discovery (called by the UI model picker).
  listModels?(): Promise<AdapterModel[]>;

  // Whether this adapter supports the local agent JWT for server callbacks.
  supportsLocalAgentJwt: boolean;

  // Markdown documentation shown in the agent creation UI.
  agentConfigurationDoc?: string;
}
```

**Step-by-step: adding a new adapter**

**Step 1.** Create a new package under `packages/adapters/`:

```
packages/adapters/my-adapter/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           ← public exports (type, label, models, agentConfigurationDoc)
│   └── server/
│       ├── execute.ts     ← execute() implementation
│       ├── test.ts        ← testEnvironment() implementation (optional)
│       ├── parse.ts       ← output parser for your CLI's JSONL format
│       └── models.ts      ← model discovery (optional)
```

**Step 2.** Implement `packages/adapters/my-adapter/src/index.ts`:

```ts
export const type = "my_adapter";
export const label = "My Adapter";
export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `
# my_adapter agent configuration

Adapter: my_adapter

Use when:
- You want Paperclip to run MyTool locally as the agent runtime.

Core fields:
- command (string, optional): defaults to "mytool"
- model (string, optional): model to use
- cwd (string, optional): working directory
- env (object, optional): environment variables
`;
```

**Step 3.** Implement `packages/adapters/my-adapter/src/server/execute.ts`:

```ts
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  buildPaperclipEnv,
  ensureCommandResolvable,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  runChildProcess,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const command = asString(config.command, "mytool");
  const model = asString(config.model, "default-model");
  const cwd = asString(config.cwd, process.cwd());

  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  await ensureCommandResolvable(command, cwd, process.env as Record<string, string>);

  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    PAPERCLIP_RUN_ID: runId,
  };
  if (authToken) env.PAPERCLIP_API_KEY = authToken;

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env }))
      .filter((e): e is [string, string] => typeof e[1] === "string"),
  );

  const prompt = renderTemplate(
    asString(config.promptTemplate, "Continue your Paperclip work."),
    { agent, context },
  );

  const args = ["--model", model, "--prompt", prompt];

  if (onMeta) {
    await onMeta({ adapterType: "my_adapter", command, cwd, commandArgs: args, env, prompt, context });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env: runtimeEnv,
    timeoutSec: asNumber(config.timeoutSec, 0),
    graceSec: asNumber(config.graceSec, 20),
    onLog,
  });

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    errorMessage: (proc.exitCode ?? 0) === 0 ? null : proc.stderr.split("\n")[0],
    summary: proc.stdout.trim().slice(0, 2000),
  };
}
```

**Step 4.** Register in `server/src/adapters/registry.ts`:

```ts
import {
  execute as myExecute,
  testEnvironment as myTestEnvironment,
} from "@paperclipai/adapter-my-adapter/server";
import { agentConfigurationDoc as myDoc, models as myModels } from "@paperclipai/adapter-my-adapter";

const myAdapter: ServerAdapterModule = {
  type: "my_adapter",
  execute: myExecute,
  testEnvironment: myTestEnvironment,
  models: myModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: myDoc,
};

// Add to adaptersByType map:
const adaptersByType = new Map<string, ServerAdapterModule>([
  // ...existing adapters...
  [myAdapter.type, myAdapter],
]);
```

**Step 5.** Add to `pnpm-workspace.yaml` and run `pnpm install`.

**Step 6.** (Optional) Add to UI adapter registry in `ui/src/adapters/registry.ts` for the agent creation wizard.

---

### 7.2 Storage Provider Plugins

Storage provider plugins add new backends for run log storage (e.g., Azure Blob, GCS, a custom database).

**When to write one:** You need run logs stored somewhere other than local disk or S3.

**Interface** (`server/src/storage/types.ts`):

```ts
export interface StorageProvider {
  // Write a run log. Returns the object key.
  put(key: string, body: string | Buffer, contentType?: string): Promise<void>;

  // Read a run log by key.
  get(key: string): Promise<string | Buffer | null>;

  // Generate a time-limited signed URL for direct browser download.
  signedUrl(key: string, expiresInSeconds: number): Promise<string | null>;

  // Delete a run log.
  delete(key: string): Promise<void>;

  // List keys with a prefix (for cleanup/migration tools).
  list(prefix: string): Promise<string[]>;
}
```

**Step-by-step: adding a new storage provider**

**Step 1.** Create `server/src/storage/my-provider.ts`:

```ts
import type { StorageProvider } from "./types.js";

interface MyProviderConfig {
  connectionString: string;
  container: string;
}

export function createMyStorageProvider(config: MyProviderConfig): StorageProvider {
  const client = new MyStorageClient(config.connectionString);

  return {
    async put(key, body, contentType = "text/plain") {
      await client.upload(config.container, key, body, contentType);
    },

    async get(key) {
      return client.download(config.container, key);
    },

    async signedUrl(key, expiresInSeconds) {
      return client.generateSasUrl(config.container, key, expiresInSeconds);
    },

    async delete(key) {
      await client.delete(config.container, key);
    },

    async list(prefix) {
      return client.listBlobs(config.container, prefix);
    },
  };
}
```

**Step 2.** Add the new provider ID to `packages/shared/src/config.ts`:

```ts
export const STORAGE_PROVIDERS = ["local_disk", "s3", "my_storage"] as const;
export type StorageProviderType = typeof STORAGE_PROVIDERS[number];
```

**Step 3.** Register in `server/src/storage/provider-registry.ts`:

```ts
import { createMyStorageProvider } from "./my-provider.js";

export function createStorageProviderFromConfig(config: Config): StorageProvider {
  if (config.storageProvider === "local_disk") {
    return createLocalDiskStorageProvider(config.storageLocalDiskBaseDir);
  }
  if (config.storageProvider === "my_storage") {
    return createMyStorageProvider({
      connectionString: config.storageMyConnectionString,
      container: config.storageMyContainer,
    });
  }
  return createS3StorageProvider({ ... });
}
```

**Step 4.** Add the new env vars to `server/src/config.ts` and document them in `doc/CLI.md`.

---

### 7.3 Secret Provider Plugins

Secret provider plugins add new backends for secret storage (e.g., a new secrets manager service).

**When to write one:** You need secrets stored in a system not already supported (local encrypted DB, AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault).

**Interface** (`server/src/secrets/types.ts`):

```ts
export interface SecretProviderModule {
  id: SecretProvider;
  descriptor: SecretProviderDescriptor;

  // Get a secret value by name within a company namespace.
  getSecret(companyId: string, name: string): Promise<string | null>;

  // Set or update a secret.
  setSecret(companyId: string, name: string, value: string): Promise<void>;

  // Delete a secret.
  deleteSecret(companyId: string, name: string): Promise<void>;

  // List secret names (not values) for a company.
  listSecrets(companyId: string): Promise<{ name: string; updatedAt: Date }[]>;
}
```

**Step-by-step: adding a new secret provider**

**Step 1.** Create `server/src/secrets/my-secrets-provider.ts`:

```ts
import type { SecretProviderModule } from "./types.js";

export const mySecretsProvider: SecretProviderModule = {
  id: "my_secrets",
  descriptor: {
    id: "my_secrets",
    label: "My Secrets Manager",
    description: "Stores secrets in My Secrets Manager service.",
  },

  async getSecret(companyId, name) {
    const key = `paperclip/${companyId}/${name}`;
    return mySecretsManagerClient.get(key);
  },

  async setSecret(companyId, name, value) {
    const key = `paperclip/${companyId}/${name}`;
    await mySecretsManagerClient.put(key, value);
  },

  async deleteSecret(companyId, name) {
    const key = `paperclip/${companyId}/${name}`;
    await mySecretsManagerClient.delete(key);
  },

  async listSecrets(companyId) {
    return mySecretsManagerClient.list(`paperclip/${companyId}/`);
  },
};
```

**Step 2.** Register in `server/src/secrets/provider-registry.ts`:

```ts
import { mySecretsProvider } from "./my-secrets-provider.js";

const providers: SecretProviderModule[] = [
  localEncryptedProvider,
  awsSecretsManagerProvider,
  gcpSecretManagerProvider,
  vaultProvider,
  mySecretsProvider,   // ← add here
];
```

---

### 7.4 Connector Plugins

Connector plugins are out-of-process integrations. They react to Paperclip events, synchronize external data, contribute agent tools, and optionally contribute UI. Examples: Linear sync, GitHub Issues sync, Grafana alerting, Slack notifications, Stripe billing.

**When to write one:** You want to integrate an external service with Paperclip — receiving events, syncing data, or sending notifications.

**Connector protocol**

Paperclip communicates with connector plugins over either:
- `stdio`: the plugin runs as a persistent child process managed by Paperclip
- `http`: the plugin is a pre-running HTTP service Paperclip connects to

Both transports use the same JSON-RPC protocol:

```
→  { "jsonrpc": "2.0", "id": "1", "method": "init",     "params": { "settings": {...}, "capabilities": [...] } }
←  { "jsonrpc": "2.0", "id": "1", "result": { "ok": true } }

→  { "jsonrpc": "2.0", "id": "2", "method": "event",    "params": { "type": "issue.created", "payload": {...} } }
←  { "jsonrpc": "2.0", "id": "2", "result": { "ok": true } }

→  { "jsonrpc": "2.0", "id": "3", "method": "job",      "params": { "id": "sync" } }
←  { "jsonrpc": "2.0", "id": "3", "result": { "ok": true } }

→  { "jsonrpc": "2.0", "id": "4", "method": "tool.call","params": { "name": "myplugin:search", "arguments": {...} } }
←  { "jsonrpc": "2.0", "id": "4", "result": { "content": "..." } }

→  { "jsonrpc": "2.0", "id": "5", "method": "teardown"  }
←  { "jsonrpc": "2.0", "id": "5", "result": { "ok": true } }
```

The SDK's `defineConnectorPlugin` helper handles all protocol boilerplate.

**Step-by-step: building a connector plugin (Linear example)**

**Step 1.** Create the package:

```bash
mkdir -p packages/plugins/linear-connector/src/server
cd packages/plugins/linear-connector
pnpm init
pnpm add @paperclipai/plugin-sdk @linear/sdk
```

**Step 2.** Create `plugin.json`:

```json
{
  "id": "paperclipai.linear-connector",
  "name": "Linear",
  "version": "1.0.0",
  "description": "Syncs Paperclip issues with Linear",
  "connector": {
    "entry": "./dist/server/index.js",
    "transport": "stdio",
    "capabilities": [
      "issues:read",
      "issues:write",
      "comments:write",
      "webhooks:register",
      "agent_tools:contribute"
    ],
    "events": [
      "issue.created",
      "issue.updated",
      "comment.created",
      "heartbeat_run.completed"
    ],
    "jobs": [
      { "id": "sync_from_linear", "cron": "*/5 * * * *", "description": "Pull updates from Linear" }
    ]
  },
  "settings": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string", "title": "Linear API Key", "secret": true },
      "teamId": { "type": "string", "title": "Linear Team ID" }
    },
    "required": ["apiKey", "teamId"]
  }
}
```

**Step 3.** Implement `src/server/index.ts`:

```ts
import { defineConnectorPlugin, tool, event } from "@paperclipai/plugin-sdk";
import { LinearClient } from "@linear/sdk";

export default defineConnectorPlugin({
  async init(ctx) {
    const client = new LinearClient({ apiKey: await ctx.secrets.get("apiKey") });
    ctx.state.set("client", client);
    ctx.log.info("Linear connector initialized");
  },

  events: {
    "issue.created": event(async (ctx, { issue }) => {
      const client = ctx.state.get<LinearClient>("client");
      const teamId = ctx.settings.teamId as string;

      // Create a mirror issue in Linear
      const linearIssue = await client.createIssue({
        teamId,
        title: issue.title,
        description: issue.description ?? "",
      });

      // Store the external ID mapping via plugin data API
      await ctx.data.set(`issue:${issue.id}:linearId`, linearIssue.issue?.id ?? "");

      await ctx.api.issues.addComment(issue.id, {
        body: `Synced to Linear: https://linear.app/issue/${linearIssue.issue?.identifier}`,
      });
    }),

    "comment.created": event(async (ctx, { comment, issue }) => {
      const client = ctx.state.get<LinearClient>("client");
      const linearId = await ctx.data.get(`issue:${issue.id}:linearId`);
      if (!linearId) return;

      await client.createComment({ issueId: linearId, body: comment.body });
    }),
  },

  jobs: {
    sync_from_linear: async (ctx) => {
      const client = ctx.state.get<LinearClient>("client");
      const teamId = ctx.settings.teamId as string;

      const issues = await client.issues({ filter: { team: { id: { eq: teamId } }, updatedAt: { gt: new Date(Date.now() - 5 * 60 * 1000) } } });

      for (const issue of issues.nodes) {
        // Upsert back to Paperclip using API
        const paperclipId = await ctx.data.get(`linear:${issue.id}:paperclipId`);
        if (paperclipId) {
          await ctx.api.issues.update(paperclipId, { title: issue.title });
        }
      }
    },
  },

  tools: [
    tool({
      name: "linear:search_issues",
      description: "Search issues in Linear.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results", default: 10 },
        },
        required: ["query"],
      },
      async execute(ctx, { query, limit = 10 }) {
        const client = ctx.state.get<LinearClient>("client");
        const results = await client.searchIssues(query, { first: limit });
        return {
          issues: results.nodes.map((i) => ({
            id: i.id,
            identifier: i.identifier,
            title: i.title,
            url: i.url,
            state: i.state?.name,
          })),
        };
      },
    }),
  ],

  async teardown(ctx) {
    ctx.log.info("Linear connector shutting down");
  },
});
```

**Step 4.** Build and install:

```bash
pnpm build
# Install from local path via admin UI or CLI:
paperclip plugin install ./packages/plugins/linear-connector
```

---

### 7.5 Agent Tool Plugins

Agent tool plugins contribute new tools that AI agents can call during their runs. They run out-of-process (for safety) and are namespaced so they cannot shadow core tools.

**When to write one:** You want agents to be able to call an external API, run a custom script, query a database, or perform any specialized operation during a task.

**Tool naming rules:**
- Must include a colon: `namespace:tool_name`
- Namespace must match the plugin's declared `id` prefix (or an allowed alias)
- Core tool names (`read`, `write`, `bash`, `edit`, `grep`, `find`, `ls`) are reserved
- No overriding or shadowing of other plugins' tools

**Full tool definition interface:**

```ts
interface AgentToolDefinition {
  // Namespaced tool name, e.g., "linear:search_issues"
  name: string;

  // Description shown to the agent (and in the tool registry UI)
  description: string;

  // JSON Schema for parameters
  parameters: JSONSchema;

  // Whether this tool should be available to all agents (default: true)
  // or must be explicitly enabled per-agent
  defaultEnabled?: boolean;

  // Estimated max execution time in seconds (for timeout budgeting)
  estimatedMaxDurationSec?: number;

  // Execute the tool. Return any JSON-serializable result.
  execute(ctx: AgentToolContext, params: unknown): Promise<unknown>;
}

interface AgentToolContext {
  // The current run context
  runId: string;
  agentId: string;
  companyId: string;

  // Plugin settings
  settings: Record<string, unknown>;

  // Plugin secrets
  secrets: { get(name: string): Promise<string | null> };

  // Paperclip API client
  api: PaperclipApiClient;

  // Key-value store scoped to this plugin
  data: PluginDataStore;

  // Logger
  log: Logger;
}
```

**Step-by-step: building an agent tool plugin (GitHub search example)**

```ts
// src/server/index.ts
import { defineAgentToolPlugin, tool } from "@paperclipai/plugin-sdk";

export default defineAgentToolPlugin({
  tools: [
    tool({
      name: "github:search_code",
      description: "Search code on GitHub using the GitHub search API.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "GitHub search query, e.g., 'repo:owner/name function foo'" },
          per_page: { type: "number", description: "Results per page (max 30)", default: 10 },
        },
        required: ["query"],
      },
      async execute(ctx, { query, per_page = 10 }) {
        const token = await ctx.secrets.get("githubToken");
        const response = await fetch(
          `https://api.github.com/search/code?q=${encodeURIComponent(query as string)}&per_page=${per_page}`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
        );
        const data = await response.json();
        return {
          total: data.total_count,
          items: (data.items ?? []).map((item: any) => ({
            path: item.path,
            repository: item.repository.full_name,
            url: item.html_url,
            score: item.score,
          })),
        };
      },
    }),

    tool({
      name: "github:create_issue",
      description: "Create a new GitHub issue in a repository.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner" },
          repo: { type: "string", description: "Repository name" },
          title: { type: "string", description: "Issue title" },
          body: { type: "string", description: "Issue body (markdown)" },
          labels: { type: "array", items: { type: "string" }, description: "Labels to apply" },
        },
        required: ["owner", "repo", "title"],
      },
      async execute(ctx, { owner, repo, title, body, labels }) {
        const token = await ctx.secrets.get("githubToken");
        const response = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/issues`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ title, body, labels }),
          },
        );
        const issue = await response.json();
        return { id: issue.id, number: issue.number, url: issue.html_url };
      },
    }),
  ],
});
```

---

### 7.6 UI Extension Plugins

UI extension plugins contribute React components loaded into declared **extension slots** in the Paperclip UI.

**When to write one:** You want to add a sidebar panel, tab, dashboard widget, or header badge that shows data from an external system within the standard Paperclip UI.

**Available extension slots:**

| Slot ID | Location | Props |
|---|---|---|
| `dashboard.widget` | Dashboard page grid | `{ companyId }` |
| `issue.detail.sidebar` | Issue detail right sidebar | `{ issue, companyId }` |
| `issue.detail.tab` | Issue detail tab bar | `{ issue, companyId }` |
| `agent.detail.tab` | Agent detail tab bar | `{ agent, companyId }` |
| `agent.detail.sidebar` | Agent detail right sidebar | `{ agent, companyId }` |
| `run.detail.sidebar` | Run detail right sidebar | `{ run, agentId, companyId }` |
| `project.detail.sidebar` | Project detail right sidebar | `{ project, companyId }` |
| `nav.header.actions` | Top navigation bar actions | `{ companyId }` |
| `settings.tab` | Settings page extra tab | `{ companyId }` |

**UI extension interface:**

```ts
interface UIExtensionPlugin {
  // Each slot contribution is a named export from the UI bundle.
  // The export name must match the slot ID (dots replaced with underscores).
  // e.g., slot "issue.detail.sidebar" → export "issue_detail_sidebar"
}
```

**Step-by-step: building a UI extension (Linear issue sidebar panel)**

```tsx
// src/ui/index.tsx
import { LinearIssuePanel } from "./LinearIssuePanel.js";

// Export matches slot ID with dots replaced by underscores
export const issue_detail_sidebar = LinearIssuePanel;
```

```tsx
// src/ui/LinearIssuePanel.tsx
import { useEffect, useState } from "react";

interface Props {
  issue: { id: string; title: string };
  companyId: string;
}

export function LinearIssuePanel({ issue }: Props) {
  const [linearIssue, setLinearIssue] = useState<LinearIssueInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Call Paperclip's plugin data API to get the stored Linear issue ID,
    // then fetch Linear issue info via the plugin's proxy endpoint.
    fetch(`/api/plugins/paperclipai.linear-connector/data/issue:${issue.id}:linearId`)
      .then((r) => r.json())
      .then(({ value: linearId }) => {
        if (linearId) return fetch(`/api/plugins/paperclipai.linear-connector/proxy/issue/${linearId}`);
      })
      .then((r) => r?.json())
      .then(setLinearIssue)
      .finally(() => setLoading(false));
  }, [issue.id]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading Linear…</div>;
  if (!linearIssue) return null;

  return (
    <div className="space-y-2 text-sm">
      <h4 className="font-medium">Linear</h4>
      <a
        href={linearIssue.url}
        target="_blank"
        rel="noreferrer"
        className="text-blue-500 hover:underline block truncate"
      >
        {linearIssue.identifier}: {linearIssue.title}
      </a>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">State:</span>
        <span>{linearIssue.stateName}</span>
      </div>
    </div>
  );
}
```

**UI extensions use the Paperclip design system.** Import from the same Tailwind classes and component conventions used throughout the app. No external CSS frameworks.

---

## 8. Event Bus

Paperclip emits typed events when significant things happen. Connector plugins subscribe to events in `plugin.json` and receive them via the `events` handler map.

### Core event types

```ts
// Agent events
"agent.created"           // { agent: AgentRef }
"agent.updated"           // { agent: AgentRef }
"agent.deleted"           // { agentId: string }

// Run events
"heartbeat_run.started"   // { run: RunRef, agent: AgentRef }
"heartbeat_run.completed" // { run: RunRef, agent: AgentRef, exitCode: number | null, summary: string | null }
"heartbeat_run.failed"    // { run: RunRef, agent: AgentRef, error: string }
"heartbeat_run.timed_out" // { run: RunRef, agent: AgentRef }

// Issue events
"issue.created"           // { issue: IssueRef, company: CompanyRef }
"issue.updated"           // { issue: IssueRef, changes: Partial<Issue> }
"issue.assigned"          // { issue: IssueRef, agent: AgentRef | null }
"issue.status_changed"    // { issue: IssueRef, from: string, to: string }
"issue.deleted"           // { issueId: string }

// Comment events
"comment.created"         // { comment: CommentRef, issue: IssueRef }
"comment.updated"         // { comment: CommentRef }

// Approval events
"approval.requested"      // { approval: ApprovalRef, agent: AgentRef }
"approval.decided"        // { approval: ApprovalRef, decision: "approved" | "rejected" }

// Cost events
"cost.budget_warning"     // { agent: AgentRef, spentUsd: number, budgetUsd: number }
"cost.budget_exceeded"    // { agent: AgentRef, spentUsd: number, budgetUsd: number }

// Secret events
"secret.created"          // { companyId: string, name: string }
"secret.deleted"          // { companyId: string, name: string }

// Plugin-to-plugin events (namespaced)
"plugin.<plugin-id>.<event-name>" // Custom events from other plugins
```

### Publishing custom events (plugin-to-plugin)

Connector plugins can publish events that other plugins can subscribe to:

```ts
// In your connector plugin:
await ctx.events.publish("plugin.paperclipai.linear-connector.issue_synced", {
  papercipIssueId: issue.id,
  linearIssueId: linearIssue.id,
});
```

Another plugin can subscribe to this:

```json
// plugin.json
{
  "connector": {
    "events": [
      "plugin.paperclipai.linear-connector.issue_synced"
    ]
  }
}
```

### Event delivery guarantees

- Events are delivered **at-least-once**. Plugins must be idempotent on repeated delivery.
- Events are delivered to plugins in parallel (not sequentially).
- If a plugin's event handler throws, the error is logged and the delivery is retried once after a 5-second delay.
- Persistent queue (Postgres-backed) ensures events are not lost if the plugin process crashes.

---

## 9. Plugin Persistence

Connector and agent tool plugins have access to a scoped key-value store backed by Postgres. This replaces the need for plugins to manage their own database.

### Plugin data API

```ts
interface PluginDataStore {
  // Get a value. Returns null if not found.
  get(key: string): Promise<string | null>;

  // Set a value (upsert).
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;

  // Delete a key.
  delete(key: string): Promise<void>;

  // List all keys for this plugin (with optional prefix filter).
  list(prefix?: string): Promise<{ key: string; updatedAt: Date }[]>;

  // Increment a numeric counter (atomic).
  increment(key: string, by?: number): Promise<number>;
}
```

Data is scoped per-plugin. One plugin cannot read another plugin's data.

### Recommended key conventions

```
issue:{papercliIssueId}:externalId          → external system's ID for this issue
agent:{agentId}:lastSyncAt                  → ISO timestamp of last sync
run:{runId}:externalJobId                   → external job ID for this run
company:{companyId}:webhookSecret           → webhook secret per company
```

### Database schema

```sql
CREATE TABLE plugin_data (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id   TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plugin_id, key)
);

CREATE INDEX plugin_data_plugin_key ON plugin_data (plugin_id, key);
CREATE INDEX plugin_data_expires ON plugin_data (expires_at) WHERE expires_at IS NOT NULL;
```

---

## 10. Plugin Lifecycle

### Installation

Plugins are installed via the admin UI or the CLI.

**Via CLI:**
```bash
# Install from local directory
paperclip plugin install ./my-plugin

# Install from npm
paperclip plugin install @my-org/paperclip-linear-connector

# Install from a git URL
paperclip plugin install https://github.com/my-org/my-plugin
```

**Via admin UI:**
- Settings → Plugins → Install Plugin
- Provide a local path or npm package name
- Review required capabilities before confirming

**Installation process:**

1. Manifest validation: `plugin.json` is read and validated against the `PluginManifest` schema.
2. Capability review: declared capabilities are shown to the operator for approval (in-process plugins) or stored for runtime enforcement (out-of-process plugins).
3. Settings schema: declared settings fields are shown in the UI. Required fields must be filled before activation.
4. Secret fields are written to the configured secret provider, not stored in the `plugin_installations` table.
5. Row inserted into `plugin_installations` with `status = "installed"`.

### Activation

After installation and settings completion, the plugin is activated:

```bash
paperclip plugin enable paperclipai.linear-connector
```

Or via admin UI: Settings → Plugins → [plugin] → Enable.

**Activation process:**

1. For in-process plugins: the module is `import()`-ed and registered in the appropriate registry.
2. For out-of-process plugins: the process is spawned (stdio) or the HTTP endpoint is health-checked.
3. `init()` is called with the plugin context.
4. Event subscriptions are registered in the event bus.
5. Scheduled jobs are registered in the scheduler.
6. Agent tool contributions are added to the tool registry.
7. UI extensions are registered in the extension slot registry.
8. Status updated to `"active"` in `plugin_installations`.

### Disabling

```bash
paperclip plugin disable paperclipai.linear-connector
```

1. No new events or job invocations are sent to the plugin.
2. In-flight invocations are allowed to complete (with a 30-second grace period).
3. `teardown()` is called.
4. For out-of-process plugins: SIGTERM is sent, then SIGKILL after grace.
5. Status updated to `"disabled"`.
6. Plugin data and settings are preserved.

### Uninstallation

```bash
paperclip plugin uninstall paperclipai.linear-connector
# Add --purge-data to also delete plugin_data rows
```

1. Plugin is disabled (as above).
2. Event subscriptions, jobs, tools, and UI slots are deregistered.
3. `plugin_installations` row is deleted.
4. Plugin data rows are deleted (or preserved if `--keep-data` is passed).
5. Secret values are deleted from the secret provider.

### Status transitions

```
(not installed)
      ↓  install
  installed          ← settings not yet complete
      ↓  configure
  configured         ← settings complete, not yet enabled
      ↓  enable
   active            ← running normally
      ↓  disable
  disabled           ← paused, data preserved
      ↓  enable      ← can re-enable
   active
      ↓  uninstall
(not installed)
```

---

## 11. Hot Reload

The plugin system supports hot installation and uninstallation — no server restart required.

**How it works:**

- The plugin loader uses a `Map<string, PluginRegistration>` in memory.
- Installing a plugin adds an entry; uninstalling removes it.
- For in-process plugins, Node's module cache must be bypassed: plugin code is loaded via dynamic `import()` with a cache-busting query parameter (`?v=<timestamp>`).
- For out-of-process plugins, the subprocess is simply spawned or killed.
- The event bus, tool registry, and UI slot registry are all mutable registries that support runtime add/remove.

**Caveats:**

- In-process adapter plugins that modify global state (e.g., process-level singleton objects) may not hot-reload cleanly. Operator should test or restart for such plugins.
- UI extensions require a browser refresh after hot install (SSE notification sent to connected clients).

---

## 12. Development Workflow

### Monorepo layout for plugins

```
packages/
  adapters/
    my-adapter/           ← adapter plugin (in-process)
  plugins/
    linear-connector/     ← connector plugin (out-of-process)
    github-tools/         ← agent tool plugin
    slack-notifier/       ← connector plugin
```

### Local development of a connector plugin

**Step 1.** Create the package and run in watch mode:

```bash
pnpm --filter @my-org/linear-connector dev
```

**Step 2.** Install in development mode (uses the local path directly):

```bash
paperclip plugin install ./packages/plugins/linear-connector --dev
```

Development mode:
- Mounts the `dist/` output directory directly (no copy).
- Watches for changes and calls `teardown()` + re-`init()` on the plugin automatically.
- Logs plugin stdout/stderr to the server console.

**Step 3.** Inspect plugin logs:

```bash
paperclip plugin logs paperclipai.linear-connector --follow
```

**Step 4.** Test event delivery manually:

```bash
# Emit a test event to a specific plugin
paperclip plugin emit paperclipai.linear-connector issue.created \
  '{"issue":{"id":"test-1","title":"Test issue"}}'
```

**Step 5.** Inspect plugin data:

```bash
paperclip plugin data list paperclipai.linear-connector
paperclip plugin data get paperclipai.linear-connector "issue:abc123:linearId"
```

### Plugin development checklist

Before shipping a plugin:

- [ ] `plugin.json` is valid (run `paperclip plugin validate ./my-plugin`)
- [ ] All required capabilities are declared
- [ ] All settings fields have descriptions and appropriate `secret: true` flags
- [ ] `init()` handles missing or invalid settings gracefully (logs a warning, does not crash)
- [ ] Event handlers are idempotent (safe to call twice for the same event)
- [ ] Job handlers are idempotent (safe to run if the previous run did not complete)
- [ ] `teardown()` closes all open connections and flushes any pending work
- [ ] Plugin data keys follow the naming conventions (documented above)
- [ ] All agent tools have the correct namespace prefix
- [ ] Tool `execute()` returns a JSON-serializable result
- [ ] UI components do not import CSS frameworks or inject `<style>` tags

---

## 13. Testing Plugins

### Unit testing

Use `vitest`. Mock the `ConnectorContext` / `AgentToolContext` objects:

```ts
import { describe, it, expect, vi } from "vitest";
import type { ConnectorContext } from "@paperclipai/plugin-sdk";

function makeCtx(overrides?: Partial<ConnectorContext>): ConnectorContext {
  return {
    settings: { apiKey: "sk-test", teamId: "team-1" },
    secrets: { get: vi.fn(async (name) => name === "apiKey" ? "sk-test" : null) },
    api: {
      issues: {
        addComment: vi.fn().mockResolvedValue({ id: "comment-1" }),
        update: vi.fn().mockResolvedValue({}),
      },
    },
    data: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      increment: vi.fn().mockResolvedValue(1),
    },
    events: { publish: vi.fn().mockResolvedValue(undefined) },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: new Map(),
    ...overrides,
  } as ConnectorContext;
}

describe("Linear connector", () => {
  it("creates a comment when issue.created fires", async () => {
    const ctx = makeCtx();
    const plugin = (await import("../src/server/index.js")).default;

    await plugin.events["issue.created"](ctx, {
      issue: { id: "iss-1", title: "Fix the bug", description: null },
    });

    expect(ctx.api.issues.addComment).toHaveBeenCalledWith("iss-1", expect.objectContaining({
      body: expect.stringContaining("Linear"),
    }));
  });
});
```

### Integration testing with a real plugin process

Use the `@paperclipai/plugin-sdk/testing` utilities to spin up an in-process plugin server and a test client:

```ts
import { createTestPluginServer } from "@paperclipai/plugin-sdk/testing";
import plugin from "../src/server/index.js";

const { client, cleanup } = await createTestPluginServer(plugin, {
  settings: { apiKey: "sk-test", teamId: "team-1" },
  secrets: { apiKey: "sk-real-key-from-env" },
});

// Send a test event
await client.sendEvent("issue.created", { issue: { id: "iss-1", title: "Test" } });

// Call a tool
const result = await client.callTool("linear:search_issues", { query: "bug" });

await cleanup();
```

### End-to-end testing

Paperclip's CI runs connector plugins in subprocess mode using a real test Postgres database. Plugin packages in `packages/plugins/` are included in the E2E test suite automatically if they include a `test:e2e` script in `package.json`.

---

## 14. Reference Examples

### Minimal connector plugin (Slack notifications)

```ts
// plugin.json (excerpt)
// events: ["heartbeat_run.completed", "approval.requested"]
// settings: { webhookUrl: string }

import { defineConnectorPlugin, event } from "@paperclipai/plugin-sdk";

export default defineConnectorPlugin({
  events: {
    "heartbeat_run.completed": event(async (ctx, { run, agent }) => {
      if (run.exitCode !== 0) {
        await fetch(ctx.settings.webhookUrl as string, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `⚠️ Agent *${agent.name}* run failed (exit ${run.exitCode}).`,
          }),
        });
      }
    }),

    "approval.requested": event(async (ctx, { approval, agent }) => {
      await fetch(ctx.settings.webhookUrl as string, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `🔔 Approval required for agent *${agent.name}*: ${approval.description}`,
        }),
      });
    }),
  },
});
```

### Minimal adapter plugin (custom CLI wrapper)

```ts
// packages/adapters/my-cli/src/server/execute.ts
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, buildPaperclipEnv, ensureCommandResolvable,
         ensureAbsoluteDirectory, ensurePathInEnv, runChildProcess } from "@paperclipai/adapter-utils/server-utils";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, authToken } = ctx;
  const command = asString(config.command, "mycli");
  const cwd = asString(config.cwd, process.cwd());

  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const env: Record<string, string> = { ...buildPaperclipEnv(agent), PAPERCLIP_RUN_ID: runId };
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env }))
      .filter((e): e is [string, string] => typeof e[1] === "string"),
  );

  const proc = await runChildProcess(runId, command, ["run", "--json"], {
    cwd, env: runtimeEnv, timeoutSec: 0, graceSec: 20, onLog,
    stdin: JSON.stringify({ prompt: asString(config.promptTemplate, "Continue your work."), context }) + "\n",
  });

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    errorMessage: (proc.exitCode ?? 0) === 0 ? null : proc.stderr.split("\n")[0] || null,
    summary: proc.stdout.trim().slice(0, 2000),
  };
}
```

### Minimal storage provider plugin (Azure Blob)

```ts
// server/src/storage/azure-blob-provider.ts
import { BlobServiceClient } from "@azure/storage-blob";
import type { StorageProvider } from "./types.js";

export function createAzureBlobProvider(connectionString: string, container: string): StorageProvider {
  const client = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(container);

  return {
    async put(key, body) {
      await client.getBlockBlobClient(key).upload(body, Buffer.byteLength(body as string));
    },
    async get(key) {
      try {
        const result = await client.getBlockBlobClient(key).downloadToBuffer();
        return result.toString();
      } catch { return null; }
    },
    async signedUrl(key, expiresInSeconds) {
      const expiry = new Date(Date.now() + expiresInSeconds * 1000);
      return client.getBlockBlobClient(key).generateSasUrl({ expiresOn: expiry, permissions: { read: true } });
    },
    async delete(key) {
      await client.getBlockBlobClient(key).delete();
    },
    async list(prefix) {
      const blobs: string[] = [];
      for await (const blob of client.listBlobsFlat({ prefix })) blobs.push(blob.name);
      return blobs;
    },
  };
}
```

---

## Quick Reference

### Which plugin class should I use?

| Goal | Plugin class |
|---|---|
| Add support for a new AI CLI (e.g., a new coding agent) | **Adapter** |
| Store run logs in Azure/GCS/custom | **Storage Provider** |
| Store secrets in a custom secrets manager | **Secret Provider** |
| Sync issues with Linear/Jira/GitHub | **Connector** |
| Send Slack/Teams notifications | **Connector** |
| Add tools agents can call (search, APIs, scripts) | **Agent Tool** |
| Show external data in issue or agent detail pages | **UI Extension** |
| Full integration (events + tools + UI sidebar) | **Connector** (with `ui` section) |

### Key files to modify for each class

| Class | Register in |
|---|---|
| Adapter | `server/src/adapters/registry.ts` |
| Storage Provider | `server/src/storage/provider-registry.ts` |
| Secret Provider | `server/src/secrets/provider-registry.ts` |
| Connector / Agent Tool / UI | `server/src/plugins/registry.ts` (new file, loaded by plugin loader) |
