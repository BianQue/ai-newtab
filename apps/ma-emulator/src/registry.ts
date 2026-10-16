import type { Store } from "./store";
import { badRequest, conflict, newId, notFound, nowIso } from "./util";

/**
 * Agents and environments: persistent, versioned configuration objects. A
 * session pins a snapshot of the agent version it was created with, so updating
 * an agent never changes a session that is already running.
 */

export interface AgentDoc {
  id: string;
  type: "agent";
  name: string;
  description: string | null;
  model: { id: string; speed?: "standard" | "fast" };
  system: string | null;
  tools: any[];
  mcp_servers: any[];
  skills: any[];
  multiagent: any | null;
  metadata: Record<string, string>;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface EnvironmentDoc {
  id: string;
  type: "environment";
  name: string;
  description: string;
  config: Record<string, any>;
  metadata: Record<string, string>;
  scope: "organization";
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

const ALWAYS_ALLOW = { type: "always_allow" };

function normalizeModel(model: unknown): AgentDoc["model"] {
  if (typeof model === "string" && model) return { id: model, speed: "standard" };
  if (model && typeof model === "object" && typeof (model as any).id === "string") {
    return { speed: "standard", ...(model as any) };
  }
  throw badRequest("model is required");
}

function normalizeTools(tools: unknown): any[] {
  if (tools == null) return [];
  if (!Array.isArray(tools)) throw badRequest("tools must be an array");
  return tools.map((tool: any) => {
    switch (tool?.type) {
      case "agent_toolset_20260401":
        return {
          type: tool.type,
          default_config: {
            enabled: tool.default_config?.enabled ?? true,
            permission_policy: tool.default_config?.permission_policy ?? ALWAYS_ALLOW,
          },
          configs: (tool.configs ?? []).map((c: any) => ({
            name: c.name,
            enabled: c.enabled ?? true,
            permission_policy: c.permission_policy ?? ALWAYS_ALLOW,
          })),
        };
      case "custom":
        if (!tool.name || !tool.input_schema) throw badRequest("custom tools need a name and input_schema");
        return { type: "custom", name: tool.name, description: tool.description ?? "", input_schema: tool.input_schema };
      default:
        // mcp_toolset and future types are stored but not executed by this emulator.
        return tool;
    }
  });
}

export class Registry {
  constructor(private readonly store: Store) {}

  // ---- agents ------------------------------------------------------------------

  createAgent(body: any): AgentDoc {
    if (!body?.name) throw badRequest("name is required");
    const now = nowIso();
    const doc: AgentDoc = {
      id: newId("agent"),
      type: "agent",
      name: body.name,
      description: body.description ?? null,
      model: normalizeModel(body.model),
      system: body.system ?? null,
      tools: normalizeTools(body.tools),
      mcp_servers: body.mcp_servers ?? [],
      skills: body.skills ?? [],
      multiagent: body.multiagent ?? null,
      metadata: body.metadata ?? {},
      version: 1,
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    this.saveAgent(doc);
    return doc;
  }

  getAgent(id: string, version?: number): AgentDoc {
    const doc =
      version === undefined
        ? this.store.get<AgentDoc>("agents", id)
        : this.store.get<AgentDoc>("agent_versions", `${id}@${version}`);
    if (!doc) throw notFound("Agent", version === undefined ? id : `${id}@${version}`);
    return doc;
  }

  /** Optimistic concurrency: the caller must name the version it is updating. */
  updateAgent(id: string, body: any): AgentDoc {
    const current = this.getAgent(id);
    if (current.archived_at) throw badRequest(`Agent ${id} is archived`);
    if (body?.version === undefined) throw badRequest("version is required");
    if (body.version !== current.version) {
      throw conflict(`Agent ${id} is at version ${current.version}, not ${body.version}`);
    }
    const next: AgentDoc = {
      ...current,
      name: body.name ?? current.name,
      description: body.description !== undefined ? body.description : current.description,
      model: body.model !== undefined ? normalizeModel(body.model) : current.model,
      system: body.system !== undefined ? body.system : current.system,
      tools: body.tools !== undefined ? normalizeTools(body.tools) : current.tools,
      mcp_servers: body.mcp_servers ?? current.mcp_servers,
      skills: body.skills ?? current.skills,
      multiagent: body.multiagent !== undefined ? body.multiagent : current.multiagent,
      metadata: body.metadata ?? current.metadata,
      version: current.version + 1,
      updated_at: nowIso(),
    };
    this.saveAgent(next);
    return next;
  }

  listAgents(): AgentDoc[] {
    return this.store.list<AgentDoc>("agents");
  }

  archiveAgent(id: string): AgentDoc {
    const doc = { ...this.getAgent(id), archived_at: nowIso(), updated_at: nowIso() };
    this.store.put("agents", doc);
    return doc;
  }

  private saveAgent(doc: AgentDoc) {
    this.store.put("agents", doc);
    this.store.put("agent_versions", { ...doc, id: `${doc.id}@${doc.version}` } as AgentDoc, doc.id);
  }

  // ---- environments --------------------------------------------------------------

  createEnvironment(body: any): EnvironmentDoc {
    if (!body?.name) throw badRequest("name is required");
    if (this.listEnvironments().some((e) => e.name === body.name && !e.archived_at)) {
      throw conflict(`An environment named "${body.name}" already exists`);
    }
    const now = nowIso();
    const doc: EnvironmentDoc = {
      id: newId("env"),
      type: "environment",
      name: body.name,
      description: body.description ?? "",
      config: normalizeEnvConfig(body.config),
      metadata: body.metadata ?? {},
      scope: "organization",
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    return this.store.put("environments", doc);
  }

  getEnvironment(id: string): EnvironmentDoc {
    const doc = this.store.get<EnvironmentDoc>("environments", id);
    if (!doc) throw notFound("Environment", id);
    return doc;
  }

  updateEnvironment(id: string, body: any): EnvironmentDoc {
    const current = this.getEnvironment(id);
    const next: EnvironmentDoc = {
      ...current,
      name: body?.name ?? current.name,
      description: body?.description ?? current.description,
      config: body?.config ? normalizeEnvConfig(body.config) : current.config,
      metadata: body?.metadata ?? current.metadata,
      updated_at: nowIso(),
    };
    return this.store.put("environments", next);
  }

  listEnvironments(): EnvironmentDoc[] {
    return this.store.list<EnvironmentDoc>("environments");
  }

  archiveEnvironment(id: string): EnvironmentDoc {
    const doc = { ...this.getEnvironment(id), archived_at: nowIso(), updated_at: nowIso() };
    return this.store.put("environments", doc);
  }

  deleteEnvironment(id: string) {
    this.getEnvironment(id);
    this.store.delete("environments", id);
    return { id, type: "environment_deleted" };
  }
}

function normalizeEnvConfig(config: any): Record<string, any> {
  return {
    type: config?.type ?? "cloud",
    networking: config?.networking ?? { type: "unrestricted" },
    packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [], ...(config?.packages ?? {}) },
  };
}
