import path from 'path';
import { AgentConfig, TeamConfig, PipelineConfig } from './types';
import { log } from './logging';

/**
 * Find the first team that contains the given agent.
 */
export function findTeamForAgent(agentId: string, teams: Record<string, TeamConfig>): { teamId: string; team: TeamConfig } | null {
    for (const [teamId, team] of Object.entries(teams)) {
        if (team.agents.includes(agentId)) {
            return { teamId, team };
        }
    }
    return null;
}

/**
 * Check if a mentioned ID is a valid teammate of the current agent in the given team.
 */
export function isTeammate(
    mentionedId: string,
    currentAgentId: string,
    teamId: string,
    teams: Record<string, TeamConfig>,
    agents: Record<string, AgentConfig>
): boolean {
    const team = teams[teamId];
    if (!team) {
        log('WARN', `isTeammate check failed: Team '${teamId}' not found`);
        return false;
    }

    if (mentionedId === currentAgentId) {
        log('DEBUG', `isTeammate check failed: Self-mention (agent: ${mentionedId})`);
        return false;
    }

    if (!team.agents.includes(mentionedId)) {
        log('WARN', `isTeammate check failed: Agent '${mentionedId}' not in team '${teamId}' (members: ${team.agents.join(', ')})`);
        return false;
    }

    if (!agents[mentionedId]) {
        log('WARN', `isTeammate check failed: Agent '${mentionedId}' not found in agents config`);
        return false;
    }

    return true;
}

/**
 * Extract the first valid @teammate mention from a response text.
 * Returns the teammate agent ID and the rest of the message, or null if no teammate mentioned.
 */
export function extractTeammateMentions(
    response: string,
    currentAgentId: string,
    teamId: string,
    teams: Record<string, TeamConfig>,
    agents: Record<string, AgentConfig>
): { teammateId: string; message: string }[] {
    const results: { teammateId: string; message: string }[] = [];
    const seen = new Set<string>();

    // Tag format: [@agent_id: message] or [@agent1,agent2: message]
    const tagRegex = /\[@([^\]]+?):\s*([\s\S]*?)\]/g;

    // Strip all [@teammate: ...] tags from the full response to get shared context
    const sharedContext = response.replace(tagRegex, '').trim();
    tagRegex.lastIndex = 0;

    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = tagRegex.exec(response)) !== null) {
        const directMessage = tagMatch[2].trim();
        const fullMessage = sharedContext
            ? `${sharedContext}\n\n------\n\nDirected to you:\n${directMessage}`
            : directMessage;

        // Support comma-separated agent IDs: [@coder,reviewer: message]
        const candidateIds = tagMatch[1].toLowerCase().split(',').map(id => id.trim()).filter(Boolean);
        for (const candidateId of candidateIds) {
            if (!seen.has(candidateId) && isTeammate(candidateId, currentAgentId, teamId, teams, agents)) {
                results.push({ teammateId: candidateId, message: fullMessage });
                seen.add(candidateId);
            }
        }
    }
    return results;
}

/**
 * Get the reset flag path for a specific agent.
 */
export function getAgentResetFlag(agentId: string, workspacePath: string): string {
    return path.join(workspacePath, agentId, 'reset_flag');
}

/**
 * Get the next agent in a pipeline sequence after the given agent.
 * Returns null if the agent is the last in the sequence or not found.
 */
export function getNextPipelineAgent(pipeline: PipelineConfig, currentAgentId: string): string | null {
    const idx = pipeline.sequence.indexOf(currentAgentId);
    if (idx < 0 || idx >= pipeline.sequence.length - 1) return null;
    return pipeline.sequence[idx + 1];
}

/**
 * Check if an agent can loop back to an earlier pipeline step.
 * Returns the target agent ID if looping is allowed, null otherwise.
 */
