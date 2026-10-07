/** Versioned, synthetic-only replay data. Never add real conversation content here. */
export const PERSONAL_AGENT_REPLAY_FIXTURE_VERSION = 1 as const;

export type ReplayMemoryAction = {
  kind: 'save' | 'correct';
  explicitlyRequested: boolean;
  persisted: boolean;
  targetOwned?: boolean;
};

export interface PersonalAgentReplayFixture {
  id: string;
  actor: 'owner-dm' | 'other-dm' | 'group' | 'scheduler';
  authorizedMemorySpaceIds: string[];
  requestedMemorySpaceIds?: string[];
  contextUnavailable?: boolean;
  executionError?: boolean;
  cancelBeforeRun?: boolean;
  reportProgress?: boolean;
  artifactIds?: string[];
  outcome?: 'succeeded' | 'partial';
  memoryAction?: ReplayMemoryAction;
  usageTokens?: number;
  pricePerMillionUsd?: number;
  requestedSideEffect?: 'send_email' | 'publish' | 'place_call';
  explicitlyApprovedSideEffect?: boolean;
  /** Synthetic string used to prove that trace events do not retain input text. */
  privateInputMarker: string;
}

function fixture(
  id: string,
  actor: PersonalAgentReplayFixture['actor'],
  authorizedMemorySpaceIds: string[],
  patch: Partial<Omit<PersonalAgentReplayFixture, 'id' | 'actor' | 'authorizedMemorySpaceIds' | 'privateInputMarker'>> & {
    privateInputMarker?: string;
  } = {},
): PersonalAgentReplayFixture {
  return {
    id,
    actor,
    authorizedMemorySpaceIds,
    ...patch,
    privateInputMarker: patch.privateInputMarker ?? `SYNTHETIC-PRIVATE-INPUT-${id}`,
  };
}

/** 25 fixed cases; all identifiers and text are fabricated. */
export const PERSONAL_AGENT_REPLAY_FIXTURES: readonly PersonalAgentReplayFixture[] = [
  fixture('R01-private-personal-read', 'owner-dm', ['personal']),
  fixture('R02-private-project-read', 'owner-dm', ['project-alpha']),
  fixture('R03-group-no-memory', 'group', ['personal'], {
    requestedMemorySpaceIds: ['personal'],
  }),
  fixture('R04-group-forged-private-request', 'group', [], {
    requestedMemorySpaceIds: ['personal'],
  }),
  fixture('R05-owner-only-selected-scope', 'owner-dm', ['project-alpha'], {
    requestedMemorySpaceIds: ['personal', 'project-alpha'],
  }),
  fixture('R06-scheduled-authorized-scope', 'scheduler', ['career']),
  fixture('R07-explicit-save-persisted', 'owner-dm', ['personal'], {
    memoryAction: { kind: 'save', explicitlyRequested: true, persisted: true },
  }),
  fixture('R08-implied-save-not-confirmed', 'owner-dm', ['personal'], {
    memoryAction: { kind: 'save', explicitlyRequested: false, persisted: true },
  }),
  fixture('R09-explicit-save-write-failed', 'owner-dm', ['personal'], {
    memoryAction: { kind: 'save', explicitlyRequested: true, persisted: false },
  }),
  fixture('R10-save-in-group-is-not-acknowledged', 'group', ['personal'], {
    memoryAction: { kind: 'save', explicitlyRequested: true, persisted: true },
  }),
  fixture('R11-explicit-owned-correction', 'owner-dm', ['personal'], {
    memoryAction: { kind: 'correct', explicitlyRequested: true, persisted: true, targetOwned: true },
  }),
  fixture('R12-correction-of-other-owner-rejected', 'owner-dm', ['personal'], {
    memoryAction: { kind: 'correct', explicitlyRequested: true, persisted: true, targetOwned: false },
  }),
  fixture('R13-implicit-correction-rejected', 'owner-dm', ['personal'], {
    memoryAction: { kind: 'correct', explicitlyRequested: false, persisted: true, targetOwned: true },
  }),
  fixture('R14-context-unavailable', 'owner-dm', ['career'], { contextUnavailable: true }),
  fixture('R15-executor-error', 'owner-dm', ['project-alpha'], { executionError: true }),
  fixture('R16-cancel-before-run', 'owner-dm', ['personal'], {
    cancelBeforeRun: true,
  }),
  fixture('R17-progress-with-artifact-ids', 'owner-dm', ['career'], {
    reportProgress: true,
    artifactIds: ['artifact-resume-v1'],
  }),
  fixture('R18-success-no-artifact', 'owner-dm', ['project-alpha']),
  fixture('R19-partial-result', 'owner-dm', ['project-alpha'], { outcome: 'partial' }),
  fixture('R20-known-usage-and-price', 'owner-dm', ['career'], {
    usageTokens: 1200,
    pricePerMillionUsd: 2,
  }),
  fixture('R21-unknown-usage', 'owner-dm', ['personal']),
  fixture('R22-usage-known-price-unknown', 'owner-dm', ['personal'], { usageTokens: 900 }),
  fixture('R23-automatic-publish-blocked', 'owner-dm', ['blog'], {
    requestedSideEffect: 'publish',
    explicitlyApprovedSideEffect: false,
  }),
  fixture('R24-approved-email-adapter-output', 'owner-dm', ['personal'], {
    requestedSideEffect: 'send_email',
    explicitlyApprovedSideEffect: true,
  }),
  fixture('R25-non-owner-private-scope-denied', 'other-dm', ['personal'], {
    requestedMemorySpaceIds: ['personal'],
  }),
];
