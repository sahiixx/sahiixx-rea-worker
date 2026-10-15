export interface Evidence { type: string; offset: number; bytes?: string; value: string; confidence: number; limitations?: string; references?: string[]; }
export interface AnalysisResult { id: string; fileName: string; fileType: string; fileSize: number; sha256: string; timestamp: string; recon: any; strings: any[]; functions: any[]; imports: string[]; evidence: Evidence[]; unknowns: string[]; rebuild: any; confidence: any; }
export function buildEvidenceChain(result: any): Evidence[] {
  const chain: Evidence[] = [];
  chain.push({ type: 'header', offset: 0, value: `Magic: ${result.recon.magic} at 0x0`, confidence: 1.0, references: ['fileRecon.ts:detectMagic'] });
  for (const s of result.strings.slice(0, 20)) {
    chain.push({ type: 'string', offset: s.offset, value: `${s.encoding} "${s.value.slice(0, 50)}" at 0x${s.offset.toString(16)}`, confidence: s.confidence, limitations: s.categories.length === 0 ? 'Generic string' : undefined, references: s.categories });
  }
  const suspicious = result.recon.entropy.blocks.filter((b: any) => b.suspicious);
  if (suspicious.length > 0) chain.push({ type: 'entropy', offset: suspicious[0].offset, value: `High entropy ${suspicious[0].entropy} at 0x${suspicious[0].offset.toString(16)} - encrypted/packed`, confidence: 0.85, limitations: 'Entropy alone not proof' });
  return chain;
}
