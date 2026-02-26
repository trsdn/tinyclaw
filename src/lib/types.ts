export interface AgentConfig {
    name: string;
    provider: string;       // 'anthropic', 'openai', 'opencode', 'copilot', or 'copilot-sdk'
    model: string;           // e.g. 'sonnet', 'opus', 'gpt-5.3-codex', 'gpt-4.1'
    working_directory: string;
    system_prompt?: string;
    prompt_file?: string;
    reasoning_effort?: string; // 'low' | 'medium' | 'high' | 'xhigh' (copilot-sdk only)
}

export interface PipelineConfig {
    /** Ordered list of agent IDs that must run in sequence. */
    sequence: string[];
    /**
     * If true, auto-routes to the next agent after each step completes —
     * agents don't need to mention teammates. If false, agents still use
     * [@agent: msg] mentions but only the next agent in sequence is allowed.
     */
    strict?: boolean;
    /**
     * Max number of times the pipeline can loop back (e.g. reviewer sends
     * work back to coder). Default 0 = no loops allowed. Set to e.g. 3
     * to allow up to 3 revision cycles.
     */
    maxLoops?: number;
}

export interface TeamConfig {
    name: string;
    agents: string[];
    leader_agent: string;
    /** Optional pipeline to enforce a strict agent sequence. */
    pipeline?: PipelineConfig;
}

export type TaskStatus = 'backlog' | 'in_progress' | 'review' | 'done';

export interface Task {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    assignee: string;       // agent or team id, empty = unassigned
    assigneeType: 'agent' | 'team' | '';
    createdAt: number;
    updatedAt: number;
}

export interface ChainStep {
    agentId: string;
    response: string;
}

export interface Settings {
    workspace?: {
        path?: string;
        name?: string;
    };
    channels?: {
        enabled?: string[];
        discord?: { bot_token?: string };
        telegram?: { bot_token?: string };
        whatsapp?: {};
    };
    models?: {
        provider?: string; // 'anthropic', 'openai', 'opencode', 'copilot', or 'copilot-sdk'
        anthropic?: {
            model?: string;
        };
        openai?: {
            model?: string;
        };
        opencode?: {
            model?: string;
        };
        copilot?: {
            model?: string;
        };
    };
    agents?: Record<string, AgentConfig>;
    teams?: Record<string, TeamConfig>;
    api?: {
        api_key?: string;          // Bearer token for API auth (auto-generated if missing)
        bind_host?: string;        // Default: '127.0.0.1' (localhost only)
    };
    monitoring?: {
        heartbeat_interval?: number;
    };
}

export interface MessageData {
    channel: string;
    sender: string;
    senderId?: string;
    message: string;
    timestamp: number;
    messageId: string;
    agent?: string; // optional: pre-routed agent id from channel client
    files?: string[];
    // Internal message fields (agent-to-agent)
    conversationId?: string; // links to parent conversation
    fromAgent?: string;      // which agent sent this internal message
}

export interface Conversation {
    id: string;
    channel: string;
    sender: string;
    originalMessage: string;
    messageId: string;
    pending: number;
    responses: ChainStep[];
    files: Set<string>;
    totalMessages: number;
    maxMessages: number;
    teamContext: { teamId: string; team: TeamConfig };
    startTime: number;
    // Track how many mentions each agent sent out (for inbox draining)
    outgoingMentions: Map<string, number>;
    completed?: boolean;
    // Pipeline state (when team has pipeline config)
    pipelineStep?: number;           // current index into pipeline.sequence
    completedAgents?: Set<string>;   // agents that have finished their step
    pipelineLoops?: number;          // how many times the pipeline has looped back
}

export interface ResponseData {
    channel: string;
    sender: string;
    message: string;
    originalMessage: string;
    timestamp: number;
    messageId: string;
    agent?: string; // which agent handled this
    files?: string[];
}

// Model name mapping
export const CLAUDE_MODEL_IDS: Record<string, string> = {
    'sonnet': 'claude-sonnet-4-5',
    'opus': 'claude-opus-4-6',
    'claude-sonnet-4-5': 'claude-sonnet-4-5',
    'claude-opus-4-6': 'claude-opus-4-6'
};

