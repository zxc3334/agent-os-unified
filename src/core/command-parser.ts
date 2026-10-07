import type { CliId } from '../cli/types.js';

export type SlashCommand =
  | { name: 'close' | 'status' | 'help' | 'new' | 'resume' | 'team' }
  | { name: 'compact'; instructions?: string }
  | { name: 'cd'; path?: string }
  | { name: 'schedules' }
  | { name: 'topics' }
  | { name: 'schedule'; request?: string }
  | { name: 'skills'; action: 'list' | 'enable' | 'disable'; skillId?: string }
  | { name: 'memory'; action: 'review' | 'recent'; page: number }
  | { name: 'memory'; action: 'extract' }
  | { name: 'memory'; action: 'confirm' | 'reject' | 'forget'; entryId: string }
  | { name: 'memory'; action: 'correct'; entryId: string; content: string };

const COMMAND_RE = /^(?:@.+?\s+)?\/(close|status|help|new|resume|team)\s*$/;const CD_RE = /^(?:@.+?\s+)?\/cd(?:\s+([\s\S]+?))?\s*$/;
const COMPACT_RE = /^(?:@.+?\s+)?\/compact(?:\s+([\s\S]+?))?\s*$/;
const SCHEDULE_RE = /^(?:@.+?\s+)?\/schedule(?:\s+([\s\S]+?))?\s*$/;
const SCHEDULES_RE = /^(?:@.+?\s+)?\/schedules\s*$/;
const TOPICS_RE = /^(?:@.+?\s+)?\/topics\s*$/;
const SKILLS_RE = /^(?:@.+?\s+)?\/skills(?:\s+([\s\S]+?))?\s*$/;
const MEMORY_RE = /^(?:@.+?\s+)?\/memory(?:\s+([\s\S]+?))?\s*$/;
const MEMORY_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;
const CLI_REQUEST_RE = /^(?:@.+?\s+)?\/(agy|pi|claude|codex)(?:\s+([\s\S]*))?$/;

export function parseCommand(text: string): SlashCommand | undefined {
  const value = text.trim();
  if (SCHEDULES_RE.test(value)) return { name: 'schedules' };
  if (TOPICS_RE.test(value)) return { name: 'topics' };
  const skillsMatch = SKILLS_RE.exec(value);
  if (skillsMatch) {
    const args = skillsMatch[1]?.trim().split(/\s+/, 3) ?? [];
    if (!args.length || args[0] === 'list') return args.length <= 1 ? { name: 'skills', action: 'list' } : undefined;
    if ((args[0] === 'enable' || args[0] === 'disable') && args.length === 2 && /^[a-z0-9-]{1,64}$/.test(args[1] ?? '')) {
      return { name: 'skills', action: args[0], skillId: args[1] };
    }
    return undefined;
  }
  const memoryMatch = MEMORY_RE.exec(value);
  if (memoryMatch) {
    const args = memoryMatch[1]?.trim().split(/\s+/, 3) ?? [];
    const action = args[0] || 'review';
    if (action === 'extract') {
      return args.length === 1 ? { name: 'memory', action } : undefined;
    }
    if (action === 'review' || action === 'recent') {
      if (args.length > 2) return undefined;
      const page = args[1] === undefined ? 1 : Number(args[1]);
      if (!Number.isSafeInteger(page) || page < 1 || page > 10) return undefined;
      return { name: 'memory', action, page };
    }
    if (action === 'confirm' || action === 'reject' || action === 'forget') {
      if (args.length !== 2 || !MEMORY_ID_RE.test(args[1])) return undefined;
      return { name: 'memory', action, entryId: args[1] };
    }
    if (action === 'correct') {
      const correction = /^correct\s+([a-zA-Z0-9_-]{1,100})\s+([\s\S]+)$/.exec(memoryMatch[1] ?? '');
      if (!correction?.[2].trim()) return undefined;
      return { name: 'memory', action, entryId: correction[1], content: correction[2].trim() };
    }
    return undefined;
  }
  const scheduleMatch = SCHEDULE_RE.exec(value);
  if (scheduleMatch) {
    return { name: 'schedule', request: scheduleMatch[1]?.trim() || undefined };
  }
  const cdMatch = CD_RE.exec(value);
  if (cdMatch) return { name: 'cd', path: cdMatch[1]?.trim() || undefined };
  const compactMatch = COMPACT_RE.exec(value);
  if (compactMatch) {
    return {
      name: 'compact',
      instructions: compactMatch[1]?.trim() || undefined,
    };
  }
  const match = COMMAND_RE.exec(value);
  if (!match) return undefined;
  return {
    name: match[1] as 'close' | 'status' | 'help' | 'new' | 'resume' | 'team',
  };
}

export interface CliRequest {
  cliId: CliId;
  prompt: string;
}

export function parseCliRequest(text: string): CliRequest | undefined {
  const match = CLI_REQUEST_RE.exec(text.trim());
  if (!match) return undefined;
  return {
    cliId: match[1] as CliId,
    prompt: (match[2] ?? '').trim(),
  };
}
