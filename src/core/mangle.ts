const MANGLE_MAX = 200;

export function mangleHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return h;
}

export function mangle(absolutePath: string): string {
  const replaced = absolutePath.replace(/[^a-zA-Z0-9]/g, '-');
  if (replaced.length <= MANGLE_MAX) return replaced;

  return `${replaced.slice(0, MANGLE_MAX)}-${Math.abs(mangleHash(absolutePath)).toString(36)}`;
}

export function collides(a: string, b: string): boolean {
  return a !== b && mangle(a) === mangle(b);
}
