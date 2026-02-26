#!/usr/bin/env node
/**
 * Queue Processor - Handles messages from all channels (WhatsApp, Telegram, etc.)
 *
 * Supports multi-agent routing:
 *   - Messages prefixed with @agent_id are routed to that agent
 *   - Unrouted messages go to the "default" agent
 *   - Each agent has its own provider, model, working directory, and system prompt
 *   - Conversation isolation via per-agent working directories
 *
 * Team conversations use queue-based message passing:
 *   - Agent mentions ([@teammate: message]) become new messages in the queue
 *   - Each agent processes messages naturally via its own promise chain
 *   - Conversations complete when all branches resolve (no more pending mentions)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { MessageData, Conversation, TeamConfig } from './lib/types';
import {
    LOG_FILE, CHATS_DIR, FILES_DIR,
    getSettings, getAgents, getTeams
} from './lib/config';
import { log, emitEvent } from './lib/logging';
import { parseAgentRouting, findTeamForAgent, getAgentResetFlag, extractTeammateMentions, getNextPipelineAgent, filterMentionsForPipeline } from './lib/routing';
import { invokeAgent } from './lib/invoke';
import { startApiServer } from './server';
import {
    initQueueDb, claimNextMessage, completeMessage as dbCompleteMessage,
    failMessage, enqueueResponse, getPendingAgents, recoverStaleMessages,
    pruneAckedResponses, pruneCompletedMessages, closeQueueDb, queueEvents, DbMessage,
} from './lib/db';
import { handleLongResponse, collectFiles } from './lib/response';
import { stopCopilotSdkClient } from './lib/copilot-sdk';
import {
    conversations, MAX_CONVERSATION_MESSAGES, enqueueInternalMessage, completeConversation,
    withConversationLock, incrementPending, decrementPending,
} from './lib/conversation';

// Ensure directories exist
[FILES_DIR, path.dirname(LOG_FILE), CHATS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Process a single message from the DB
async function processMessage(dbMsg: DbMessage): Promise<void> {
    try {
        const channel = dbMsg.channel;
        const sender = dbMsg.sender;
        const rawMessage = dbMsg.message;
        const messageId = dbMsg.message_id;
        const isInternal = !!dbMsg.conversation_id;
        const files: string[] = dbMsg.files ? JSON.parse(dbMsg.files) : [];

        // Build a MessageData-like object for compatibility
        const messageData: MessageData = {
            channel,
            sender,
            senderId: dbMsg.sender_id ?? undefined,
            message: rawMessage,
            timestamp: dbMsg.created_at,
            messageId,
            agent: dbMsg.agent ?? undefined,
            files: files.length > 0 ? files : undefined,
            conversationId: dbMsg.conversation_id ?? undefined,
            fromAgent: dbMsg.from_agent ?? undefined,
        };

        log('INFO', `Processing [${isInternal ? 'internal' : channel}] ${isInternal ? `@${dbMsg.from_agent}→@${dbMsg.agent}` : `from ${sender}`}: ${rawMessage.substring(0, 50)}...`);
        if (!isInternal) {
            emitEvent('message_received', { channel, sender, message: rawMessage.substring(0, 120), messageId });
        }

        // Get settings, agents, and teams
        const settings = getSettings();
        const agents = getAgents(settings);
        const teams = getTeams(settings);

        // Get workspace path from settings
        const workspacePath = settings?.workspace?.path || path.join(os.homedir(), 'tinyclaw-workspace');

        // Route message to agent (or team)
        let agentId: string;
        let message: string;
        let isTeamRouted = false;

        if (messageData.agent && agents[messageData.agent]) {
            // Pre-routed (by channel client or internal message)
            agentId = messageData.agent;
            message = rawMessage;
        } else {
            // Parse @agent or @team prefix
            const routing = parseAgentRouting(rawMessage, agents, teams);
            agentId = routing.agentId;
            message = routing.message;
            isTeamRouted = !!routing.isTeam;
        }

        // Fall back to default if agent not found
        if (!agents[agentId]) {
            agentId = 'default';
            message = rawMessage;
        }

        // Final fallback: use first available agent if no default
        if (!agents[agentId]) {
            agentId = Object.keys(agents)[0];
        }

        if (!agents[agentId]) {
            log('ERROR', `No agents configured — cannot process message ${messageId}`);
            failMessage(dbMsg.id, 'No agents configured');
            return;
        }

        // Determine team context
        let teamContext: { teamId: string; team: TeamConfig } | null = null;
        if (isInternal) {
            // Internal messages inherit team context from their conversation
            const conv = conversations.get(messageData.conversationId!);
            if (conv) teamContext = conv.teamContext;
        } else {
            if (isTeamRouted) {
                for (const [tid, t] of Object.entries(teams)) {
                    if (t.leader_agent === agentId && t.agents.includes(agentId)) {
                        teamContext = { teamId: tid, team: t };
                        break;
                    }
                }
            }
            if (!teamContext) {
                teamContext = findTeamForAgent(agentId, teams);
            }
        }

        // Pipeline override: when a team has a pipeline, route the initial
        // message to the first agent in the sequence instead of the leader.
        if (!isInternal && isTeamRouted && teamContext?.team.pipeline) {
            const firstPipelineAgent = teamContext.team.pipeline.sequence[0];
            if (firstPipelineAgent && agents[firstPipelineAgent] && firstPipelineAgent !== agentId) {
                log('INFO', `Pipeline: overriding leader routing @${agentId} → @${firstPipelineAgent} (first in sequence)`);
                agentId = firstPipelineAgent;
            }
        }

        const agent = agents[agentId];
        log('INFO', `Routing to agent: ${agent.name} (${agentId}) [${agent.provider}/${agent.model}]`);
        if (!isInternal) {
            emitEvent('agent_routed', { agentId, agentName: agent.name, provider: agent.provider, model: agent.model, isTeamRouted });
        }

        // Check for per-agent reset
        const agentResetFlag = getAgentResetFlag(agentId, workspacePath);
        const shouldReset = fs.existsSync(agentResetFlag);

        if (shouldReset) {
            fs.unlinkSync(agentResetFlag);
        }

        // For internal messages: append pending response indicator so the agent
        // knows other teammates are still processing and won't re-mention them.
        if (isInternal && messageData.conversationId) {
            const conv = conversations.get(messageData.conversationId);
            if (conv) {
                // pending includes this message (not yet decremented), so subtract 1 for "others"
                const othersPending = conv.pending - 1;
                if (othersPending > 0) {
                    message += `\n\n------\n\n[${othersPending} other teammate response(s) are still being processed and will be delivered when ready. Do not re-mention teammates who haven't responded yet.]`;
                }
            }
        }

        // Invoke agent
        emitEvent('chain_step_start', { agentId, agentName: agent.name, fromAgent: messageData.fromAgent || null });
        let response: string;
        try {
            response = await invokeAgent(agent, agentId, message, workspacePath, shouldReset, agents, teams);
        } catch (error) {
            const provider = agent.provider || 'anthropic';
            const providerLabel = provider === 'openai' ? 'Codex' : provider === 'opencode' ? 'OpenCode' : provider === 'copilot' || provider === 'copilot-sdk' ? 'Copilot' : 'Claude';
            log('ERROR', `${providerLabel} error (agent: ${agentId}): ${(error as Error).message}`);
            response = "Sorry, I encountered an error processing your request. Please check the queue logs.";
        }

        emitEvent('chain_step_done', { agentId, agentName: agent.name, responseLength: response.length, responseText: response });

        // --- No team context: simple response to user ---
        if (!teamContext) {
            let finalResponse = response.trim();

            // Detect files
            const outboundFilesSet = new Set<string>();
            collectFiles(finalResponse, outboundFilesSet);
            const outboundFiles = Array.from(outboundFilesSet);
            if (outboundFiles.length > 0) {
                finalResponse = finalResponse.replace(/\[send_file:\s*[^\]]+\]/g, '').trim();
            }

            // Handle long responses — send as file attachment
            const { message: responseMessage, files: allFiles } = handleLongResponse(finalResponse, outboundFiles);

            enqueueResponse({
                channel,
                sender,
                senderId: dbMsg.sender_id ?? undefined,
                message: responseMessage,
                originalMessage: rawMessage,
                messageId,
                agent: agentId,
                files: allFiles.length > 0 ? allFiles : undefined,
            });

            log('INFO', `✓ Response ready [${channel}] ${sender} via agent:${agentId} (${finalResponse.length} chars)`);
            emitEvent('response_ready', { channel, sender, agentId, responseLength: finalResponse.length, responseText: finalResponse, messageId });

            dbCompleteMessage(dbMsg.id);
            return;
        }

        // --- Team context: conversation-based message passing ---

        const pipeline = teamContext.team.pipeline;

        // Get or create conversation
        let conv: Conversation;
        if (isInternal && messageData.conversationId && conversations.has(messageData.conversationId)) {
            conv = conversations.get(messageData.conversationId)!;
        } else {
            // New conversation
            const convId = `${messageId}_${Date.now()}`;
            conv = {
                id: convId,
                channel,
                sender,
                originalMessage: rawMessage,
                messageId,
                pending: 1, // this initial message
                responses: [],
                files: new Set(),
                totalMessages: 0,
                maxMessages: MAX_CONVERSATION_MESSAGES,
                teamContext,
                startTime: Date.now(),
                outgoingMentions: new Map(),
            };
            // Initialize pipeline state
            if (pipeline) {
                conv.pipelineStep = 0;
                conv.completedAgents = new Set();
                log('INFO', `Pipeline enabled: ${pipeline.sequence.join(' → ')}${pipeline.strict ? ' (strict)' : ''}`);
            }
            conversations.set(convId, conv);
            log('INFO', `Conversation started: ${convId} (team: ${teamContext.team.name})`);
            emitEvent('team_chain_start', { teamId: teamContext.teamId, teamName: teamContext.team.name, agents: teamContext.team.agents, leader: teamContext.team.leader_agent, pipeline: pipeline ? pipeline.sequence : undefined });
        }

        // Record this agent's response
        conv.responses.push({ agentId, response });
        conv.totalMessages++;
        collectFiles(response, conv.files);
        if (conv.completedAgents) conv.completedAgents.add(agentId);

        // Check for teammate mentions
        let teammateMentions = extractTeammateMentions(
            response, agentId, conv.teamContext.teamId, teams, agents
        );

        // Pipeline enforcement
        if (pipeline) {
            const currentLoops = conv.pipelineLoops ?? 0;

            if (pipeline.strict) {
                // Strict mode: ignore agent mentions, auto-route to next in sequence
                if (teammateMentions.length > 0) {
                    log('INFO', `Pipeline strict: ignoring ${teammateMentions.length} mention(s) from @${agentId} — auto-routing instead`);
                }
                teammateMentions = [];

                const nextAgent = getNextPipelineAgent(pipeline, agentId);
                if (nextAgent && conv.totalMessages < conv.maxMessages) {
                    // Auto-route: include original user message + previous output for context
                    const pipelineMsg = `[Original request]:\n${conv.originalMessage}\n\n[Output from @${agentId}]:\n${response}`;
                    teammateMentions = [{ teammateId: nextAgent, message: pipelineMsg }];
                    log('INFO', `Pipeline auto-route: @${agentId} → @${nextAgent} (step ${(conv.pipelineStep ?? 0) + 1}/${pipeline.sequence.length})`);
                    emitEvent('pipeline_step', { teamId: conv.teamContext.teamId, fromAgent: agentId, toAgent: nextAgent, step: (conv.pipelineStep ?? 0) + 1, total: pipeline.sequence.length });
                    conv.pipelineStep = (conv.pipelineStep ?? 0) + 1;
                } else if (!nextAgent) {
                    log('INFO', `Pipeline complete: @${agentId} was the last step`);
                    emitEvent('pipeline_complete', { teamId: conv.teamContext.teamId, steps: pipeline.sequence, totalMessages: conv.totalMessages });
                }
            } else {
                // Non-strict mode: agents use mentions, filtered by pipeline order + loop rules
                teammateMentions = filterMentionsForPipeline(teammateMentions, pipeline, agentId, currentLoops);

                // Detect loop-backs (mention targets an earlier agent in sequence)
                for (const m of teammateMentions) {
                    const targetIdx = pipeline.sequence.indexOf(m.teammateId);
                    const currentIdx = pipeline.sequence.indexOf(agentId);
                    if (targetIdx >= 0 && currentIdx >= 0 && targetIdx < currentIdx) {
                        conv.pipelineLoops = currentLoops + 1;
                        conv.pipelineStep = targetIdx;
                        log('INFO', `Pipeline loop-back: @${agentId} → @${m.teammateId} (loop ${conv.pipelineLoops}/${pipeline.maxLoops})`);
                        emitEvent('pipeline_loop', { teamId: conv.teamContext.teamId, fromAgent: agentId, toAgent: m.teammateId, loop: conv.pipelineLoops, maxLoops: pipeline.maxLoops });
                    } else if (teammateMentions.length > 0) {
                        conv.pipelineStep = (conv.pipelineStep ?? 0) + 1;
                    }
                }
            }
        }

        // This branch is done - use atomic lock for increment + enqueue + decrement
        await withConversationLock(conv.id, async () => {
            if (teammateMentions.length > 0 && conv.totalMessages < conv.maxMessages) {
                // Enqueue internal messages for each mention
                incrementPending(conv, teammateMentions.length);
                conv.outgoingMentions.set(agentId, teammateMentions.length);
                for (const mention of teammateMentions) {
                    log('INFO', `@${agentId} → @${mention.teammateId}`);
                    emitEvent('chain_handoff', { teamId: conv.teamContext.teamId, fromAgent: agentId, toAgent: mention.teammateId });

                    const internalMsg = pipeline?.strict
                        ? `[Pipeline step from @${agentId}]:\n${mention.message}`
                        : `[Message from teammate @${agentId}]:\n${mention.message}`;
                    enqueueInternalMessage(conv.id, agentId, mention.teammateId, internalMsg, {
                        channel: messageData.channel,
                        sender: messageData.sender,
                        senderId: messageData.senderId,
                        messageId: messageData.messageId,
                    });
                }
            } else if (teammateMentions.length > 0) {
                log('WARN', `Conversation ${conv.id} hit max messages (${conv.maxMessages}) — not enqueuing further mentions`);
            }

            const shouldComplete = decrementPending(conv);

            if (shouldComplete) {
                completeConversation(conv);
            } else {
                log('INFO', `Conversation ${conv.id}: ${conv.pending} branch(es) still pending`);
            }
        });

        // Mark message as completed in DB
        dbCompleteMessage(dbMsg.id);

    } catch (error) {
        log('ERROR', `Processing error: ${(error as Error).message}`);
        failMessage(dbMsg.id, (error as Error).message);
    }
}

// Per-agent processing chains - ensures messages to same agent are sequential
const agentProcessingChains = new Map<string, Promise<void>>();

// Main processing loop
async function processQueue(): Promise<void> {
    try {
        // Get all agents with pending messages
        const pendingAgents = getPendingAgents();

        if (pendingAgents.length === 0) return;

        for (const agentId of pendingAgents) {
            const dbMsg = claimNextMessage(agentId);
            if (!dbMsg) continue;

            const previousChain = agentProcessingChains.get(agentId) ?? Promise.resolve();
            const newChain = previousChain
                .then(() => processMessage(dbMsg))
                .catch(error => {
                    log('ERROR', `Error processing message for agent ${agentId}: ${error.message}`);
                });

            agentProcessingChains.set(agentId, newChain);

            newChain.finally(() => {
                if (agentProcessingChains.get(agentId) === newChain) {
                    agentProcessingChains.delete(agentId);
                }
            });
        }
    } catch (error) {
        log('ERROR', `Queue processing error: ${(error as Error).message}`);
    }
}

// Log agent and team configuration on startup
function logAgentConfig(): void {
    const settings = getSettings();
    const agents = getAgents(settings);
    const teams = getTeams(settings);

    const agentCount = Object.keys(agents).length;
    log('INFO', `Loaded ${agentCount} agent(s):`);
    for (const [id, agent] of Object.entries(agents)) {
        log('INFO', `  ${id}: ${agent.name} [${agent.provider}/${agent.model}] cwd=${agent.working_directory}`);
    }

    const teamCount = Object.keys(teams).length;
    if (teamCount > 0) {
        log('INFO', `Loaded ${teamCount} team(s):`);
        for (const [id, team] of Object.entries(teams)) {
            log('INFO', `  ${id}: ${team.name} [agents: ${team.agents.join(', ')}] leader=${team.leader_agent}`);
        }
    }
}

// ─── Start ──────────────────────────────────────────────────────────────────

// Initialize SQLite queue
initQueueDb();

// On startup, reset ALL processing messages — no copilot processes survive a restart
const recovered = recoverStaleMessages(0);
if (recovered > 0) {
    log('INFO', `Recovered ${recovered} stale message(s) from previous session`);
}

// Start the API server (passes conversations for queue status reporting)
const apiServer = startApiServer(conversations);

log('INFO', 'Queue processor started (SQLite-backed)');
logAgentConfig();
emitEvent('processor_start', { agents: Object.keys(getAgents(getSettings())), teams: Object.keys(getTeams(getSettings())) });

// Event-driven: all messages come through the API server (same process)
queueEvents.on('message:enqueued', () => processQueue());

// Process any leftover pending messages from before this restart
processQueue();

// Periodic maintenance
setInterval(() => {
    const count = recoverStaleMessages();
    if (count > 0) log('INFO', `Recovered ${count} stale message(s)`);
}, 5 * 60 * 1000); // every 5 min

setInterval(async () => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, conv] of conversations.entries()) {
        if (conv.startTime < cutoff) {
            log('WARN', `Conversation ${id} timed out after 30 min`);
            await withConversationLock(id, async () => {
                if (conversations.has(id)) {
                    completeConversation(conv);
                }
            });
        }
    }
}, 30 * 60 * 1000); // every 30 min

setInterval(() => {
    const pruned = pruneAckedResponses();
    if (pruned > 0) log('INFO', `Pruned ${pruned} acked response(s)`);
}, 60 * 60 * 1000); // every 1 hr

setInterval(() => {
    const pruned = pruneCompletedMessages();
    if (pruned > 0) log('INFO', `Pruned ${pruned} completed message(s)`);
}, 60 * 60 * 1000); // every 1 hr

// Graceful shutdown
async function gracefulShutdown(): Promise<void> {
    log('INFO', 'Shutting down queue processor...');
    await stopCopilotSdkClient();

    // Drain in-flight agent processing chains (30s timeout)
    const chains = Array.from(agentProcessingChains.values());
    if (chains.length > 0) {
        log('INFO', `Waiting for ${chains.length} agent chain(s) to drain...`);
        await Promise.race([
            Promise.all(chains),
            new Promise<void>(resolve => setTimeout(resolve, 30_000)),
        ]);
    }

    closeQueueDb();
    apiServer.close();
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
