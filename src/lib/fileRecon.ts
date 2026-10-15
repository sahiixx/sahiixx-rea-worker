export type FileType = 'PE' | 'ELF' | 'WASM' | 'ZIP_APK' | 'DEX' | 'JS' | 'UNKNOWN';
export interface FileRecon { magic: string; type: FileType; size: number; sha256: string; entropy: { overall: number; blocks: { offset: number; entropy: number; suspicious: boolean }[] }; headers: Record<string, any>; timestamp: string; }
export async function detectMagic(bytes: Uint8Array): Promise<{ type: FileType; magic: string; headers: any }> {
  const hex = Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const e_lfanew = bytes[0x3c] | (bytes[0x3d] << 8) | (bytes[0x3e] << 16) | (bytes[0x3f] << 24);
    return { type: 'PE', magic: `MZ PE32+ e_lfanew=0x${e_lfanew.toString(16)}`, headers: { e_lfanew, dos_magic: 'MZ', pe_offset: e_lfanew } };
  }
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    const arch = bytes[4] === 1 ? '32-bit' : '64-bit'; const endian = bytes[5] === 1 ? 'LE' : 'BE';
    return { type: 'ELF', magic: `ELF ${arch} ${endian}`, headers: { class: arch, endian } };
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
    return { type: 'WASM', magic: 'WASM 00 61 73 6D', headers: { version: bytes[4] | (bytes[5]<<8) | (bytes[6]<<16) | (bytes[7]<<24) } };
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const isApk = bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07;
    return { type: 'ZIP_APK', magic: isApk ? 'PK ZIP/APK' : 'PK ZIP', headers: { isApk } };
  }
  if (bytes[0] === 0x64 && bytes[1] === 0x65 && bytes[2] === 0x78 && bytes[3] === 0x0a) {
    return { type: 'DEX', magic: 'DEX 035', headers: { dex: true } };
  }
  const text = new TextDecoder().decode(bytes.slice(0, 1000));
  if (text.includes('import ') || text.includes('export ') || text.includes('function') || text.includes('=>')) {
    return { type: 'JS', magic: 'JS/TS Bundle', headers: { text: true } };
  }
  return { type: 'UNKNOWN', magic: hex, headers: {} };
}
export function calculateEntropy(bytes: Uint8Array, blockSize = 1024) {
  const blocks: { offset: number; entropy: number; suspicious: boolean }[] = [];
  let totalEntropy = 0;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    const block = bytes.slice(offset, offset + blockSize);
    const freq = new Array(256).fill(0);
    for (const b of block) freq[b]++;
    let entropy = 0;
    for (let i = 0; i < 256; i++) { if (freq[i] === 0) continue; const p = freq[i] / block.length; entropy -= p * Math.log2(p); }
    const suspicious = entropy > 7.2;
    blocks.push({ offset, entropy: Math.round(entropy * 100) / 100, suspicious });
    totalEntropy += entropy * block.length;
  }
  const overall = bytes.length > 0 ? Math.round((totalEntropy / bytes.length) * 100) / 100 : 0;
  return { overall, blocks };
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
