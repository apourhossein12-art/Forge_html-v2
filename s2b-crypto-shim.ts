const c: any = (globalThis as any).crypto;
export const randomUUID = () => c.randomUUID();
export const randomBytes = (n: number) => {
  const u: any = c.getRandomValues(new Uint8Array(n));
  u.toString = (e?: string) => e === 'hex' ? Array.from(u as Uint8Array).map(x => x.toString(16).padStart(2, '0')).join('') : e === 'base64' ? btoa(String.fromCharCode(...(u as Uint8Array))) : Array.from(u as Uint8Array).join(',');
  return u;
};
export const randomInt = (a: number, b?: number) => { const [lo, hi] = b === undefined ? [0, a] : [a, b]; return lo + Math.floor(Math.random() * (hi - lo)); };
export const webcrypto = c;
export default { randomUUID, randomBytes, randomInt, webcrypto };
