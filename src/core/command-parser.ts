import type { CliId } from '../cli/types.js';

export type SlashCommand =
  | { name: 'close' | 'status' | 'help' | 'new' | 'resume' | 'team' }
  | { name: 'compact'; instructions?: string }
  | { name: 'cd'; path?: string }
  | { name: 'schedules' }
  | { name: 'topics' }
  | { name: 'schedule'; request?: string }
  | { name: 'skills'; action: 'list' | 'enable' | 'disable'; skillId?: string }
  | { name: 'career'; action: 'status' }
  | { name: 'career'; action: 'evidence'; status: 'confirmed' | 'unconfirmed'; claim: string }
  | { name: 'career'; action: 'role'; title: string; requirements: string[] }
  | { name: 'career'; action: 'resume'; roleId: string; evidenceIds: string[] }
  | { name: 'career'; action: 'approve'; resumeId: string }
  | { name: 'career'; action: 'export'; resumeId: string }
  | { name: 'career'; action: 'feedback'; resumeId: string; summary: string; weakPoint: string }
  | { name: 'career'; action: 'review'; learningId: string; score: number }
  | { name: 'career'; action: 'due' }
  | { name: 'career'; action: 'material-add'; spaceId: string; title: string; content: string }
  | { name: 'career'; action: 'material-search'; query: string }
  | { name: 'career'; action: 'material-revoke'; materialId: string }
  | { name: 'affair'; action: 'list' }
  | { name: 'affair'; action: 'select'; affairId: string }
  | { name: 'affair'; action: 'summary'; summary: string }
  | { name: 'task'; action: 'recent' }
  | { name: 'task'; action: 'trace'; taskId: string }
  | { name: 'blog'; action: 'search'; query: string }
  | { name: 'blog'; action: 'propose'; query: string; intendedUse: string }
  | { name: 'blog'; action: 'decide'; proposalId: string; decision: 'accepted' | 'rejected' | 'no-connection' }
  | { name: 'daily'; action: 'list' }
  | { name: 'daily'; action: 'add'; kind: 'daily' | 'reading' | 'exploration'; content: string; authorView?: string; userView?: string }
  | { name: 'daily'; action: 'recap'; from: string; through: string }
  | { name: 'daily'; action: 'scope'; recordId: string; scopeId: string | null }
  | { name: 'daily'; action: 'delete'; recordId: string }
  | { name: 'reminder'; action: 'list' }
  | { name: 'reminder'; action: 'add' | 'edit'; reminderId?: string; due: string; content: string }
  | { name: 'reminder'; action: 'cancel' | 'retry'; reminderId: string }
  | { name: 'memory'; action: 'review' | 'recent'; page: number }
  | { name: 'memory'; action: 'extract' | 'spaces' }
  | { name: 'memory'; action: 'space-create'; nameText: string }
  | { name: 'memory'; action: 'space-rename'; spaceId: string; nameText: string }
  | { name: 'memory'; action: 'scope'; spaceId: string }
  | { name: 'memory'; action: 'confirm' | 'reject' | 'forget'; entryId: string }
  | { name: 'memory'; action: 'correct'; entryId: string; content: string };

