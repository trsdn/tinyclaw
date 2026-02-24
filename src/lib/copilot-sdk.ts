/**
 * GitHub Copilot SDK integration for TinyClaw.
 *
 * Uses the @github/copilot-sdk package for programmatic agent invocation
 * via JSON-RPC instead of spawning a CLI process.
 *
 * The SDK is an ESM module, so we use dynamic import() from CommonJS.
 */

import { log } from './logging';
import { resolveCopilotModel } from './config';
import { CopilotReasoningEffort } from './types';

// Lazy-loaded SDK module reference
let sdkModule: any = null;

// Shared CopilotClient instance (reused across invocations)
let sharedClient: any = null;

// Per-agent session IDs for conversation continuation
const agentSessionIds = new Map<string, string>();

async function getSDK(): Promise<any> {
    if (!sdkModule) {
        sdkModule = await import('@github/copilot-sdk');
    }
    return sdkModule;
}

async function getClient(): Promise<any> {
    if (!sharedClient) {
        const sdk = await getSDK();
        sharedClient = new sdk.CopilotClient({
            autoStart: true,
            autoRestart: true,
            logLevel: 'warn',
        });
        await sharedClient.start();
        log('INFO', 'Copilot SDK client started');
    }
    return sharedClient;
}

/**
 * Invoke an agent using the GitHub Copilot SDK.
 * Returns the response text.
 */
export async function invokeCopilotSdk(
    agentId: string,
    model: string,
    message: string,
    workingDir: string,
    shouldReset: boolean,
    reasoningEffort?: string
): Promise<string> {
    const client = await getClient();
    const modelId = resolveCopilotModel(model);
    const effort = reasoningEffort as CopilotReasoningEffort | undefined;

    // Handle conversation continuation via session IDs
    const existingSessionId = agentSessionIds.get(agentId);

    if (shouldReset && existingSessionId) {
        try {
            await client.deleteSession(existingSessionId);
        } catch {
            // Session may already be gone
        }
        agentSessionIds.delete(agentId);
        log('INFO', `🔄 Reset Copilot SDK session for agent: ${agentId}`);
    }

    let session: any;

    if (!shouldReset && existingSessionId) {
        // Resume existing session
        try {
            session = await client.resumeSession(existingSessionId, { model: modelId });
            log('INFO', `Resumed Copilot SDK session ${existingSessionId} for agent: ${agentId}`);
        } catch {
            // Session no longer valid, create new one
            agentSessionIds.delete(agentId);
            session = null;
        }
    }

    if (!session) {
        // Create new session with optional reasoning effort
        const sessionConfig: any = { model: modelId };
        if (effort) {
            sessionConfig.reasoningEffort = effort;
        }
        session = await client.createSession(sessionConfig);
        agentSessionIds.set(agentId, session.sessionId);
        log('INFO', `Created Copilot SDK session ${session.sessionId} for agent: ${agentId} [model: ${modelId}${effort ? `, effort: ${effort}` : ''}]`);
    }

    // Send message and wait for response
    const response = await session.sendAndWait(
        { prompt: message },
        5 * 60 * 1000 // 5 minute timeout
    );

    if (response?.data?.content) {
        return response.data.content;
    }

    return 'Sorry, I could not generate a response from GitHub Copilot SDK.';
}

/**
 * Cleanup: stop the shared client on process exit.
 */
export async function stopCopilotSdkClient(): Promise<void> {
    if (sharedClient) {
        try {
            await sharedClient.stop();
        } catch {
            // Best effort
        }
        sharedClient = null;
        log('INFO', 'Copilot SDK client stopped');
    }
}
