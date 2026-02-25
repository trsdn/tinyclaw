import { describe, it, expect } from 'vitest';
import { parseAgentRouting, extractTeammateMentions, findTeamForAgent } from '../../src/lib/routing';
import { AgentConfig, TeamConfig } from '../../src/lib/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const agents: Record<string, AgentConfig> = {
  coder: { name: 'Coder', provider: 'anthropic', model: 'sonnet', working_directory: '/tmp/coder' },
  reviewer: { name: 'Reviewer', provider: 'anthropic', model: 'sonnet', working_directory: '/tmp/reviewer' },
  designer: { name: 'Designer', provider: 'openai', model: 'gpt-4.1', working_directory: '/tmp/designer' },
};

const teams: Record<string, TeamConfig> = {
  dev: { name: 'DevTeam', agents: ['coder', 'reviewer'], leader_agent: 'coder' },
  design: { name: 'DesignTeam', agents: ['designer'], leader_agent: 'designer' },
};

// ── parseAgentRouting ─────────────────────────────────────────────────────────

describe('parseAgentRouting', () => {
  it('routes @agent_id to the correct agent with remaining message', () => {
    const result = parseAgentRouting('@coder fix the bug', agents, teams);
    expect(result).toEqual({ agentId: 'coder', message: 'fix the bug' });
  });

  it('routes @team_id to the team leader and sets isTeam', () => {
    const result = parseAgentRouting('@dev build the feature', agents, teams);
    expect(result).toEqual({ agentId: 'coder', message: 'build the feature', isTeam: true });
  });

  it('matches agent names case-insensitively', () => {
    const result = parseAgentRouting('@CODER do something', agents, teams);
    expect(result).toEqual({ agentId: 'coder', message: 'do something' });
  });

  it('matches team names case-insensitively', () => {
    const result = parseAgentRouting('@devteam do something', agents, teams);
    expect(result).toEqual({ agentId: 'coder', message: 'do something', isTeam: true });
  });

  it('preserves [channel/sender]: prefix in the message', () => {
    const result = parseAgentRouting('[discord/Alice]: @coder hello', agents, teams);
    expect(result).toEqual({ agentId: 'coder', message: '[discord/Alice]: hello' });
  });

  it('falls back to default for unknown @mentions', () => {
    const result = parseAgentRouting('@unknown hello', agents, teams);
    expect(result).toEqual({ agentId: 'default', message: '@unknown hello' });
  });

  it('falls back to default for plain messages without @', () => {
    const result = parseAgentRouting('just a plain message', agents, teams);
    expect(result).toEqual({ agentId: 'default', message: 'just a plain message' });
  });

  it('handles @agent with no body — keeps raw message for context', () => {
    // When there is no message body and no channel prefix, the function
    // intentionally returns the raw input as the message so the agent
    // still sees what was sent.
    const result = parseAgentRouting('@coder', agents, teams);
    expect(result).toEqual({ agentId: 'coder', message: '@coder' });
  });

  it('defaults teams to empty object when omitted', () => {
    const result = parseAgentRouting('@coder hello', agents);
    expect(result).toEqual({ agentId: 'coder', message: 'hello' });
  });

  it('matches agent by name when ID does not match', () => {
    // 'Reviewer' as name, 'reviewer' as id — use the name
    const result = parseAgentRouting('@reviewer fix it', agents, teams);
    expect(result).toEqual({ agentId: 'reviewer', message: 'fix it' });
  });
});

// ── extractTeammateMentions ───────────────────────────────────────────────────

describe('extractTeammateMentions', () => {
  it('extracts a single [@teammate: message] mention', () => {
    const results = extractTeammateMentions(
      '[@reviewer: please review this code]',
      'coder', 'dev', teams, agents
    );
    expect(results).toHaveLength(1);
    expect(results[0].teammateId).toBe('reviewer');
    expect(results[0].message).toContain('please review this code');
  });

  it('prepends shared context (text outside tags)', () => {
    const results = extractTeammateMentions(
      'Here is the context.\n[@reviewer: please review]',
      'coder', 'dev', teams, agents
    );
    expect(results).toHaveLength(1);
    expect(results[0].message).toContain('Here is the context.');
    expect(results[0].message).toContain('please review');
  });

  it('deduplicates mentions of the same teammate', () => {
    const results = extractTeammateMentions(
      '[@reviewer: first message] [@reviewer: second message]',
      'coder', 'dev', teams, agents
    );
    expect(results).toHaveLength(1);
    expect(results[0].teammateId).toBe('reviewer');
  });

  it('supports comma-separated agent IDs in a single tag', () => {
    // Only reviewer is in the dev team with coder, designer is not
    // So we add designer to a team that includes coder for this test
    const extTeams: Record<string, TeamConfig> = {
      full: { name: 'FullTeam', agents: ['coder', 'reviewer', 'designer'], leader_agent: 'coder' },
    };
    const results = extractTeammateMentions(
      '[@reviewer,designer: do the thing]',
      'coder', 'full', extTeams, agents
    );
    expect(results).toHaveLength(2);
    expect(results.map(r => r.teammateId).sort()).toEqual(['designer', 'reviewer']);
  });

  it('prevents self-mention', () => {
    const results = extractTeammateMentions(
      '[@coder: talking to myself]',
      'coder', 'dev', teams, agents
    );
    expect(results).toHaveLength(0);
  });

  it('prevents mentioning non-team members', () => {
    const results = extractTeammateMentions(
      '[@designer: you are not on my team]',
      'coder', 'dev', teams, agents
    );
    expect(results).toHaveLength(0);
  });

  it('returns empty array when no tags are present', () => {
    const results = extractTeammateMentions(
      'no mentions here',
      'coder', 'dev', teams, agents
    );
    expect(results).toHaveLength(0);
  });
});

// ── findTeamForAgent ──────────────────────────────────────────────────────────

describe('findTeamForAgent', () => {
  it('returns the team containing the agent', () => {
    const result = findTeamForAgent('coder', teams);
    expect(result).not.toBeNull();
    expect(result!.teamId).toBe('dev');
    expect(result!.team.name).toBe('DevTeam');
  });

  it('returns null when the agent is not in any team', () => {
    const result = findTeamForAgent('unknown-agent', teams);
    expect(result).toBeNull();
  });

  it('returns the first matching team when agent is in multiple teams', () => {
    const multiTeams: Record<string, TeamConfig> = {
      alpha: { name: 'Alpha', agents: ['coder'], leader_agent: 'coder' },
      beta: { name: 'Beta', agents: ['coder', 'reviewer'], leader_agent: 'reviewer' },
    };
    const result = findTeamForAgent('coder', multiTeams);
    expect(result).not.toBeNull();
    expect(result!.teamId).toBe('alpha');
  });
});