const COMMAND_RE = /^(?:@.+?\s+)?\/(close|status|help|new|resume|team)\s*$/;const CD_RE = /^(?:@.+?\s+)?\/cd(?:\s+([\s\S]+?))?\s*$/;
const COMPACT_RE = /^(?:@.+?\s+)?\/compact(?:\s+([\s\S]+?))?\s*$/;
const SCHEDULE_RE = /^(?:@.+?\s+)?\/schedule(?:\s+([\s\S]+?))?\s*$/;
const SCHEDULES_RE = /^(?:@.+?\s+)?\/schedules\s*$/;
const TOPICS_RE = /^(?:@.+?\s+)?\/topics\s*$/;
const SKILLS_RE = /^(?:@.+?\s+)?\/skills(?:\s+([\s\S]+?))?\s*$/;
const CAREER_RE = /^(?:@.+?\s+)?\/career(?:\s+([\s\S]+?))?\s*$/;
const AFFAIR_RE = /^(?:@.+?\s+)?\/affair(?:\s+([\s\S]+?))?\s*$/;
const TASK_RE = /^(?:@.+?\s+)?\/task(?:\s+([\s\S]+?))?\s*$/;
const BLOG_RE = /^(?:@.+?\s+)?\/blog(?:\s+([\s\S]+?))?\s*$/;
const DAILY_RE = /^(?:@.+?\s+)?\/daily(?:\s+([\s\S]+?))?\s*$/;
const REMINDER_RE = /^(?:@.+?\s+)?\/reminder(?:\s+([\s\S]+?))?\s*$/;
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
  const dailyMatch = DAILY_RE.exec(value);
  if (dailyMatch) {
    const args = dailyMatch[1]?.trim() ?? '';
    if (!args || args === 'list') return { name: 'daily', action: 'list' };
    const reading = /^add\s+reading\s+([\s\S]+?)\s*::\s*([\s\S]+)$/.exec(args);
    if (reading?.[1]?.trim() && reading[2]?.trim()) {
      const authorView = reading[1].trim();
      const userView = reading[2].trim();
      return { name: 'daily', action: 'add', kind: 'reading', content: `用户观点：${userView}`, authorView, userView };
    }
    const add = /^add\s+(daily|reading|exploration)\s+([\s\S]+)$/.exec(args);
    if (add?.[2]?.trim()) return { name: 'daily', action: 'add', kind: add[1] as 'daily' | 'reading' | 'exploration', content: add[2].trim() };
    const recap = /^recap\s+(\d{4}-\d\d-\d\d)\s+(\d{4}-\d\d-\d\d)$/.exec(args);
    if (recap) return { name: 'daily', action: 'recap', from: recap[1]!, through: recap[2]! };
    const remove = /^delete\s+([a-zA-Z0-9_-]{1,100})$/.exec(args);
    if (remove) return { name: 'daily', action: 'delete', recordId: remove[1]! };
    const scope = /^scope\s+([a-zA-Z0-9_-]{1,100})\s+(none|[a-zA-Z0-9_-]{1,100})$/.exec(args);
    if (scope) return { name: 'daily', action: 'scope', recordId: scope[1]!, scopeId: scope[2] === 'none' ? null : scope[2]! };
    return undefined;
  }
  const reminderMatch = REMINDER_RE.exec(value);
  if (reminderMatch) {
    const args = reminderMatch[1]?.trim() ?? '';
    if (!args || args === 'list') return { name: 'reminder', action: 'list' };
    const cancel = /^(cancel|retry)\s+([a-zA-Z0-9_-]{1,100})$/.exec(args);
    if (cancel) return { name: 'reminder', action: cancel[1] as 'cancel' | 'retry', reminderId: cancel[2]! };
    const add = /^add\s+([\s\S]+?)\s*::\s*([\s\S]+)$/.exec(args);
    if (add?.[1]?.trim() && add[2]?.trim()) return { name: 'reminder', action: 'add', due: add[1]!.trim(), content: add[2]!.trim() };
    const edit = /^edit\s+([a-zA-Z0-9_-]{1,100})\s+([\s\S]+?)\s*::\s*([\s\S]+)$/.exec(args);
    if (edit?.[2]?.trim() && edit[3]?.trim()) return { name: 'reminder', action: 'edit', reminderId: edit[1]!, due: edit[2]!.trim(), content: edit[3]!.trim() };
    return undefined;
  }
  const blogMatch = BLOG_RE.exec(value);
  if (blogMatch) {
    const args = blogMatch[1]?.trim() ?? '';
    const search = /^search\s+([\s\S]+)$/.exec(args);
    if (search?.[1]?.trim()) return { name: 'blog', action: 'search', query: search[1].trim() };
    const propose = /^propose\s+([\s\S]+?)\s*::\s*([\s\S]+)$/.exec(args);
    if (propose?.[1]?.trim() && propose[2]?.trim()) return { name: 'blog', action: 'propose', query: propose[1].trim(), intendedUse: propose[2].trim() };
    const decide = /^decide\s+([A-Za-z0-9][A-Za-z0-9_-]{0,99})\s+(accept|reject|none)$/.exec(args);
    if (decide) return { name: 'blog', action: 'decide', proposalId: decide[1]!, decision: decide[2] === 'accept' ? 'accepted' : decide[2] === 'reject' ? 'rejected' : 'no-connection' };
    return undefined;
  }
  const affairMatch = AFFAIR_RE.exec(value);
  if (affairMatch) {
    const args = affairMatch[1]?.trim() ?? '';
    if (!args || args === 'list') return { name: 'affair', action: 'list' };
    const select = /^select\s+([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/.exec(args);
    if (select) return { name: 'affair', action: 'select', affairId: select[1]! };
    const summary = /^summary(?:\s+([\s\S]+))?$/.exec(args);
    if (summary) return { name: 'affair', action: 'summary', summary: summary[1]?.trim() ?? '' };
    return undefined;
  }
  const taskMatch = TASK_RE.exec(value);
  if (taskMatch) {
    const args = taskMatch[1]?.trim() ?? '';
    if (!args || args === 'recent') return { name: 'task', action: 'recent' };
    const trace = /^trace\s+([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(args);
    if (trace) return { name: 'task', action: 'trace', taskId: trace[1]! };
    return undefined;
  }
  const careerMatch = CAREER_RE.exec(value);
  if (careerMatch) {
    const args = careerMatch[1]?.trim() ?? '';
    if (!args || args === 'status') return { name: 'career', action: 'status' };
    if (args === 'due') return { name: 'career', action: 'due' };
    const materialAdd = /^material add ([a-zA-Z0-9_-]{1,100}) ([^\n:]{1,300})\s*::\s*([\s\S]+)$/.exec(args);
    if (materialAdd?.[3]?.trim()) return { name: 'career', action: 'material-add', spaceId: materialAdd[1]!, title: materialAdd[2]!.trim(), content: materialAdd[3]!.trim() };
    const materialSearch = /^material search ([\s\S]+)$/.exec(args);
    if (materialSearch?.[1]?.trim()) return { name: 'career', action: 'material-search', query: materialSearch[1].trim() };
    const materialRevoke = /^material revoke ([a-zA-Z0-9_-]{1,100})$/.exec(args);
    if (materialRevoke) return { name: 'career', action: 'material-revoke', materialId: materialRevoke[1]! };
    const evidence = /^(evidence)\s+(confirmed|unconfirmed)\s+([\s\S]+)$/.exec(args);
    if (evidence?.[3]?.trim()) return { name: 'career', action: 'evidence', status: evidence[2] as 'confirmed' | 'unconfirmed', claim: evidence[3].trim() };
    const role = /^role\s+([\s\S]+)$/.exec(args);
    if (role?.[1]?.trim()) {
      const [title, requirementsText = ''] = role[1].split(/\s+\|\s+/, 2);
      const requirements = requirementsText.split(';').map((item) => item.trim()).filter(Boolean);
      return { name: 'career', action: 'role', title: title!.trim(), requirements };
    }
    const resume = /^resume\s+([a-zA-Z0-9_-]{1,100})\s+([a-zA-Z0-9_,-]{1,500})$/.exec(args);
    if (resume) return { name: 'career', action: 'resume', roleId: resume[1]!, evidenceIds: [...new Set(resume[2]!.split(',').filter(Boolean))] };
    const approval = /^(approve|export)\s+([a-zA-Z0-9_-]{1,100})$/.exec(args);
    if (approval) return { name: 'career', action: approval[1] as 'approve' | 'export', resumeId: approval[2]! };
    const feedback = /^feedback\s+([a-zA-Z0-9_-]{1,100})\s+([\s\S]+?)\s*\|\s*([\s\S]+)$/.exec(args);
    if (feedback?.[2]?.trim() && feedback[3]?.trim()) return { name: 'career', action: 'feedback', resumeId: feedback[1]!, summary: feedback[2].trim(), weakPoint: feedback[3].trim() };
    const review = /^review\s+([a-zA-Z0-9_-]{1,100})\s+([0-5])$/.exec(args);
    if (review) return { name: 'career', action: 'review', learningId: review[1]!, score: Number(review[2]) };
    return undefined;
  }
  const memoryMatch = MEMORY_RE.exec(value);
  if (memoryMatch) {
    const args = memoryMatch[1]?.trim().split(/\s+/, 3) ?? [];
    const action = args[0] || 'review';
    if (action === 'extract' || action === 'spaces') {
      return args.length === 1 ? { name: 'memory', action } : undefined;
    }
    if (action === 'scope') {
      return args.length === 2 && (args[1] === 'all' || MEMORY_ID_RE.test(args[1] ?? ''))
        ? { name: 'memory', action, spaceId: args[1] as string }
        : undefined;
    }
    const spaceCreate = /^space\s+create\s+([\s\S]+)$/.exec(memoryMatch[1] ?? '');
    if (spaceCreate?.[1]?.trim()) return { name: 'memory', action: 'space-create', nameText: spaceCreate[1].trim() };
    const spaceRename = /^space\s+rename\s+([a-zA-Z0-9_-]{1,100})\s+([\s\S]+)$/.exec(memoryMatch[1] ?? '');
    if (spaceRename?.[2]?.trim()) return { name: 'memory', action: 'space-rename', spaceId: spaceRename[1]!, nameText: spaceRename[2].trim() };
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
