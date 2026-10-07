import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/** 去掉 WSL 的 \\wsl.localhost\<distro> / \\wsl$\<distro> 前缀。 */
export function cleanWslPath(input: string): string {
  let p = input.trim().replaceAll('\\', '/');
  p = p.replace(/^(\/\/|\/)?(wsl\.localhost|wsl\$)\/[^/]+(?=\/)/i, '');
  return p;
}

export function resolveWorkspacePath(
  input: string,
  baseDirectory = process.cwd(),
): string {
  const value = cleanWslPath(input);
  if (!value) throw new Error('工作目录不能为空');
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}

export async function ensureWorkspaceDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`工作目录不存在: ${path}`);
  }
  if (!info.isDirectory()) throw new Error(`工作目录不是文件夹: ${path}`);
}