export const CODEX_MODEL_IDS: Record<string, string> = {
    'gpt-5.2': 'gpt-5.2',
    'gpt-5.3-codex': 'gpt-5.3-codex',
};

// GitHub Copilot CLI model IDs (passed via --model flag).
export const COPILOT_MODEL_IDS: Record<string, string> = {
    // OpenAI models
    'gpt-4o': 'gpt-4o',
    'gpt-4.1': 'gpt-4.1',
    'gpt-5': 'gpt-5',
    'gpt-5-mini': 'gpt-5-mini',
    'gpt-5.1': 'gpt-5.1',
    'gpt-5.1-codex': 'gpt-5.1-codex',
    'gpt-5.1-codex-mini': 'gpt-5.1-codex-mini',
    'gpt-5.1-codex-max': 'gpt-5.1-codex-max',
    'gpt-5.2': 'gpt-5.2',
    'gpt-5.2-codex': 'gpt-5.2-codex',
    'gpt-5.3-codex': 'gpt-5.3-codex',
    // Anthropic models
    'claude-haiku-4.5': 'claude-haiku-4.5',
    'claude-sonnet-4': 'claude-sonnet-4',
    'claude-sonnet-4.0': 'claude-sonnet-4',
    'claude-sonnet-4.5': 'claude-sonnet-4.5',
    'claude-sonnet-4.6': 'claude-sonnet-4.6',
    'claude-opus-4.5': 'claude-opus-4.5',
    'claude-opus-4.6': 'claude-opus-4.6',
    'claude-opus-4.6-fast': 'claude-opus-4.6-fast',
    // Google models
    'gemini-2.5-pro': 'gemini-2.5-pro',
    'gemini-3-flash': 'gemini-3-flash',
    'gemini-3-pro': 'gemini-3-pro',
    'gemini-3.1-pro': 'gemini-3.1-pro',
    // xAI models
    'grok-code-fast-1': 'grok-code-fast-1',
    // Fine-tuned models
    'raptor-mini': 'raptor-mini',
    'goldeneye': 'goldeneye',
    // Shorthand aliases
    'gpt': 'gpt-4.1',
    'sonnet': 'claude-sonnet-4.5',
    'opus': 'claude-opus-4.6',
    'opus-fast': 'claude-opus-4.6-fast',
    'haiku': 'claude-haiku-4.5',
    'gemini': 'gemini-2.5-pro',
    'grok': 'grok-code-fast-1',
};

// Reasoning effort levels for Copilot SDK (supported by some models).
export type CopilotReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

// OpenCode model IDs in provider/model format (passed via --model / -m flag).
// Falls back to the raw model string from settings if no mapping is found.
export const OPENCODE_MODEL_IDS: Record<string, string> = {
    'opencode/claude-opus-4-6': 'opencode/claude-opus-4-6',
    'opencode/claude-sonnet-4-5': 'opencode/claude-sonnet-4-5',
    'opencode/gemini-3-flash': 'opencode/gemini-3-flash',
    'opencode/gemini-3-pro': 'opencode/gemini-3-pro',
    'opencode/glm-5': 'opencode/glm-5',
    'opencode/kimi-k2.5': 'opencode/kimi-k2.5',
    'opencode/kimi-k2.5-free': 'opencode/kimi-k2.5-free',
    'opencode/minimax-m2.5': 'opencode/minimax-m2.5',
    'opencode/minimax-m2.5-free': 'opencode/minimax-m2.5-free',
    'anthropic/claude-opus-4-6': 'anthropic/claude-opus-4-6',
    'anthropic/claude-sonnet-4-5': 'anthropic/claude-sonnet-4-5',
    'openai/gpt-5.2': 'openai/gpt-5.2',
    'openai/gpt-5.3-codex': 'openai/gpt-5.3-codex',
    'openai/gpt-5.3-codex-spark': 'openai/gpt-5.3-codex-spark',
    // Shorthand aliases
    'sonnet': 'opencode/claude-sonnet-4-5',
    'opus': 'opencode/claude-opus-4-6',
};
