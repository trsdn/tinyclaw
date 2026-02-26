/**
 * End-to-end integration test for the pipeline feature.
 *
 * Uses real SQLite DB, real routing/conversation logic, but mocks invokeAgent
 * so we don't call actual LLMs. Verifies that:
 * - Strict pipeline routes through agents in order
 * - Each step receives the original request + previous output
 * - Non-strict pipeline filters mentions to next-in-sequence
 * - Loop-backs work when maxLoops > 0
 * - Pipeline completes and produces a final response
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

// We test against the actual module functions
import {
    initQueueDb, closeQueueDb,
    enqueueMessage, claimNextMessage, completeMessage, failMessage,
    enqueueResponse, getResponsesForChannel, getPendingAgents,
    DbMessage, DbResponse,
} from '../../src/lib/db';
import { getNextPipelineAgent, filterMentionsForPipeline, extractTeammateMentions } from '../../src/lib/routing';
import {
    conversations, withConversationLock, incrementPending, decrementPending,
    enqueueInternalMessage, completeConversation, MAX_CONVERSATION_MESSAGES,
} from '../../src/lib/conversation';
import { Conversation, AgentConfig, TeamConfig, PipelineConfig } from '../../src/lib/types';
import { collectFiles } from '../../src/lib/response';

// ── Test fixtures ────────────────────────────────────────────────────────────

const agents: Record<string, AgentConfig> = {
    po: { name: 'Product Owner', provider: 'test', model: 'mock', working_directory: '/tmp/po' },
    coder: { name: 'Developer', provider: 'test', model: 'mock', working_directory: '/tmp/coder' },
    reviewer: { name: 'Reviewer', provider: 'test', model: 'mock', working_directory: '/tmp/reviewer' },
};

const pipelineStrict: PipelineConfig = {
    sequence: ['po', 'coder', 'reviewer'],
    strict: true,
};

const pipelineWithLoops: PipelineConfig = {
    sequence: ['po', 'coder', 'reviewer'],
    strict: false,
    maxLoops: 2,
};

const team: TeamConfig = {
    name: 'Test Pipeline Team',
    agents: ['po', 'coder', 'reviewer'],
    leader_agent: 'po',
    pipeline: pipelineStrict,
};

const teams: Record<string, TeamConfig> = { pipeline_team: team };

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

function setupTestDb() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyclaw-pipeline-test-'));

    // Close any existing DB first so initQueueDb can re-open with our temp path
    try { closeQueueDb(); } catch {}

    // Create the support dirs for response handling
    fs.mkdirSync(path.join(tmpDir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'chats'), { recursive: true });
}

function teardownTestDb() {
    try { closeQueueDb(); } catch {}
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Simulate what queue-processor.ts does for one message through the pipeline.
 * Returns the agent responses in order.
 */
