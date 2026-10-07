import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export const PERSONAL_SKILLS = [
  {
    id: 'career-interview',
    version: 1,
    name: '求职与项目面试',
    description: '基于真实简历和项目事实做项目深挖、模拟面试、追问和薄弱点总结。',
    triggers: ['简历', '求职', '实习', '面试', '模拟面试', '项目复习', '项目深挖'],
    guidance: [
      '先围绕用户实际简历主张和项目记录提问，采用一次一问、逐层追问的面试方式。',
      '区分已确认事实、资料支持、用户评价和待核实推断；缺乏证据时追问或标注缺口，不补造贡献、指标或责任范围。',
      '结束时简要列出答得好的部分、具体薄弱点和建议复习问题。普通知识考点可调用 save_memory；面试表现与薄弱点只能在用户明确要求保存或明确同意后调用 save_career_interview_feedback。保存时只传真实对话中出现的反馈；它会成为待复习的 practice-feedback 学习记录，绝不是已确认项目事实或简历证据。即使当前没有已批准简历，也可以保存为未绑定简历版本的练习反馈；如果有当前简历则自动绑定。未获同意时先询问，不要调用保存工具。',
    ],
  },
  {
    id: 'reading-notes',
    version: 1,
    name: '阅读与读书记录',
    description: '整理阅读材料、作者观点和用户自己的理解、赞同或反对。',
    triggers: ['读书', '阅读', '读后感', '书摘', '作者观点', '读了', '这本书'],
    guidance: [
      '将作者观点与用户的评论、立场分开表达；引用材料不等于用户认同。',
      '优先保留标题、作者或来源定位、核心观点、个人理解和仍有疑问的内容。',
      '用户只是随手分享时先做可检索记录，不自动升级成长期偏好或确定人生观点。',
    ],
  },
  {
    id: 'research-writing',
    version: 1,
    name: 'AI 技术探索与博客',
    description: '从问题、个人立场和可核验材料开始，产出有来源的探索笔记、文章大纲或草稿。',
    triggers: ['博客', '写文章', '技术探索', '调研', '新技术', 'agent', '大模型', 'AI 技术'],
    guidance: [
      '先明确要回答的问题和用户当前立场，再列证据、来源、缺口和待验证假设。',
      '把可观察实验结果、外部作者观点、用户自己的主张和助手建议分别标注。',
      '关联用户记忆时给出来源与关联理由；无有意义关联时明确说没有，不硬凑。',
      '默认输出可撤回的大纲或草稿；私人、雇主或账号敏感内容未经逐项授权不进入公开稿。',
    ],
  },
  {
    id: 'daily-records',
    version: 1,
    name: '日常记录与回顾',
    description: '低打扰地记录生活事件，并按用户指定范围进行有来源的回顾。',
    triggers: ['日常记录', '今天做了', '今天吃了', '午饭', '锻炼', '健身', '本周回顾', '这周总结'],
    guidance: [
      '先准确保存带日期的事件，不把单次饮食、运动或心情推断成长久偏好。',
      '用户要回顾时调用 search_daily_records 限定指定日期范围与当前授权空间；只总结返回的记录并标注来源 ID，回顾本身不写入长期记忆。',
      '提醒是一项独立任务；仅记住日期或事件不代表已经创建提醒，未实际创建时如实说明。',
      '删除记录时先从当前授权范围内检索并锁定一条记录；仅在用户原始消息明确要求删除时调用 delete_daily_record，传入精确 ID。删除一条后说明已清除正文/观点，关联提醒仍保留。',
    ],
  },
] as const;

export type PersonalSkillId = (typeof PERSONAL_SKILLS)[number]['id'];
export interface PersonalSkillState { enabled: PersonalSkillId[] }

const StateSchema = z.object({ enabled: z.array(z.enum(PERSONAL_SKILLS.map((skill) => skill.id) as [PersonalSkillId, ...PersonalSkillId[]])).default([]) }).strict();

export class JsonPersonalSkillRegistry {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async list(): Promise<Array<(typeof PERSONAL_SKILLS)[number] & { enabled: boolean }>> {
    const state = await this.read();
    return PERSONAL_SKILLS.map((skill) => ({ ...skill, enabled: state.enabled.includes(skill.id) }));
  }

  async isEnabled(id: PersonalSkillId): Promise<boolean> {
    return (await this.read()).enabled.includes(id);
  }

  async isSelectedFor(id: PersonalSkillId, input: string): Promise<boolean> {
    const skill = PERSONAL_SKILLS.find((candidate) => candidate.id === id);
    if (!skill || !(await this.isEnabled(id))) return false;
    const normalized = input.normalize('NFKC').toLocaleLowerCase();
    return skill.triggers.some((trigger) => normalized.includes(trigger.toLocaleLowerCase()));
  }

  async enable(id: string): Promise<boolean> {
    return this.mutate((state) => {
      if (!isSkillId(id)) return false;
      if (!state.enabled.includes(id)) state.enabled.push(id);
      return true;
    });
  }

  async disable(id: string): Promise<boolean> {
    return this.mutate((state) => {
      if (!isSkillId(id)) return false;
      state.enabled = state.enabled.filter((item) => item !== id);
      return true;
    });
  }

  async selectionFor(input: string): Promise<{
    prompt: string;
    versions: Array<{ id: PersonalSkillId; version: number }>;
  }> {
    const normalized = input.normalize('NFKC').toLocaleLowerCase();
    const enabled = new Set((await this.read()).enabled);
    const selected = PERSONAL_SKILLS.filter((skill) =>
      enabled.has(skill.id) && skill.triggers.some((trigger) => normalized.includes(trigger.toLocaleLowerCase())),
    );
    return {
      prompt: selected.length ? [
        '【本次个人能力包】这些能力包只提供做事方法，不增加工具、权限或记忆空间访问范围。',
        ...selected.map((skill) => `- ${skill.name}：${skill.guidance.join(' ')}`),
      ].join('\n') : '',
      versions: selected.map(({ id, version }) => ({ id, version })),
    };
  }

  async promptFor(input: string): Promise<string> {
    return (await this.selectionFor(input)).prompt;
  }

  private async read(): Promise<PersonalSkillState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: [] };
      throw error;
    }
    const parsed = StateSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) throw new Error(`个人技能配置损坏，拒绝覆盖：${this.filePath}`);
    return { enabled: [...new Set(parsed.data.enabled)] };
  }

  private mutate<T>(operation: (state: PersonalSkillState) => T): Promise<T> {
    const pending = this.queue.then(async () => {
      const state = await this.read();
      const result = operation(state);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      const handle = await open(temporary, 'w', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.filePath);
      return result;
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }
}

function isSkillId(value: string): value is PersonalSkillId {
  return PERSONAL_SKILLS.some((skill) => skill.id === value);
}
