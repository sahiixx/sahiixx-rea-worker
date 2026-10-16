export interface Evidence { type: string; offset: number; bytes?: string; value: string; confidence: number; limitations?: string; references?: string[]; }
export interface AnalysisResult { id: string; fileName: string; fileType: string; fileSize: number; sha256: string; timestamp: string; recon: any; strings: any[]; functions: any[]; imports: string[]; evidence: Evidence[]; }
export function buildEvidenceChain(result: any): Evidence[] {
  const chain: Evidence[] = [];
  chain.push({ type: 'header', offset: 0, value: `Magic: ${result.recon.magic} at 0x0`, confidence: 1.0, references: ['fileRecon.ts:detectMagic'] });
  const strs = result.strings || [];
  for (const s of strs.slice(0, 50)) {
    const val = typeof s.value === 'string' ? s.value : String(s.value);
    chain.push({ type: 'string', offset: s.offset || 0, value: `${s.encoding || 'ASCII'} "${val.length>50?val.slice(0,50):val}" at 0x${(s.offset||0).toString(16)}`, confidence: s.confidence || 0.6, limitations: s.categories && s.categories.length===0 ? 'uncategorized' : undefined, references: s.categories || [] });
  }
  const suspicious = (result.recon && result.recon.entropy && result.recon.entropy.blocks) ? result.recon.entropy.blocks.filter((b: any) => b.suspicious) : [];
  if (suspicious.length > 0) chain.push({ type: 'entropy', offset: suspicious[0].offset, value: `High entropy ${suspicious[0].entropy} at 0x${suspicious[0].offset.toString(16)} - encrypted/packed`, confidence: 0.9, references: ['fileRecon.ts:calculateEntropy'] });
  return chain;
}