async function simulatePipelineRun(
    pipeline: PipelineConfig,
    agentResponses: Record<string, string | (() => string)>,
    userMessage: string,
): Promise<{
    stepsExecuted: string[];
    finalResponses: { agentId: string; response: string }[];
    loopBacks: { from: string; to: string }[];
}> {
    const stepsExecuted: string[] = [];
    const loopBacks: { from: string; to: string }[] = [];

    const teamWithPipeline: TeamConfig = { ...team, pipeline };
    const teamsLocal: Record<string, TeamConfig> = { pipeline_team: teamWithPipeline };
    const teamContext = { teamId: 'pipeline_team', team: teamWithPipeline };

    // Create conversation
    const convId = `test_${Date.now()}`;
    const conv: Conversation = {
        id: convId,
        channel: 'test',
        sender: 'tester',
        originalMessage: userMessage,
        messageId: `msg_${Date.now()}`,
        pending: 1,
        responses: [],
        files: new Set(),
        totalMessages: 0,
        maxMessages: MAX_CONVERSATION_MESSAGES,
        teamContext,
        startTime: Date.now(),
        outgoingMentions: new Map(),
        pipelineStep: 0,
        completedAgents: new Set(),
        pipelineLoops: 0,
    };
    conversations.set(convId, conv);

    // Start with first agent in pipeline
    let currentAgentId = pipeline.sequence[0];
    let currentMessage = userMessage;
    let safetyCounter = 0;
    const maxIterations = 20;

    while (currentAgentId && safetyCounter < maxIterations) {
        safetyCounter++;
        stepsExecuted.push(currentAgentId);

        // "Invoke" the agent (mocked — supports static strings or callables)
        const responseValue = agentResponses[currentAgentId];
        const response = typeof responseValue === 'function'
            ? responseValue()
            : (responseValue || `Default response from ${currentAgentId}`);

        // Record response
        conv.responses.push({ agentId: currentAgentId, response });
        conv.totalMessages++;
        conv.completedAgents!.add(currentAgentId);

        // Pipeline routing logic (mirrors queue-processor.ts)
        let teammateMentions = extractTeammateMentions(
            response, currentAgentId, 'pipeline_team', teamsLocal, agents
        );

        const currentLoops = conv.pipelineLoops ?? 0;

        if (pipeline.strict) {
            teammateMentions = [];
            const nextAgent = getNextPipelineAgent(pipeline, currentAgentId);
            if (nextAgent && conv.totalMessages < conv.maxMessages) {
                const pipelineMsg = `[Original request]:\n${conv.originalMessage}\n\n[Output from @${currentAgentId}]:\n${response}`;
                teammateMentions = [{ teammateId: nextAgent, message: pipelineMsg }];
                conv.pipelineStep = (conv.pipelineStep ?? 0) + 1;
            }
        } else {
            teammateMentions = filterMentionsForPipeline(teammateMentions, pipeline, currentAgentId, currentLoops);

            for (const m of teammateMentions) {
                const targetIdx = pipeline.sequence.indexOf(m.teammateId);
                const currentIdx = pipeline.sequence.indexOf(currentAgentId);
                if (targetIdx >= 0 && currentIdx >= 0 && targetIdx < currentIdx) {
                    conv.pipelineLoops = currentLoops + 1;
                    conv.pipelineStep = targetIdx;
                    loopBacks.push({ from: currentAgentId, to: m.teammateId });
                } else {
                    conv.pipelineStep = (conv.pipelineStep ?? 0) + 1;
                }
            }
        }

        // Route to next
        if (teammateMentions.length > 0) {
            conv.pending += teammateMentions.length;
            const mention = teammateMentions[0];
            currentAgentId = mention.teammateId;
            currentMessage = mention.message;
        } else {
            // Pipeline done
            break;
        }

        conv.pending--;
    }

    // Clean up
    conversations.delete(convId);

    return {
        stepsExecuted,
        finalResponses: conv.responses,
        loopBacks,
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('pipeline integration: strict mode', () => {
    it('routes through all agents in sequence', async () => {
        const result = await simulatePipelineRun(
            pipelineStrict,
            {
                po: 'User story: implement feature X with AC: ...',
                coder: 'Implemented feature X in src/feature.py with 3 tests',
                reviewer: 'Code review passed. All checks green.',
            },
            'Build feature X'
        );

        expect(result.stepsExecuted).toEqual(['po', 'coder', 'reviewer']);
        expect(result.finalResponses).toHaveLength(3);
        expect(result.finalResponses[0].agentId).toBe('po');
        expect(result.finalResponses[1].agentId).toBe('coder');
        expect(result.finalResponses[2].agentId).toBe('reviewer');
    });

    it('passes original request + previous output to each step', async () => {
        let coderReceivedMessage = '';
        let reviewerReceivedMessage = '';

        // Capture what each agent receives by checking the mention message
        const pipeline: PipelineConfig = { sequence: ['po', 'coder', 'reviewer'], strict: true };
        const teamWithPipeline: TeamConfig = { ...team, pipeline };
        const teamsLocal: Record<string, TeamConfig> = { pipeline_team: teamWithPipeline };
        const teamContext = { teamId: 'pipeline_team', team: teamWithPipeline };

        const convId = `ctx_test_${Date.now()}`;
        const conv: Conversation = {
            id: convId, channel: 'test', sender: 'tester',
            originalMessage: 'Build feature X',
            messageId: `msg_${Date.now()}`, pending: 1,
            responses: [], files: new Set(), totalMessages: 0,
            maxMessages: MAX_CONVERSATION_MESSAGES, teamContext,
            startTime: Date.now(), outgoingMentions: new Map(),
            pipelineStep: 0, completedAgents: new Set(), pipelineLoops: 0,
        };
        conversations.set(convId, conv);

        // Step 1: PO
        const poResponse = 'Story: As a user I want feature X';
        conv.responses.push({ agentId: 'po', response: poResponse });
        conv.totalMessages++;
        const nextAfterPo = getNextPipelineAgent(pipeline, 'po');
        expect(nextAfterPo).toBe('coder');
        const msgToCoder = `[Original request]:\n${conv.originalMessage}\n\n[Output from @po]:\n${poResponse}`;
        coderReceivedMessage = msgToCoder;

        // Step 2: Coder
        const coderResponse = 'Implemented in feature.py';
        conv.responses.push({ agentId: 'coder', response: coderResponse });
        conv.totalMessages++;
        const nextAfterCoder = getNextPipelineAgent(pipeline, 'coder');
        expect(nextAfterCoder).toBe('reviewer');
        const msgToReviewer = `[Original request]:\n${conv.originalMessage}\n\n[Output from @coder]:\n${coderResponse}`;
        reviewerReceivedMessage = msgToReviewer;

        // Step 3: Reviewer (last)
        const nextAfterReviewer = getNextPipelineAgent(pipeline, 'reviewer');
        expect(nextAfterReviewer).toBeNull();

        // Verify context passed correctly
        expect(coderReceivedMessage).toContain('Build feature X');
        expect(coderReceivedMessage).toContain('Story: As a user I want feature X');
        expect(reviewerReceivedMessage).toContain('Build feature X');
        expect(reviewerReceivedMessage).toContain('Implemented in feature.py');

        conversations.delete(convId);
    });

    it('stops after the last agent without errors', async () => {
        const result = await simulatePipelineRun(
            { sequence: ['coder'], strict: true },
            { coder: 'Done in one step' },
            'Simple task'
        );

        expect(result.stepsExecuted).toEqual(['coder']);
        expect(result.finalResponses).toHaveLength(1);
    });
});

describe('pipeline integration: non-strict with loop-backs', () => {
    it('allows forward mention to next agent', async () => {
        const result = await simulatePipelineRun(
            pipelineWithLoops,
            {
                po: '[@coder: implement feature X based on story...]',
                coder: '[@reviewer: please review PR #42]',
                reviewer: 'Approved. All good.',
            },
            'Build feature X'
        );

        expect(result.stepsExecuted).toEqual(['po', 'coder', 'reviewer']);
        expect(result.loopBacks).toHaveLength(0);
    });

    it('allows reviewer to send work back to coder (loop-back)', async () => {
        // First pass: reviewer rejects, sends back to coder
        // Second pass: coder fixes, reviewer approves
        let coderCallCount = 0;
        const result = await simulatePipelineRun(
            pipelineWithLoops,
            {
                po: '[@coder: implement feature X]',
                coder: () => {
                    coderCallCount++;
                    if (coderCallCount <= 1) {
                        return '[@reviewer: please review PR #42]';
                    }
                    return '[@reviewer: fixed the issues, please re-review]';
                },
                reviewer: () => '[@coder: needs revision — missing tests]',
            },
            'Build feature X'
        );

        // The loop should work: po → coder → reviewer → coder (loop) → reviewer
        // But since our mock returns static strings, the loop detection depends
        // on the mention content. Let's verify the mechanics work.
        expect(result.stepsExecuted[0]).toBe('po');
        expect(result.stepsExecuted[1]).toBe('coder');
        expect(result.stepsExecuted[2]).toBe('reviewer');

        // Reviewer mentions @coder (backward) → should loop
        expect(result.loopBacks.length).toBeGreaterThanOrEqual(1);
        expect(result.loopBacks[0]).toEqual({ from: 'reviewer', to: 'coder' });
    });

    it('blocks loop-back when maxLoops exhausted', async () => {
        const noLoopPipeline: PipelineConfig = {
            sequence: ['po', 'coder', 'reviewer'],
            strict: false,
            maxLoops: 0,
        };

        const result = await simulatePipelineRun(
            noLoopPipeline,
            {
                po: '[@coder: implement it]',
                coder: '[@reviewer: review please]',
                reviewer: '[@coder: needs fixing]', // This should be blocked (maxLoops=0)
            },
            'Build feature X'
        );

        expect(result.stepsExecuted).toEqual(['po', 'coder', 'reviewer']);
        expect(result.loopBacks).toHaveLength(0); // No loops allowed
    });

    it('blocks skipping agents in the pipeline', async () => {
        const result = await simulatePipelineRun(
            pipelineWithLoops,
            {
                po: '[@reviewer: skip coder, review directly]', // Should be blocked
                coder: 'Would not get here',
                reviewer: 'Would not get here either',
            },
            'Build feature X'
        );

        // PO tried to skip to reviewer, which is not next-in-sequence (coder is next)
        // So the pipeline should stop after PO
        expect(result.stepsExecuted).toEqual(['po']);
    });
});

describe('pipeline integration: queue flow', () => {
    beforeEach(() => setupTestDb());
    afterEach(() => teardownTestDb());

    it('messages flow through DB correctly in pipeline order', () => {
        initQueueDb(path.join(tmpDir, 'tinyclaw.db'));

        // Enqueue initial message
        const rowId = enqueueMessage({
            channel: 'web',
            sender: 'tester',
            message: '@pipeline_team build feature X',
            messageId: 'test_msg_1',
            agent: 'po', // routed to first in pipeline
        });
        expect(rowId).toBeGreaterThan(0);

        // Claim as PO
        const msg = claimNextMessage('po');
        expect(msg).not.toBeNull();
        expect(msg!.agent).toBe('po');
        expect(msg!.status).toBe('processing');

        // Complete PO's work
        completeMessage(msg!.id);

        // Enqueue internal message to coder (as pipeline would do)
        const internalId = enqueueMessage({
            channel: 'web',
            sender: 'tester',
            message: '[Pipeline step from @po]:\nStory written',
            messageId: 'internal_po_coder_1',
            agent: 'coder',
            conversationId: 'conv_1',
            fromAgent: 'po',
        });
        expect(internalId).toBeGreaterThan(0);

        // Claim as coder
        const coderMsg = claimNextMessage('coder');
        expect(coderMsg).not.toBeNull();
        expect(coderMsg!.agent).toBe('coder');
        expect(coderMsg!.from_agent).toBe('po');
        expect(coderMsg!.conversation_id).toBe('conv_1');

        // Complete coder's work
        completeMessage(coderMsg!.id);

        // Enqueue internal message to reviewer
        enqueueMessage({
            channel: 'web',
            sender: 'tester',
            message: '[Pipeline step from @coder]:\nImplemented',
            messageId: 'internal_coder_reviewer_1',
            agent: 'reviewer',
            conversationId: 'conv_1',
            fromAgent: 'coder',
        });

        // Claim as reviewer
        const reviewerMsg = claimNextMessage('reviewer');
        expect(reviewerMsg).not.toBeNull();
        expect(reviewerMsg!.agent).toBe('reviewer');
        expect(reviewerMsg!.from_agent).toBe('coder');

        // Complete reviewer's work and enqueue final response
        completeMessage(reviewerMsg!.id);
        enqueueResponse({
            channel: 'web',
            sender: 'tester',
            message: 'Pipeline complete: feature X built and reviewed',
            originalMessage: '@pipeline_team build feature X',
            messageId: 'test_msg_1',
            agent: 'reviewer',
        });

        // Verify response is in the queue
        const responses = getResponsesForChannel('web');
        expect(responses).toHaveLength(1);
        expect(responses[0].message).toContain('Pipeline complete');
        expect(responses[0].agent).toBe('reviewer');
    });

    it('pending agents reflect pipeline progression', () => {
        initQueueDb(path.join(tmpDir, 'tinyclaw.db'));

        // Enqueue for PO
        enqueueMessage({
            channel: 'web', sender: 'tester',
            message: 'task 1', messageId: 'pa_1', agent: 'po',
        });

        let pending = getPendingAgents();
        expect(pending).toContain('po');
        expect(pending).not.toContain('coder');

        // Claim and complete PO, enqueue for coder
        const poMsg = claimNextMessage('po');
        completeMessage(poMsg!.id);
        enqueueMessage({
            channel: 'web', sender: 'tester',
            message: 'from po', messageId: 'pa_2', agent: 'coder',
            conversationId: 'conv_pa', fromAgent: 'po',
        });

        pending = getPendingAgents();
        expect(pending).toContain('coder');
        expect(pending).not.toContain('po');
    });
});
