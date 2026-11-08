declare module 'httpntlm' {
  export function get(opts: {
    url: string; username: string; password: string;
    domain?: string; workstation?: string;
    rejectUnauthorized?: boolean; [key: string]: unknown;
  }, callback: (err: Error | null, res: {
    statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer;
  }) => void): void;
  export function post(opts: unknown, callback: (err: Error | null, res: unknown) => void): void;
  export const method: string;
}