export function getPipelineLoopTarget(
    pipeline: PipelineConfig,
    currentAgentId: string,
    targetAgentId: string,
    currentLoops: number,
): boolean {
    const maxLoops = pipeline.maxLoops ?? 0;
    if (maxLoops <= 0 || currentLoops >= maxLoops) return false;

    const currentIdx = pipeline.sequence.indexOf(currentAgentId);
    const targetIdx = pipeline.sequence.indexOf(targetAgentId);
    // Only allow looping backward (target earlier in sequence)
    return currentIdx > 0 && targetIdx >= 0 && targetIdx < currentIdx;
}

/**
 * Filter teammate mentions to only allow the next agent in the pipeline sequence.
 * When maxLoops > 0, also allows sending work back to earlier agents in the sequence.
 */
export function filterMentionsForPipeline(
    mentions: { teammateId: string; message: string }[],
    pipeline: PipelineConfig,
    currentAgentId: string,
    currentLoops: number = 0,
): { teammateId: string; message: string }[] {
    const nextAgent = getNextPipelineAgent(pipeline, currentAgentId);
    const filtered: { teammateId: string; message: string }[] = [];
    const blocked: string[] = [];

    for (const m of mentions) {
        if (m.teammateId === nextAgent) {
            filtered.push(m);
        } else if (getPipelineLoopTarget(pipeline, currentAgentId, m.teammateId, currentLoops)) {
            filtered.push(m);
            log('INFO', `Pipeline loop: @${currentAgentId} → @${m.teammateId} (loop ${currentLoops + 1}/${pipeline.maxLoops})`);
        } else {
            blocked.push(m.teammateId);
        }
    }

    if (blocked.length > 0) {
        const allowed = nextAgent ? `@${nextAgent}` : 'none (last step)';
        const loopInfo = (pipeline.maxLoops ?? 0) > 0 ? ` (loops: ${currentLoops}/${pipeline.maxLoops})` : '';
        log('WARN', `Pipeline: @${currentAgentId} tried to mention ${blocked.map(id => `@${id}`).join(', ')} — allowed: ${allowed}${loopInfo}`);
    }

    if (filtered.length === 0 && !nextAgent) {
        log('INFO', `Pipeline: @${currentAgentId} is the last step — no further mentions allowed`);
    }

    return filtered;
}

/**
 * Parse @agent_id or @team_id prefix from a message.
 * Returns { agentId, message, isTeam } where message has the prefix stripped.
 */
export function parseAgentRouting(
    rawMessage: string,
    agents: Record<string, AgentConfig>,
    teams: Record<string, TeamConfig> = {}
): { agentId: string; message: string; isTeam?: boolean } {
    // Match @agent_id, optionally preceded by [channel/sender]: prefix from messages API
    const match = rawMessage.match(/^(\[[^\]]*\]:\s*)?@(\S+)(?:\s+([\s\S]*))?$/);
    if (match) {
        const prefix = match[1] || '';
        const candidateId = match[2].toLowerCase();
        const message = (prefix + (match[3] || '')).trim();

        let resolvedAgentId: string | null = null;
        let isTeam = false;

        if (agents[candidateId]) {
            resolvedAgentId = candidateId;
        } else if (teams[candidateId]) {
            resolvedAgentId = teams[candidateId].leader_agent;
            isTeam = true;
        } else {
            for (const [id, config] of Object.entries(agents)) {
                if (config.name.toLowerCase() === candidateId) {
                    resolvedAgentId = id;
                    break;
                }
            }
            if (!resolvedAgentId) {
                for (const [, config] of Object.entries(teams)) {
                    if (config.name.toLowerCase() === candidateId) {
                        resolvedAgentId = config.leader_agent;
                        isTeam = true;
                        break;
                    }
                }
            }
        }

        if (resolvedAgentId) {
            if (!message && !prefix) {
                return { agentId: resolvedAgentId, message: rawMessage, ...(isTeam ? { isTeam: true } : {}) };
            }
            return { agentId: resolvedAgentId, message, ...(isTeam ? { isTeam: true } : {}) };
        }
    }
    return { agentId: 'default', message: rawMessage };
}
