/**
 * 消息幂等去重器与消息定向响应判断
 * 专门防止飞书开放平台 At-least-once 重推造成的重复执行与无限重试
 */

export interface DeduplicatorOptions {
  maxSize?: number;
  ttlMs?: number;
}

interface RecordEntry {
  status: 'processing' | 'completed';
  timestamp: number;
}

export class MessageDeduplicator {
  private readonly records = new Map<string, RecordEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options: DeduplicatorOptions = {}) {
    this.maxSize = options.maxSize ?? 5_000;
    this.ttlMs = options.ttlMs ?? 2 * 60 * 60 * 1000; // 默认保留 2 小时
  }

  get size(): number {
    this.cleanupExpired();
    return this.records.size;
  }

  /**
   * 尝试获取消息处理权
   * @returns true: 首次进入，已标记为 processing；false: 已在处理或已完成，必须拦截
   */
  acquire(messageId: string): boolean {
    if (!messageId) return true;
    this.cleanupExpired();

    const existing = this.records.get(messageId);
    if (existing) {
      return false;
    }

    // LRU 淘汰：超过上限时移除最旧的一条
    if (this.records.size >= this.maxSize) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey) {
        this.records.delete(oldestKey);
      }
    }

    this.records.set(messageId, {
      status: 'processing',
      timestamp: Date.now(),
    });
    return true;
  }

  /**
   * 标记该消息已处理完成
   */
  complete(messageId: string): void {
    if (!messageId) return;
    const entry = this.records.get(messageId);
    if (entry) {
      entry.status = 'completed';
      entry.timestamp = Date.now();
    } else {
      this.records.set(messageId, {
        status: 'completed',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * 释放该消息状态（允许重试）
   */
  release(messageId: string): void {
    if (!messageId) return;
    this.records.delete(messageId);
  }

  /**
   * 检查消息是否存在且未过期
   */
  has(messageId: string): boolean {
    if (!messageId) return false;
    this.cleanupExpired();
    return this.records.has(messageId);
  }

  clear(): void {
    this.records.clear();
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.records) {
      if (now - entry.timestamp > this.ttlMs) {
        this.records.delete(id);
      } else {
        // Map 保持插入顺序，最早过期的在最前面；遇到第一个未过期的即可提前停止
        break;
      }
    }
  }
}

/**
 * 判断当前 Bot 是否应该处理该消息
 * @param msg 消息对象
 * @param botOpenId 当前 Bot 自身的 openId
 */
export function shouldBotProcessMessage(
  msg: { chatType: string; mentions?: Array<{ openId: string }> },
  botOpenId: string,
): boolean {
  // 私聊消息无条件受理
  if (msg.chatType === 'p2p') {
    return true;
  }

  // 群聊消息必须包含对本 Bot 的 @
  if (msg.chatType === 'group') {
    if (!botOpenId) return true; // 未获取到 identity 时兜底放行
    const mentions = msg.mentions ?? [];
    return mentions.some((mention) => mention.openId === botOpenId);
  }

  return true;
}
